import { toMetricWindow, type MetricWindow } from "@sr/shared";

/* How often a panel re-reads. Pure, so the rules are tested without a
 * browser; `useApi` hands the result to SWR. */

const POLL_MS: Record<MetricWindow, number> = {
  "5m": 15_000,
  "15m": 15_000,
  "30m": 15_000,
  "1h": 15_000,
  "3h": 60_000,
  "6h": 60_000,
  "12h": 60_000,
  "1d": 300_000,
  "3d": 300_000,
  "7d": 900_000,
  "14d": 900_000,
  "21d": 900_000,
  "30d": 900_000,
};

/**
 * How often a panel over `win` re-reads. Chart steps grow with the window and
 * from 3h the api reads recorded series that move once a minute, so a faster
 * poll fetches the same answer again: from 30m up, a poll slides the window
 * by under 1% of its length. Never slower than the window's chart step.
 */
export function pollMsFor(win: MetricWindow): number {
  return POLL_MS[win];
}

const METRICS_KEY = /^\/api\/metrics\//;

/**
 * The interval a key polls at. A metrics read over a window
 * (`/api/metrics/…?window=`) polls no faster than that window's cadence; any
 * other key at the caller's interval. 0 (never) stays 0, and a window the api
 * doesn't know reads as the api reads it: the default.
 */
export function pollMsForKey(key: string, ms: number): number {
  if (ms <= 0 || !METRICS_KEY.test(key)) return ms;
  const q = key.indexOf("?");
  const win = q < 0 ? null : new URLSearchParams(key.slice(q + 1)).get("window");
  return win === null ? ms : Math.max(ms, pollMsFor(toMetricWindow(win)));
}
