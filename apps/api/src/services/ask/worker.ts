import type { AskRunRow } from "@sr/db";
import type { AskSettings } from "../../config.js";
import { AskStore } from "./store.js";
import { AskOrchestrator, type AskExecutionHooks } from "./orchestrator.js";
import { AskFailure } from "./errors.js";

export interface AskWorkerOptions {
  hooks: (run: AskRunRow) => AskExecutionHooks;
  /** Idempotent reconciliation may also account for a late result after a run
   * was fenced. It must never blindly free dispatched/uncertain reservations. */
  afterTerminal: (runId?: string) => Promise<void>;
  enabled?: () => boolean;
  canClaim?: () => boolean;
  timing?: (runId: string, phase: string, durationMs: number) => void;
  fetchImpl?: typeof fetch;
  onError?: (code: string) => void;
}

/** PostgreSQL owns queue/leases. These process-local maps only bound this
 * replica's concurrency and propagate cancellation to its own requests. */
export class AskWorker {
  private readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopped = false;
  private idle: Promise<void> = Promise.resolve();
  constructor(
    private readonly store: AskStore,
    private readonly settings: AskSettings,
    private readonly options: AskWorkerOptions,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    const wake = () => {
      void this.tick().catch(() => this.options.onError?.("ASK_WORKER_UNAVAILABLE"));
    };
    this.timer = setInterval(wake, this.settings.workerPollMs);
    this.timer.unref();
    wake();
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let becameIdle!: () => void;
    this.idle = new Promise((resolve) => {
      becameIdle = resolve;
    });
    try {
      await this.store.recover(this.settings.runTimeoutMs);
      await this.options.afterTerminal();
      if (!(this.options.enabled?.() ?? this.settings.enabled)) {
        for (const job of this.jobs.values())
          job.controller.abort(new AskFailure("ASK_INTERRUPTED"));
        await this.store.interruptQueued();
        await this.options.afterTerminal();
        return;
      }
      if (this.options.canClaim && !this.options.canClaim()) return;
      while (!this.stopped && this.jobs.size < this.settings.workerConcurrency) {
        const run = await this.store.claim(this.settings.leaseMs);
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
    } finally {
      this.busy = false;
      becameIdle();
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
          const state = await this.store.leaseState(run.id, run.leaseToken!);
          if (state === "cancelling") controller.abort(new AskFailure("ASK_CANCELLED", 409));
          else if (
            state === "lost" ||
            !(await this.store.heartbeat(run.id, run.leaseToken!, this.settings.leaseMs))
          ) {
            this.options.onError?.("ASK_LEASE_LOST");
            controller.abort(new AskFailure("ASK_INTERRUPTED"));
          }
        } catch {
          this.options.onError?.("ASK_LEASE_CHECK_FAILED");
          controller.abort(new AskFailure("ASK_INTERRUPTED"));
        } finally {
          checking = null;
        }
      })();
      return checking;
    };
    const heartbeat = setInterval(() => {
      void check();
    }, this.settings.heartbeatMs);
    heartbeat.unref();
    // A terminal write clears the lease token, so a check running beside it
    // reads its own run's completion as a lost lease. Each write waits for
    // the check in flight and starts no other.
    const quiesce = async (): Promise<void> => {
      clearInterval(heartbeat);
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
      await check();
      if (controller.signal.aborted) throw controller.signal.reason;
      const detail = await this.store.chatDetail(run.ownerId, run.chatId);
      const supplied = this.options.hooks(run);
      const hooks: AskExecutionHooks = {
        ...supplied,
        timing: (phase, durationMs) => this.options.timing?.(run.id, phase, durationMs),
        checkActive: async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (!(this.options.enabled?.() ?? this.settings.enabled))
            throw new AskFailure("ASK_INTERRUPTED");
          await supplied.checkActive();
        },
      };
      const result = await new AskOrchestrator(this.settings, this.options.fetchImpl).answer(
        run,
        detail.messages.filter((message) => message.runId !== run.id),
        hooks,
        controller.signal,
      );
      clearInterval(heartbeat);
      await check();
      if (controller.signal.aborted) throw controller.signal.reason;
      const persisting = performance.now();
      if (!(await this.store.succeed(run.id, run.leaseToken!, result))) {
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
      await this.options
        .afterTerminal(run.id)
        .catch(() => this.options.onError?.("ASK_USAGE_RECONCILIATION_FAILED"));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const job of this.jobs.values()) job.controller.abort(new AskFailure("ASK_INTERRUPTED"));
    await this.idle;
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
  }

  async drained(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((job) => job.done));
  }
}
