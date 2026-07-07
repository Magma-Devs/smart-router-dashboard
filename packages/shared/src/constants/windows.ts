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

export const DEFAULT_WINDOW: MetricWindow = "1d";

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
