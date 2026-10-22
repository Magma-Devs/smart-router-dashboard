/**
 * The time range a read of the router's logs covers - shared by the two lists
 * that read them (the Errors tab's requests and the Transactions tab). The
 * page's window back from now by default; an exact from-to when the caller
 * picks one, which Prometheus-backed panels can't follow but a log read can.
 */
import { DEFAULT_WINDOW, WINDOWS, toMetricWindow, type MetricWindow } from "@sr/shared";
import type { LokiClient } from "./loki-client.js";

/** Unix ms. */
export interface ReadRange {
  startMs: number;
  endMs: number;
}

/** The page window each range `windowRange` made follows. */
const windows = new WeakMap<ReadRange, MetricWindow>();

export function windowRange(window: MetricWindow, now = Date.now()): ReadRange {
  const range = { startMs: now - WINDOWS[window].rangeSeconds * 1000, endMs: now };
  windows.set(range, window);
  return range;
}

/**
 * The page window a range was made for: it ends now and moves with the
 * clock, so its reads are kept by the window rather than by their times.
 * Undefined for exact times.
 */
export const liveWindow = (range: ReadRange): MetricWindow | undefined => windows.get(range);

/** The longest exact range a read may ask for - the widest page window. */
const MAX_RANGE_MS = WINDOWS["30d"].rangeSeconds * 1000;

export interface RangeQuery {
  window?: string;
  from?: number;
  to?: number;
  before?: number;
}

/**
 * `from`-`to` when given, never past now; the page's window otherwise. A pair
 * that can't be read is an error for the route to answer with a 400: a quiet
 * fall-back would list another range under the times someone picked.
 */
export function readRange(q: RangeQuery, now = Date.now()): ReadRange | { error: string } {
  const { from, to } = q;
  if (from == null && to == null) return windowRange(toMetricWindow(q.window), now);
  if (from == null || to == null) return { error: "from and to go together" };
  if (!(from < to)) return { error: "from must be before to" };
  if (from >= now) return { error: "from must be in the past" };
  if (to - from > MAX_RANGE_MS) return { error: "a range is at most 30 days" };
  return { startMs: from, endMs: Math.min(to, now) };
}

/** Where a read ends: the range's end, or `before` (the previous read's `nextBefore`) when that's earlier. */
export const readEnd = (range: ReadRange, before?: number) =>
  before != null ? Math.min(range.endMs, before) : range.endMs;

/**
 * The most log one read may scan, in bytes as Loki's index counts them: about
 * half an hour of the busiest tenant's router lines (production, 2026-10-20: 6.7 GB
 * an hour, 1.6 TB a month), so the default half hour reads whole on every
 * tenant at its usual volume.
 * A line filter doesn't lower it - a read opens every chunk of the streams it
 * selects, matches or not - and a read with few matches can't stop early.
 * A 14-day read that ignored it pinned the shared Loki at 97 % CPU for five
 * minutes and timed out every tenant's alert rules (2026-10-20).
 */
export const LOG_READ_BUDGET_BYTES = 4e9;

/** What a read covers when Loki can't say what the stretch weighs. */
export const UNSIZED_READ_SPAN_MS = 30 * 60_000;

/** The shortest stretch a read covers, however heavy. */
const MIN_READ_SPAN_MS = 60_000;

/** How many times a read's part is re-weighed before it is read. */
const SIZING_ROUNDS = 3;

/**
 * Where a read ending at `endMs` starts: the range's start when the stretch
 * between fits the budget, else the newest part that does. The part is sized
 * from the stretch's weight as if spread evenly, then weighed again and cut
 * again: traffic grows, and a month's average is a third of the largest
 * tenant's current hour. Older lines are the next read's (`readOnFrom` takes
 * the start as a cut), so a long window costs one budget per "Load older",
 * not all of it at once.
 */
export async function readStart(
  loki: LokiClient,
  selector: string,
  range: ReadRange,
  endMs: number,
  budget = LOG_READ_BUDGET_BYTES,
): Promise<number> {
  let startMs = range.startMs;
  for (let round = 0; round < SIZING_ROUNDS; round++) {
    const spanMs = endMs - startMs;
    if (spanMs <= MIN_READ_SPAN_MS) return startMs;
    const bytes = await loki.volume(selector, startMs, endMs);
    if (bytes === null) return Math.max(startMs, endMs - UNSIZED_READ_SPAN_MS);
    if (bytes <= budget) return startMs;
    startMs = Math.max(startMs, endMs - Math.max(MIN_READ_SPAN_MS, (spanMs * budget) / bytes));
  }
  return startMs;
}

/** Past a line's time, still before the next line: `tsMs` carries ~0.25 µs of float error. */
const SEAM_MS = 0.001;

/**
 * Where the next, older read ends; null when this one holds everything.
 * `newestFirst` is every request found, by its newest line; the first `cap`
 * are kept. `cuts` are the oldest times of reads that hit their line limit.
 * Every request not kept has its newest line at or before the returned time,
 * which the next read includes, so nothing between two reads is skipped.
 */
export function readOnFrom(newestFirst: [string, number][], cap: number, cuts: number[], endMs: number): number | null {
  const bounds = [...cuts];
  if (newestFirst.length > cap) bounds.push(newestFirst[cap]![1]);
  if (!bounds.length) return null;
  const at = Math.max(...bounds) + SEAM_MS;
  // The next read must end earlier than this one, or paging would stand still.
  return at < endMs ? at : endMs - SEAM_MS;
}

/** The querystring every log read takes, for a route's schema. */
export const RANGE_QUERY_PROPERTIES = {
  window: {
    type: "string" as const,
    enum: [...Object.keys(WINDOWS), "24h"],
    description: `Time window back from now (default ${DEFAULT_WINDOW}; 24h is an alias of 1d). Ignored when from and to are given`,
  },
  from: { type: "integer" as const, minimum: 0, description: "Exact range start, unix ms, in the past (with `to`; at most 30 days; 400 otherwise)" },
  to: { type: "integer" as const, minimum: 0, description: "Exact range end, unix ms (with `from`)" },
  before: { type: "number" as const, minimum: 0, description: "Read on from here, unix ms (a fraction is kept) - the previous read's `nextBefore`" },
};
