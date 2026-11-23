import type { AskRunRow } from "@sr/db";
import type { AskSettings } from "../../config.js";
import { AskStore } from "./store.js";
import { AskOrchestrator, type AskExecutionHooks } from "./orchestrator.js";
import { AskFailure } from "./errors.js";
import { McpPool } from "./mcp.js";

export interface AskWorkerOptions {
  hooks: (run: AskRunRow) => AskExecutionHooks;
  /** Idempotent reconciliation may also account for a late result after a run
   * was fenced. It must never blindly free dispatched/uncertain reservations. */
  afterTerminal: (runId?: string) => Promise<void>;
  enabled?: () => boolean;
  canClaim?: () => boolean;
  timing?: (runId: string, phase: string, durationMs: number) => void;
  fetchImpl?: typeof fetch;
  /** `error`, when given, is logged by its class and code only. */
  onError?: (code: string, error?: unknown) => void;
}

/** The fewest milliseconds between two draft writes of one run. */
const DRAFT_INTERVAL_MS = 500;

/** Writes a run's newest draft, at most once per interval and never two at
 * once; text published meanwhile replaces the text waiting. After `close`
 * nothing more is written, so no draft lands after the run's terminal write. */
export class DraftWriter {
  private latest: string | null = null;
  private written: string | null = null;
  private flight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(
    private readonly write: (text: string) => Promise<void>,
    private readonly intervalMs: number,
  ) {}

  publish(text: string): void {
    if (this.closed) return;
    this.latest = text;
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.flight || this.timer || this.latest === this.written) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.flush();
      },
      Math.max(0, this.last + this.intervalMs - Date.now()),
    );
    this.timer.unref();
  }

  private flush(): void {
    if (this.closed || this.latest === null || this.latest === this.written) return;
    const text = this.latest;
    this.last = Date.now();
    this.flight = this.write(text)
      .then(() => {
        this.written = text;
      })
      .finally(() => {
        this.flight = null;
        this.schedule();
      });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flight;
  }
}

/** PostgreSQL owns queue/leases. These process-local maps only bound this
 * replica's concurrency and propagate cancellation to its own requests. */
export class AskWorker {
  private readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private again = false;
  private stopped = false;
  private idle: Promise<void> = Promise.resolve();
  private readonly mcp: McpPool;
  constructor(
    private readonly store: AskStore,
    private readonly settings: AskSettings,
    private readonly options: AskWorkerOptions,
  ) {
    this.mcp = new McpPool(settings, options.fetchImpl);
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.wake(), this.settings.workerPollMs);
    this.timer.unref();
    this.wake();
  }

  /** Claims now rather than at the next poll: the replica that saved a run
   * calls this, and other replicas still find it by polling. A wake during a
   * tick runs one more tick when that one ends, so a run saved meanwhile is
   * not left for the poll. */
  wake(): void {
    if (this.stopped) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    void this.tick().catch(() => this.options.onError?.("ASK_WORKER_UNAVAILABLE"));
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.again = false;
    let becameIdle!: () => void;
    this.idle = new Promise((resolve) => {
      becameIdle = resolve;
    });
    try {
      if (!(this.options.enabled?.() ?? this.settings.enabled)) {
        await this.store.recover(this.settings.runTimeoutMs);
        await this.options.afterTerminal();
        for (const job of this.jobs.values())
          job.controller.abort(new AskFailure("ASK_INTERRUPTED"));
        await this.store.interruptQueued();
        await this.options.afterTerminal();
        return;
      }
      // Claim before maintenance: a claim needs nothing recovery or
      // reconciliation does, and a waiting question should not wait on them.
      const canClaim = () => !this.options.canClaim || this.options.canClaim();
      while (!this.stopped && canClaim() && this.jobs.size < this.settings.workerConcurrency) {
        const run = await this.store.claim(this.settings.leaseMs, this.settings.runTimeoutMs);
        if (!run) break;
        if (this.stopped || !(this.options.enabled?.() ?? this.settings.enabled)) {
          await this.store.fail(run.id, run.leaseToken!, "ASK_INTERRUPTED");
          await this.options.afterTerminal(run.id);
          break;
        }
        const controller = new AbortController();
        this.options.timing?.(run.id, "queue", Math.max(0, Date.now() - run.createdAt.getTime()));
        const done = this.execute(run, controller).finally(() => this.jobs.delete(run.id));
        this.jobs.set(run.id, { controller, done });
      }
      await this.store.recover(this.settings.runTimeoutMs);
      await this.options.afterTerminal();
    } finally {
      this.busy = false;
      becameIdle();
      if (this.again && !this.stopped) this.wake();
    }
  }

  private async execute(run: AskRunRow, controller: AbortController): Promise<void> {
    let checking: Promise<void> | null = null;
    const check = (): Promise<void> => {
      if (controller.signal.aborted) return Promise.resolve();
      if (checking) return checking;
      checking = (async () => {
        try {
          if (!(this.options.enabled?.() ?? this.settings.enabled)) {
            controller.abort(new AskFailure("ASK_INTERRUPTED"));
            return;
          }
          const state = await this.store.renew(run.id, run.leaseToken!, this.settings.leaseMs);
          if (state === "cancelling") controller.abort(new AskFailure("ASK_CANCELLED", 409));
          else if (state === "lost") {
            this.options.onError?.("ASK_LEASE_LOST");
            controller.abort(new AskFailure("ASK_INTERRUPTED"));
          }
        } catch (error) {
          this.options.onError?.("ASK_LEASE_CHECK_FAILED", error);
          controller.abort(new AskFailure("ASK_INTERRUPTED"));
        } finally {
          checking = null;
        }
      })();
      return checking;
    };
    let draftFailed = false;
    const drafts = new DraftWriter(async (text) => {
      try {
        await this.store.saveDraft(run.id, run.leaseToken!, text);
      } catch (error) {
        if (!draftFailed) this.options.onError?.("ASK_DRAFT_WRITE_FAILED", error);
        draftFailed = true;
      }
    }, DRAFT_INTERVAL_MS);
    const heartbeat = setInterval(() => {
      void check();
    }, this.settings.heartbeatMs);
    heartbeat.unref();
    // A terminal write clears the lease token, so a check running beside it
    // reads its own run's completion as a lost lease. Each write waits for
    // the check in flight and starts no other.
    const quiesce = async (): Promise<void> => {
      clearInterval(heartbeat);
      await drafts.close();
      await checking;
    };
    const deadline = setTimeout(
      () => {
        this.options.onError?.("ASK_DEADLINE_EXCEEDED");
        controller.abort(new AskFailure("ASK_TIMEOUT"));
      },
      Math.max(1, this.settings.runTimeoutMs - (Date.now() - run.createdAt.getTime())),
    );
    deadline.unref();
    try {
      // The first lease check and the history read go together; nothing
      // external starts until the check has passed.
      const [, history] = await Promise.all([check(), this.store.history(run)]);
      if (controller.signal.aborted) throw controller.signal.reason;
      const supplied = this.options.hooks(run);
      const hooks: AskExecutionHooks = {
        ...supplied,
        timing: (phase, durationMs) => this.options.timing?.(run.id, phase, durationMs),
        draft: (text) => drafts.publish(text),
        checkActive: async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (!(this.options.enabled?.() ?? this.settings.enabled))
            throw new AskFailure("ASK_INTERRUPTED");
          await supplied.checkActive();
        },
      };
      const result = await new AskOrchestrator(
        this.settings,
        this.options.fetchImpl,
        this.mcp,
      ).answer(
        run,
        history.filter((message) => message.runId !== run.id),
        hooks,
        controller.signal,
      );
      // `succeed` publishes only under a current lease, a running status and
      // a live session, and the branch below handles each refusal; this
      // replica's own switch is checked here.
      await quiesce();
      if (!(this.options.enabled?.() ?? this.settings.enabled))
        controller.abort(new AskFailure("ASK_INTERRUPTED"));
      if (controller.signal.aborted) throw controller.signal.reason;
      const persisting = performance.now();
      if (!(await this.store.succeed(run.id, run.leaseToken!, result, run))) {
        const state = await this.store.leaseState(run.id, run.leaseToken!);
        if (state === "cancelling") await this.store.fail(run.id, run.leaseToken!, "ASK_CANCELLED");
        else {
          this.options.onError?.("ASK_LEASE_LOST");
          await this.store.recover(this.settings.runTimeoutMs);
        }
      }
      this.options.timing?.(run.id, "persistence", performance.now() - persisting);
    } catch (error) {
      const failure =
        controller.signal.reason instanceof AskFailure
          ? controller.signal.reason
          : error instanceof AskFailure
            ? error
            : new AskFailure("ASK_UNAVAILABLE");
      await quiesce();
      await this.store
        .fail(run.id, run.leaseToken!, failure.code)
        .catch(() => this.options.onError?.("ASK_TERMINAL_PERSIST_FAILED"));
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      await drafts.close();
      await this.options
        .afterTerminal(run.id)
        .catch(() => this.options.onError?.("ASK_USAGE_RECONCILIATION_FAILED"));
    }
  }

  /** Claims nothing more, gives running answers up to `drainMs` to finish,
   * then interrupts the rest, ending their leases. */
  async stop(drainMs = 0): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.drain(drainMs);
    } finally {
      await this.mcp.close();
    }
  }

  private async drain(drainMs: number): Promise<void> {
    await this.idle;
    const settled = () => Promise.allSettled([...this.jobs.values()].map((job) => job.done));
    if (drainMs > 0 && this.jobs.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        settled(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, drainMs);
        }),
      ]);
      clearTimeout(timer);
    }
    for (const job of this.jobs.values()) job.controller.abort(new AskFailure("ASK_INTERRUPTED"));
    await settled();
  }

  async drained(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((job) => job.done));
  }
}
