/**
 * Which reads the store refused, per block of work. A refused read comes back
 * empty rather than as an error (the client degrades, the services fill in
 * nulls), so the code that issued it can't tell an outage from a quiet router.
 * `trackReads` runs a block in its own context and counts the refusals the
 * client notes there (`noteRefusedRead`, in `PrometheusClient.fetchOnce`).
 *
 * Only the block that issued a read counts its refusal: one that joined the
 * same read already in flight from another block is not told.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface ReadHealth {
  refused: number;
}

const current = new AsyncLocalStorage<ReadHealth>();

/** Runs `fn` in a fresh context: its answer, and how many of the reads it issued the store refused. */
export async function trackReads<T>(fn: () => Promise<T>): Promise<{ value: T; refused: number }> {
  const health: ReadHealth = { refused: 0 };
  const value = await current.run(health, fn);
  return { value, refused: health.refused };
}

/** Counts one refused read against the current context; nothing outside one. */
export function noteRefusedRead(): void {
  const health = current.getStore();
  if (health) health.refused++;
}
