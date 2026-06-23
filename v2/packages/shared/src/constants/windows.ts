/** Time-window selector → PromQL range string + a sensible bucket step. */
export const WINDOWS = {
  "5m": { label: "5 min", rangeSeconds: 300, step: "15s" },
  "1h": { label: "1 hour", rangeSeconds: 3600, step: "1m" },
  "6h": { label: "6 hours", rangeSeconds: 21600, step: "5m" },
  "1d": { label: "24 hours", rangeSeconds: 86400, step: "15m" },
  "7d": { label: "7 days", rangeSeconds: 604800, step: "2h" },
  "30d": { label: "30 days", rangeSeconds: 2592000, step: "6h" },
} as const;

export type MetricWindow = keyof typeof WINDOWS;

export const DEFAULT_WINDOW: MetricWindow = "1d";

export function isMetricWindow(v: string): v is MetricWindow {
  return v in WINDOWS;
}
