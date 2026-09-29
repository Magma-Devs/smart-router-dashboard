/**
 * The time range a read of the router's logs covers - shared by the two lists
 * that read them (the Errors tab's requests and the Transactions tab). The
 * page's window back from now by default; an exact from-to when the caller
 * picks one, which Prometheus-backed panels can't follow but a log read can.
 */
import { DEFAULT_WINDOW, WINDOWS, toMetricWindow, type MetricWindow } from "@sr/shared";

/** Unix ms. */
export interface ReadRange {
  startMs: number;
  endMs: number;
}

export function windowRange(window: MetricWindow, now = Date.now()): ReadRange {
  return { startMs: now - WINDOWS[window].rangeSeconds * 1000, endMs: now };
}

/** The longest exact range a read may ask for - the widest page window. */
const MAX_RANGE_MS = WINDOWS["30d"].rangeSeconds * 1000;

export interface RangeQuery {
  window?: string;
  from?: number;
  to?: number;
  before?: number;
}

/**
 * `from`-`to` when both are given and make sense, never past now; anything
 * else is the page's window. A bad pair falls back rather than 400ing, like
 * an unknown `window` does.
 */
export function readRange(q: RangeQuery, now = Date.now()): ReadRange {
  const { from, to } = q;
  if (from != null && to != null && from < to && to - from <= MAX_RANGE_MS && from < now) {
    return { startMs: from, endMs: Math.min(to, now) };
  }
  return windowRange(toMetricWindow(q.window), now);
}

/** Where a read ends: the range's end, or `before` (the previous read's `nextBefore`) when that's earlier. */
export const readEnd = (range: ReadRange, before?: number) =>
  before != null ? Math.min(range.endMs, before) : range.endMs;

/** The querystring every log read takes, for a route's schema. */
export const RANGE_QUERY_PROPERTIES = {
  window: {
    type: "string" as const,
    enum: [...Object.keys(WINDOWS), "24h"],
    description: `Time window back from now (default ${DEFAULT_WINDOW}; 24h is an alias of 1d). Ignored when from and to are given`,
  },
  from: { type: "integer" as const, description: "Exact range start, unix ms (with `to`; at most 30 days)" },
  to: { type: "integer" as const, description: "Exact range end, unix ms (with `from`)" },
  before: { type: "number" as const, description: "Read on from here, unix ms (a fraction is kept) - the previous read's `nextBefore`" },
};
