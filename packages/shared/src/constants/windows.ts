import type { ChartGrid } from "../types/domain.js";

/**
 * Time-window catalog → PromQL range string + a bucket step targeting
 * ~150–200 range points (v1's adaptive-step semantics), clamped to ≥15s
 * (the Prometheus scrape interval — finer steps just repeat samples).
 *
 * Keys mirror the design's page-level window <select> (12 options) plus
 * "1h", which the Dashboard page's chip row uses internally.
 */
export const WINDOWS = {
  "5m": { label: "5 minutes", rangeSeconds: 300, step: "15s" },
  "15m": { label: "15 minutes", rangeSeconds: 900, step: "15s" },
  "30m": { label: "30 minutes", rangeSeconds: 1800, step: "15s" },
  "1h": { label: "1 hour", rangeSeconds: 3600, step: "30s" },
  "3h": { label: "3 hours", rangeSeconds: 10800, step: "1m" },
  "6h": { label: "6 hours", rangeSeconds: 21600, step: "2m" },
  "12h": { label: "12 hours", rangeSeconds: 43200, step: "5m" },
  "1d": { label: "1 day", rangeSeconds: 86400, step: "10m" },
  "3d": { label: "3 days", rangeSeconds: 259200, step: "30m" },
  "7d": { label: "7 days", rangeSeconds: 604800, step: "1h" },
  "14d": { label: "14 days", rangeSeconds: 1209600, step: "2h" },
  "21d": { label: "21 days", rangeSeconds: 1814400, step: "3h" },
  "30d": { label: "30 days", rangeSeconds: 2592000, step: "4h" },
} as const;

export type MetricWindow = keyof typeof WINDOWS;

/**
 * What the dashboard opens on, and where an absent or unrecognised `window=`
 * lands.
 *
 * Half an hour, because the question someone opens this to answer is "what is
 * happening now". Over a day, a chain that has been failing for ten minutes is
 * 0.7% of the window judging it — the average absorbs the incident that made
 * you open the page. The cost is noisier rate-derived numbers (uptime,
 * availability, error rate ride far fewer samples), which is the trade a
 * now-shaped default is making on purpose.
 */
export const DEFAULT_WINDOW: MetricWindow = "30m";

/** The exact option list (order included) of the design's window <select>. */
export const WINDOW_OPTIONS: readonly MetricWindow[] = [
  "5m",
  "15m",
  "30m",
  "3h",
  "6h",
  "12h",
  "1d",
  "3d",
  "7d",
  "14d",
  "21d",
  "30d",
] as const;

/** Wire-format aliases (the design's Dashboard chips say "24h" for "1d"). */
const WINDOW_ALIASES: Record<string, MetricWindow> = { "24h": "1d" };

export function isMetricWindow(v: string): v is MetricWindow {
  return v in WINDOWS;
}

/** Parse an incoming window param: exact key → alias → default. */
export function toMetricWindow(v: string | undefined): MetricWindow {
  if (!v) return DEFAULT_WINDOW;
  if (isMetricWindow(v)) return v;
  return WINDOW_ALIASES[v] ?? DEFAULT_WINDOW;
}

/** The window's step as a number of seconds. */
export function stepSeconds(window: MetricWindow): number {
  const m = WINDOWS[window].step.match(/^(\d+)([smh])$/);
  if (!m) return 15;
  const n = Number(m[1]);
  return m[2] === "s" ? n : m[2] === "m" ? n * 60 : n * 3600;
}

/** Steps a chart may use, finest first - round numbers a reader can say out loud. */
const NICE_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400] as const;

const fmtStep = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}h` : sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`);

/** The finest nice step that keeps a window at or under `points` samples. */
function niceStep(rangeSeconds: number, points: number): number {
  return NICE_STEPS.find((sec) => rangeSeconds / sec <= points) ?? 86400;
}

/**
 * How a detail chart samples a window: about 300 points whatever the window,
 * each one averaging the `lookback` before it - a 24th of the window, four
 * steps at least, five minutes at least once the window holds six of them, a
 * whole number of steps. Dense AND smooth: a short average on light traffic
 * swings between "one request" and "none" at every point. `rateWindow` is the
 * short rate those averages are built from: a step, and a minute at least, so
 * it always spans two scrapes. One day is a point every 5 minutes, each
 * averaging the hour before it.
 */
export function chartSampling(window: MetricWindow): {
  step: string;
  stepSec: number;
  lookback: string;
  lookbackSec: number;
  rateWindow: string;
  rateWindowSec: number;
} {
  const range = WINDOWS[window].rangeSeconds;
  const stepSec = niceStep(range, 300);
  const lookbackSec = Math.ceil(Math.max(stepSec * 4, range / 24, Math.min(300, range / 6)) / stepSec) * stepSec;
  const rateWindowSec = Math.max(stepSec, 60);
  return { step: fmtStep(stepSec), stepSec, lookback: fmtStep(lookbackSec), lookbackSec, rateWindow: fmtStep(rateWindowSec), rateWindowSec };
}

/** The bar sizes an errors-over-time chart uses: the clock's own, ten minutes at least. */
const ERROR_BUCKETS = [600, 1800, 3600, 10800, 21600, 43200, 86400] as const;

/**
 * How an errors-over-time chart buckets a window: the finest of the clock's
 * own intervals - ten minutes at least - that keeps it to 48 bars. A bar is
 * where you click through to the requests behind it, so it is a stretch of
 * time a person would name: six hours is a bar per 10 minutes, a day a bar
 * per 30.
 */
export function errorBuckets(window: MetricWindow): { step: string; stepSec: number } {
  const range = WINDOWS[window].rangeSeconds;
  const stepSec = ERROR_BUCKETS.find((sec) => range / sec <= 48) ?? 86400;
  return { step: fmtStep(stepSec), stepSec };
}

/**
 * The bars of an errors-over-time chart, on the clock: the first starts at
 * the boundary at or before the window's start, the last is the one still
 * filling. As a grid its points are the bars' END times (`start` is the
 * first bar's end) - a bar at `t` covers the `stepSec` before it, which is
 * what `increase(…[step])` evaluated at `t` counts. The bar still filling
 * can't be read that way (it ends in the future, and a store like Mimir
 * refuses to evaluate far past now), so `lastFull` is where the range read
 * stops and `partialSec` is how much of the next bar has passed: read it as
 * one instant `increase` over that many seconds. 0 = no bar filling.
 */
export function bucketGrid(window: MetricWindow, nowSec: number): { grid: ChartGrid; lastFull: number; partialSec: number } {
  const { stepSec } = errorBuckets(window);
  const firstStart = Math.floor((nowSec - WINDOWS[window].rangeSeconds) / stepSec) * stepSec;
  const lastFull = Math.floor(nowSec / stepSec) * stepSec;
  const partialSec = nowSec - lastFull;
  return {
    grid: { start: firstStart + stepSec, end: partialSec > 0 ? lastFull + stepSec : lastFull, stepSec },
    lastFull,
    partialSec,
  };
}
