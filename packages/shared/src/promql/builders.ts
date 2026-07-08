/**
 * PromQL query builders shared by the API (executes them) and available to the
 * web for documentation. Every query targets the GROUND-TRUTH metric names in
 * `constants/metrics.ts`.
 */
import {
  ENDPOINT_METRICS,
  OPTIMIZER_METRICS,
  ROUTER_METRICS,
} from "../constants/metrics.js";
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

/** ` offset 86400s` suffix for prior-window comparisons; empty when unset. */
function off(offset?: string): string {
  return offset ? ` offset ${offset}` : "";
}

/**
 * Total RELAYS over the window (optionally scoped to one spec).
 *
 * ⚠ `smartrouter_requests_total` is RELAY-scoped: a cross-validated request
 * increments it once per participant, cache-served requests appear under
 * `provider_address="Cached"`, and router-internal tracker/probe traffic lands
 * here too. For CLIENT-facing request counts use `qClientRequests*` (the
 * end-to-end latency histogram `_count`, which increments exactly once per
 * client request and stays flat when only probes run — verified empirically).
 */
export function qRequestsTotal(
  spec?: string,
  window: MetricWindow = "1d",
  offset?: string,
): string {
  // round(): increase() extrapolates to the window edges and returns a float, so
  // a young counter yields e.g. 239.1 "requests" — a request count is inherently
  // a whole number, so round it back to an integer.
  return `round(sum(increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/* ── Client-scoped request counts (latency-histogram _count) ─────────────── */

/** Client requests served over the window (one increment per client request). */
export function qClientRequestsTotal(
  spec?: string,
  window: MetricWindow = "1d",
  offset?: string,
): string {
  return `round(sum(increase(${ROUTER_METRICS.latencyCount}${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/** Client requests grouped by a label (`spec` or `function` = method). */
export function qClientRequestsBy(
  by: "spec" | "function",
  window: MetricWindow = "1d",
  spec?: string,
): string {
  return `round(sum by (${by}) (increase(${ROUTER_METRICS.latencyCount}${selector({ spec })}[${rangeFor(window)}])))`;
}

/** Instant client requests/sec (rate over the last 5m). */
export function qClientRps(spec?: string): string {
  return `sum(rate(${ROUTER_METRICS.latencyCount}${selector({ spec })}[5m]))`;
}

/** Client RPS series. */
export function qClientRpsSeriesExpr(step: string, spec?: string): string {
  return `sum(rate(${ROUTER_METRICS.latencyCount}${selector({ spec })}[${step}]))`;
}

/** Per-method p95/p50/… — the histogram DOES carry the method (as `function`). */
export function qMethodLatencyQuantile(
  quantile: number,
  window: MetricWindow = "1d",
  spec?: string,
): string {
  return `histogram_quantile(${quantile}, sum by (function, le) (rate(${ROUTER_METRICS.latencyBucket}${selector({ spec })}[${rangeFor(window)}])))`;
}

/** success / total over the window → availability ratio (0..1).
 *
 * clamp_max(…, 1): increase()/rate() EXTRAPOLATE to the window edges, so over a
 * counter younger than the window the numerator and denominator are projected
 * independently and their ratio can drift above 1.0 (e.g. a 103% "success
 * rate"). Ratios here are definitionally ≤ 1, so clamp it — the artifact is
 * worst right after a fresh router boot and vanishes once there's a full window
 * of history, but the clamp keeps the KPI honest at every age. */
export function qAvailability(
  spec?: string,
  window: MetricWindow = "1d",
  offset?: string,
): string {
  const sel = selector({ spec });
  const r = rangeFor(window);
  const o = off(offset);
  return `clamp_max(sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]${o})) / sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]${o})), 1)`;
}

/** 1 - success/total → error rate (0..1). */
export function qErrorRate(
  spec?: string,
  window: MetricWindow = "1d",
  offset?: string,
): string {
  return `1 - (${qAvailability(spec, window, offset)})`;
}

/** histogram_quantile over the router latency histogram. */
export function qLatencyQuantile(
  quantile: number,
  spec?: string,
  window: MetricWindow = "1d",
  offset?: string,
): string {
  const sel = selector({ spec });
  const r = rangeFor(window);
  return `histogram_quantile(${quantile}, sum by (spec, le) (rate(${ROUTER_METRICS.latencyBucket}${sel}[${r}]${off(offset)})))`;
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

/* ── Derived error math (real: total − success, clamped ≥ 0) ─────────────── */

/** Absolute error count over the window (total − success), whole number. */
export function qErrorCount(
  spec?: string,
  window: MetricWindow = "1d",
  offset?: string,
): string {
  const sel = selector({ spec });
  const r = rangeFor(window);
  const o = off(offset);
  return `round(clamp_min(sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]${o})) - sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]${o})), 0))`;
}

export type ErrorsGroupBy = "spec" | "provider_address" | "method";

/**
 * Error counts grouped by a label. The `or … * 0` keeps groups whose success
 * series is absent (all-errors groups would otherwise vanish from the result).
 */
export function qErrorsBy(
  by: ErrorsGroupBy,
  window: MetricWindow = "1d",
  spec?: string,
): string {
  const sel = selector({ spec });
  const r = rangeFor(window);
  const tot = `sum by (${by}) (increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]))`;
  const ok = `sum by (${by}) (increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]))`;
  return `round(clamp_min(${tot} - (${ok} or ${tot} * 0), 0))`;
}

/** Relays grouped by a label over the window (whole numbers). */
export function qRequestsBy(
  by: ErrorsGroupBy,
  window: MetricWindow = "1d",
  spec?: string,
): string {
  return `round(sum by (${by}) (increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}])))`;
}

/**
 * Labelled error counters grouped by a label (whole numbers). Valid for
 * `smartrouter_node_errors_total` / `smartrouter_protocol_errors_total`
 * ({spec, apiInterface, provider_address, method}) once the family exists.
 */
export function qLabelledErrorsBy(
  metricName: string,
  by: "spec" | "method" | "provider_address",
  window: MetricWindow = "1d",
  spec?: string,
): string {
  return `round(sum by (${by}) (increase(${metricName}${selector({ spec })}[${rangeFor(window)}])))`;
}

/** Total of a labelled error counter over the window (whole number). */
export function qLabelledErrorsTotal(
  metricName: string,
  window: MetricWindow = "1d",
  spec?: string,
  offset?: string,
): string {
  return `round(sum(increase(${metricName}${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/* ── Series expressions (for query_range; [step] = per-bucket lookback) ──── */

/** Availability ratio series (success/total rate over each step bucket).
 *  clamp_max(…, 1): same rate()-extrapolation guard as qAvailability. */
export function qAvailabilitySeriesExpr(step: string, spec?: string): string {
  const sel = selector({ spec });
  return `clamp_max(sum(rate(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${step}])) / sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[${step}])), 1)`;
}

/** Error-rate series (1 − availability). */
export function qErrorRateSeriesExpr(step: string, spec?: string): string {
  return `1 - (${qAvailabilitySeriesExpr(step, spec)})`;
}

/** Error-count series (whole errors per step bucket). */
export function qErrorCountSeriesExpr(step: string, spec?: string): string {
  const sel = selector({ spec });
  return `round(clamp_min(sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${step}])) - sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${step}])), 0))`;
}

/** RPS series. */
export function qRpsSeriesExpr(step: string, spec?: string): string {
  return `sum(rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${step}]))`;
}

/** Latency-quantile series over the router histogram. */
export function qLatencySeriesExpr(
  quantile: number,
  step: string,
  spec?: string,
): string {
  return `histogram_quantile(${quantile}, sum by (le) (rate(${ROUTER_METRICS.latencyBucket}${selector({ spec })}[${step}])))`;
}

/** Per-upstream RPS series (stacked upstream-mix charts). */
export function qPerUpstreamRpsExpr(step: string, spec?: string): string {
  return `sum by (provider_address) (rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${step}]))`;
}

/** Per-chain RPS series (stacked per-chain charts). */
export function qPerSpecRpsExpr(step: string): string {
  return `sum by (spec) (rate(${ROUTER_METRICS.requestsTotal}[${step}]))`;
}

/**
 * Share of traffic served by the named backup upstreams (0..1 series).
 * Upstream names are regex-escaped and OR-joined.
 */
export function qBackupShareExpr(
  spec: string,
  backupNames: string[],
  step: string,
): string {
  const escaped = backupNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\\\$&"));
  const sel = selector({ spec });
  const backupSel = `{spec="${spec}",provider_address=~"${escaped.join("|")}"}`;
  return `sum(rate(${ROUTER_METRICS.requestsTotal}${backupSel}[${step}])) / sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[${step}]))`;
}

/* ── Endpoint-scope (per-upstream) latency + volume ──────────────────────── */

/** histogram_quantile over ONE endpoint's latency histogram (window scalar). */
export function qEndpointLatencyQuantile(
  quantile: number,
  endpointId: string,
  window: MetricWindow = "1d",
): string {
  return `histogram_quantile(${quantile}, sum by (le) (rate(${ENDPOINT_METRICS.latencyBucket}${selector({ endpoint_id: endpointId })}[${rangeFor(window)}])))`;
}

/** Latency-quantile series for one endpoint. */
export function qEndpointLatencySeriesExpr(
  quantile: number,
  endpointId: string,
  step: string,
): string {
  return `histogram_quantile(${quantile}, sum by (le) (rate(${ENDPOINT_METRICS.latencyBucket}${selector({ endpoint_id: endpointId })}[${step}])))`;
}

/** One upstream's request-volume series (router scope, by provider_address). */
export function qUpstreamVolumeSeriesExpr(
  upstreamAddress: string,
  step: string,
): string {
  return `sum(increase(${ROUTER_METRICS.requestsTotal}${selector({ provider_address: upstreamAddress })}[${step}]))`;
}

/** One upstream's READ-volume series (requests_read_total is real). */
export function qUpstreamReadVolumeSeriesExpr(
  upstreamAddress: string,
  step: string,
): string {
  return `sum(increase(${ROUTER_METRICS.requestsReadTotal}${selector({ provider_address: upstreamAddress })}[${step}]))`;
}

/** Per-upstream error rate over the window (router scope). */
export function qUpstreamErrorRate(
  upstreamAddress: string,
  window: MetricWindow = "1d",
): string {
  const sel = selector({ provider_address: upstreamAddress });
  const r = rangeFor(window);
  return `1 - (sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}])) / sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}])))`;
}

/* ── Health / block-lag / scores / gauges ────────────────────────────────── */

/** Block lag per endpoint: spec-max latest block − each endpoint's block. */
export function qBlockLagByEndpoint(spec?: string): string {
  const sel = selector({ spec });
  return `max by (spec) (${ENDPOINT_METRICS.latestBlock}${sel}) - on(spec) group_right() ${ENDPOINT_METRICS.latestBlock}${sel}`;
}

/** Block-lag series for ONE endpoint (needs its spec for the max side). */
export function qEndpointBlockLagSeriesExpr(spec: string, endpointId: string): string {
  return `max(${ENDPOINT_METRICS.latestBlock}${selector({ spec })}) - max(${ENDPOINT_METRICS.latestBlock}${selector({ spec, endpoint_id: endpointId })})`;
}

/** Specs whose every endpoint is down (bool per spec). */
export function qChainDown(): string {
  return `max by (spec) (${ENDPOINT_METRICS.overallHealth}) == bool 0`;
}

/** Selection-score expression (gauge; also valid for query_range series). */
export function qScoreExpr(
  scoreType: string,
  spec?: string,
  endpointId?: string,
): string {
  return `avg(${ENDPOINT_METRICS.selectionScore}${selector({ spec, endpoint_id: endpointId, score_type: scoreType })})`;
}

/** Optimizer-scope composite score per spec (no apiInterface label). */
export function qOptimizerScore(scoreType: string, spec?: string): string {
  return `avg(${OPTIMIZER_METRICS.selectionScore}${selector({ spec, score_type: scoreType })})`;
}

/**
 * Consistency checks RUN over the window (smartrouter_consistency_total =
 * "relay requests that enforced a minimum seen block").
 */
export function qConsistencyChecked(
  window: MetricWindow = "1d",
  offset?: string,
  spec?: string,
): string {
  return `round(sum(increase(${ROUTER_METRICS.consistencyTotal}${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/**
 * Stale responses actually CAUGHT = consistency checks that FAILED
 * (smartrouter_consistency_failed_total — lazily registered; absent family
 * means zero failures, not "unknown"). NOTE: consistency_success_total counts
 * checks that PASSED — using it here would report every healthy read as a
 * "caught stale response" (the bug this replaced).
 */
export function qConsistencyCaught(
  window: MetricWindow = "1d",
  offset?: string,
  spec?: string,
): string {
  return `round(sum(increase(smartrouter_consistency_failed_total${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/** The four csm_* gauges in one instant query. */
export function qCsm(): string {
  return `{__name__=~"${ROUTER_METRICS.csmBlockedProviders}|${ROUTER_METRICS.csmBlockedBackupProviders}|${ROUTER_METRICS.csmReportedProviders}|${ROUTER_METRICS.csmStickySessions}"}`;
}

/** Latency histogram bucket distribution over the window (per le). */
export function qLatencyDistribution(
  window: MetricWindow = "1d",
  spec?: string,
): string {
  return `sum by (le) (increase(${ROUTER_METRICS.latencyBucket}${selector({ spec })}[${rangeFor(window)}]))`;
}

/** Presence probe: non-empty result ⇒ the family is registered/emitted. */
export function qPresence(metricName: string): string {
  return `count({__name__="${metricName}"})`;
}
