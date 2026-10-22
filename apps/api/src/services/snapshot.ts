/**
 * One answer per key, shared by every caller in the process: a memo with one
 * run in flight per key (single-flight) and stale-while-revalidate.
 *
 *  - Younger than its TTL, the kept answer is served.
 *  - Up to twice its TTL old, it is still served while ONE run refreshes it
 *    in the background, so no caller waits on a refresh.
 *  - Older, or never read, the caller waits for a run, and every caller that
 *    arrives before it ends shares it.
 *  - A run that throws, or one during which the store refused a read (a
 *    refused read comes back empty, not as an error: `read-health.ts`), gives
 *    no good answer. It never replaces a kept answer that is still servable,
 *    and the next run waits `retryAfterMs`. Meanwhile a caller with nothing
 *    servable gets the same error, or the degraded answer: that goes to the
 *    callers of its run and is kept no longer than the wait.
 *
 * Bounded: a new key past `maxEntries` evicts the least recently refreshed
 * one, never one with a run in flight. Per process: each replica keeps its own.
 */
import { trackReads } from "./read-health.js";

/** What a caller is served: the answer, and when the run that read it started (unix ms). */
export interface Snapshot<T> {
  value: T;
  at: number;
}

/** The slice of a pino logger the store uses. */
export interface SnapshotLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface SnapshotStoreOptions {
  /** Keys kept at most. */
  maxEntries?: number;
  /** How long a run with no good answer holds off the next one; never more than the TTL. */
  retryAfterMs?: number;
  /** Where a key is reported, once per run of failures and once per run of degraded answers. */
  logger?: SnapshotLogger;
}

/** Keys kept by default. */
export const SNAPSHOT_MAX_ENTRIES = 256;

/** How long a run with no good answer holds off the next one by default. */
export const SNAPSHOT_RETRY_AFTER_MS = 5_000;

/** The last run, when it gave no good answer: it threw, or the store refused a read it made. */
type Setback =
  | { kind: "failed"; at: number; error: unknown }
  | { kind: "degraded"; at: number; answer: Snapshot<unknown> };

interface Entry {
  /** The last good answer. */
  kept: Snapshot<unknown> | null;
  running: Promise<Snapshot<unknown>> | null;
  /** Until a run gives a good answer; the next run waits `retryAfterMs` from its `at`. */
  setback: Setback | null;
  /** The kinds of setback logged since the last good answer. */
  logged: { failed: boolean; degraded: boolean };
}

export class SnapshotStore {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly retryAfterMs: number;
  private readonly logger: SnapshotLogger | undefined;

  constructor(options: SnapshotStoreOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? SNAPSHOT_MAX_ENTRIES);
    this.retryAfterMs = options.retryAfterMs ?? SNAPSHOT_RETRY_AFTER_MS;
    this.logger = options.logger;
  }

  /** Keys held. */
  get size(): number {
    return this.entries.size;
  }

  /** The answer for `key`, kept `ttlMs`; `ttlMs` ≤ 0 runs `run` every time and keeps nothing. */
  async get<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<Snapshot<T>> {
    if (!(ttlMs > 0)) {
      const at = Date.now();
      return { value: await run(), at };
    }
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry) return this.start(key, this.add(key), run) as Promise<Snapshot<T>>;

    const { kept, setback } = entry;
    const age = kept ? now - kept.at : Infinity;
    if (kept && age < ttlMs) return kept as Snapshot<T>;
    const cooling = setback !== null && now - setback.at < Math.min(this.retryAfterMs, ttlMs);
    if (kept && age < 2 * ttlMs) {
      if (!entry.running && !cooling) this.start(key, entry, run).catch(() => undefined);
      return kept as Snapshot<T>;
    }
    if (entry.running) return entry.running as Promise<Snapshot<T>>;
    if (setback && cooling) {
      if (setback.kind === "degraded") return setback.answer as Snapshot<T>;
      throw setback.error;
    }
    return this.start(key, entry, run) as Promise<Snapshot<T>>;
  }

  /** Resolves once no run is in flight. */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.entries.values()].flatMap((e) => (e.running ? [e.running] : []));
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  /** A new key; past the cap the least recently refreshed key without a run in flight goes first. */
  private add(key: string): Entry {
    for (const [k, e] of this.entries) {
      if (this.entries.size < this.maxEntries) break;
      if (!e.running) this.entries.delete(k);
    }
    const entry: Entry = { kept: null, running: null, setback: null, logged: { failed: false, degraded: false } };
    this.entries.set(key, entry);
    return entry;
  }

  private start(key: string, entry: Entry, run: () => Promise<unknown>): Promise<Snapshot<unknown>> {
    const at = Date.now();
    const running = Promise.resolve()
      .then(() => trackReads(run))
      .then(
        ({ value, refused }) => {
          const answer = { value, at };
          if (refused > 0) {
            this.report(key, entry, "degraded", { refused });
            entry.setback = { kind: "degraded", at: Date.now(), answer };
            return answer;
          }
          entry.kept = answer;
          entry.setback = null;
          entry.logged = { failed: false, degraded: false };
          // Refreshed last, evicted last.
          this.entries.delete(key);
          this.entries.set(key, entry);
          return answer;
        },
        (error: unknown) => {
          this.report(key, entry, "failed", { err: error });
          entry.setback = { kind: "failed", at: Date.now(), error };
          throw error;
        },
      )
      .finally(() => {
        entry.running = null;
      });
    entry.running = running;
    return running;
  }

  /** The first setback of each kind since the last good answer is logged. */
  private report(key: string, entry: Entry, kind: Setback["kind"], fields: Record<string, unknown>): void {
    if (entry.logged[kind]) return;
    entry.logged[kind] = true;
    this.logger?.warn(
      { ...fields, key, keptAgeMs: entry.kept ? Date.now() - entry.kept.at : null },
      kind === "failed"
        ? "snapshot run failed; the last good answer stands in until it is twice its TTL old"
        : "the store refused a read during a snapshot run; its answer is not kept as good",
    );
  }
}
