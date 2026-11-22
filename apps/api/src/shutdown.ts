import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    /** Set when a stop signal arrives; null while the api serves. The Ask
     * runtime reads its drain deadline. */
    stopping: StopState | null;
  }
}

export interface StopState {
  signal: string;
  /** Epoch ms the stop began. */
  since: number;
  /** Epoch ms by which in-flight requests and Ask runs must be done. Past it,
   * open connections are closed and running Ask runs are interrupted. */
  drainUntil: number;
}

/**
 * The part of `SHUTDOWN_TIMEOUT_MS` kept back from the drain for what follows
 * it: interrupted Ask runs writing their terminal state, and the database pool
 * ending (`plugins/db.ts` gives it 5 s).
 */
export const SHUTDOWN_CLOSE_RESERVE_MS = 8_000;

/** How often a stopping api closes keep-alive connections gone idle. */
const IDLE_SWEEP_MS = 100;

/** Milliseconds of drain left, or 0 when the app is closing without a stop
 * signal (a test's `app.close()`, a refused boot). */
export function drainRemainingMs(app: FastifyInstance, now = Date.now()): number {
  const stopping = app.hasDecorator("stopping") ? app.stopping : null;
  return stopping ? Math.max(0, stopping.drainUntil - now) : 0;
}

export interface ShutdownOptions {
  /** From the first signal to a forced exit. */
  timeoutMs: number;
  exit: (code: number) => void;
  /** Logs before the app exists; the app's logger after. */
  log?: (message: string) => void;
}

export interface Shutdown {
  /** Hands the built app over; closes it at once when a signal came first.
   * Returns false when the process is already stopping. */
  attach(app: FastifyInstance): boolean;
  /** A stop signal: the first drains and exits 0; the second exits 1. */
  signal(name: string): void;
  readonly stopping: boolean;
}

/**
 * The api's stop sequence on SIGTERM / SIGINT.
 *
 * 1. `app.stopping` is set, carrying the drain deadline.
 * 2. `app.close()`: the listener closes, so the readiness probe is refused from
 *    here on (a request on an open keep-alive connection gets Fastify's 503);
 *    `preClose` hooks run (the Ask runtime stops claiming); in-flight requests
 *    finish, keep-alive connections are closed as they go idle, and any still
 *    open at `drainUntil` are closed.
 * 3. `onClose` hooks run last-registered first: the Ask runtime waits for its
 *    runs until `drainUntil` and interrupts the rest, which releases their
 *    leases, and then the database pool ends.
 * 4. exit 0. A second signal, a failed close or `timeoutMs` exits 1.
 */
export function createShutdown(options: ShutdownOptions): Shutdown {
  const now = Date.now;
  let app: FastifyInstance | null = null;
  let state: StopState | null = null;
  let closing = false;
  let exited = false;

  const log = (message: string, level: "info" | "error" = "info") => {
    if (app) app.log[level]({ shutdown: true }, message);
    else (options.log ?? console.error)(message);
  };
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    options.exit(code);
  };

  const close = (target: FastifyInstance, stop: StopState) => {
    if (closing) return;
    closing = true;
    target.stopping = stop;
    const cut = setTimeout(
      () => {
        if (exited) return;
        log("shutdown: drain window over, closing open connections");
        target.server.closeAllConnections?.();
      },
      Math.max(0, stop.drainUntil - now()),
    );
    cut.unref();
    // The listener's close waits for every connection, and a keep-alive one
    // that finished its request stays open; closing idle ones as they appear
    // lets the close move on when the last request ends.
    const idle = setInterval(() => target.server.closeIdleConnections?.(), IDLE_SWEEP_MS);
    idle.unref();
    target.close().then(
      () => {
        clearInterval(idle);
        log(`shutdown: stopped in ${now() - stop.since} ms`);
        exit(0);
      },
      (err: unknown) => {
        clearInterval(idle);
        log(`shutdown: close failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        exit(1);
      },
    );
  };

  return {
    get stopping() {
      return state !== null;
    },
    attach(built) {
      app = built;
      if (state) close(built, state);
      return state === null;
    },
    signal(name) {
      if (state) {
        log(`shutdown: second ${name}, exiting now`, "error");
        exit(1);
        return;
      }
      const since = now();
      state = {
        signal: name,
        since,
        drainUntil: since + Math.max(0, options.timeoutMs - SHUTDOWN_CLOSE_RESERVE_MS),
      };
      log(`shutdown: ${name} received, draining until ${new Date(state.drainUntil).toISOString()}`);
      // Not unref'd: a close that hangs with nothing else pending still ends
      // in exit 1, not in the event loop running dry.
      setTimeout(() => {
        log(`shutdown: not stopped within ${options.timeoutMs} ms, exiting`, "error");
        exit(1);
      }, options.timeoutMs);
      if (app) close(app, state);
      // Before the app exists there is nothing to drain: attach() closes it.
    },
  };
}

/** Routes SIGTERM and SIGINT to `shutdown`. Returns the remover. */
export function onStopSignals(
  shutdown: Shutdown,
  source: Pick<NodeJS.Process, "on" | "off"> = process,
): () => void {
  const listeners = (["SIGTERM", "SIGINT"] as const).map((name) => {
    const listener = () => shutdown.signal(name);
    source.on(name, listener);
    return [name, listener] as const;
  });
  return () => {
    for (const [name, listener] of listeners) source.off(name, listener);
  };
}
