/**
 * PromQL query builders shared by the API (executes them) and available to the
 * web for documentation. Every query targets the GROUND-TRUTH metric names in
 * `constants/metrics.ts`.
 */
import { ENDPOINT_METRICS, ROUTER_METRICS } from "../constants/metrics.js";
import { WINDOWS, type MetricWindow } from "../constants/windows.js";

/** Build a `{spec="ETH1",...}` label selector; empty string for no filters. */
export function selector(labels: Record<string, string | undefined>): string {
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}="${v}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

export function rangeFor(window: MetricWindow): string {
  return `${WINDOWS[window].rangeSeconds}s`;
}

/** Total requests over the window (optionally scoped to one spec). */
export function qRequestsTotal(spec?: string, window: MetricWindow = "1d"): string {
  return `sum(increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}]))`;
}

/** success / total over the window → availability ratio (0..1). */
export function qAvailability(spec?: string, window: MetricWindow = "1d"): string {
  const sel = selector({ spec });
  const r = rangeFor(window);
  return `sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}])) / sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]))`;
}

/** 1 - success/total → error rate (0..1). */
export function qErrorRate(spec?: string, window: MetricWindow = "1d"): string {
  return `1 - (${qAvailability(spec, window)})`;
}

/** histogram_quantile over the router latency histogram. */
export function qLatencyQuantile(
  quantile: number,
  spec?: string,
  window: MetricWindow = "1d",
): string {
  const sel = selector({ spec });
  const r = rangeFor(window);
  return `histogram_quantile(${quantile}, sum by (spec, le) (rate(${ROUTER_METRICS.latencyBucket}${sel}[${r}])))`;
}

/** Instant requests/sec (rate over the last 5m). */
export function qRps(spec?: string): string {
  return `sum(rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[5m]))`;
}

/** Latest observed block per chain (instant gauge). */
export function qLatestBlock(spec?: string): string {
  return `max by (spec) (${ROUTER_METRICS.latestBlock}${selector({ spec })})`;
}

/** Per-chain health gauge (1/0). */
export function qOverallHealth(): string {
  return ROUTER_METRICS.overallHealth;
}

/** Per-endpoint composite QoS (selection_score), instant. */
export function qEndpointScore(scoreType: string, spec?: string): string {
  return `${ENDPOINT_METRICS.selectionScore}${selector({ spec, score_type: scoreType })}`;
}

/** Per-endpoint request totals over the window, grouped by endpoint_id. */
export function qEndpointRequests(spec?: string, window: MetricWindow = "1d"): string {
  return `sum by (endpoint_id) (increase(${ENDPOINT_METRICS.totalRelaysServiced}${selector({ spec })}[${rangeFor(window)}]))`;
}

/** Per-endpoint health gauge by endpoint_id. */
export function qEndpointHealth(spec?: string): string {
  return `${ENDPOINT_METRICS.overallHealth}${selector({ spec })}`;
}
