/**
 * One read per key on this api process. An answer is kept for as long as
 * the read that made it says, and a read in flight is shared by everyone
 * asking for the same key meanwhile: N viewers of one list cost one read of
 * the router's logs, not N. A read that throws is kept by no one.
 */
export class ReadMemo<T> {
  private readonly kept = new Map<string, { until: number; value: T }>();
  private readonly running = new Map<string, Promise<T>>();

  /** `max`: answers kept at most, the oldest dropped first. */
  constructor(private readonly max: number) {}

  /**
   * The answer kept for `key`, else the read in flight for it, else a new
   * one: `read` resolves with its answer and how long to keep it (0: not at all).
   */
  get(key: string, read: () => Promise<{ value: T; keepMs: number }>): Promise<T> {
    const hit = this.kept.get(key);
    if (hit && Date.now() < hit.until) return Promise.resolve(hit.value);
    const pending = this.running.get(key);
    if (pending) return pending;
    const next = read()
      .then(({ value, keepMs }) => {
        if (keepMs > 0) remember(this.kept, key, { until: Date.now() + keepMs, value }, this.max);
        else this.kept.delete(key);
        return value;
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, next);
    return next;
  }
}

/** Keeps at most `max` entries: setting a key makes it the newest, and the oldest goes first. */
export function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
}
