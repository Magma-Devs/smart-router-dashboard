/**
 * PromQL query builders shared by the API (executes them) and available to the
 * web for documentation. Every query targets the GROUND-TRUTH metric names in
 * `constants/metrics.ts`.
 */
import {
  ENDPOINT_METRICS,
  OPTIMIZER_METRICS,
  OPTIONAL_METRICS,
  ROUTER_METRICS,
} from "../constants/metrics.js";
import { DEFAULT_WINDOW, MIN_RATE_RANGE_SEC, WINDOWS, durationSeconds, type MetricWindow } from "../constants/windows.js";
import type { UpstreamRef } from "../types/domain.js";
import { duration, joinPromQL, labelList, labelName, promql, promRegex, promString, regex, regexAlt, regexLiteral, type PromQL } from "./query-text.js";
import { RECORDED, RECORDED_INTERVAL_SECONDS, SCRAPE_INTERVAL_SECONDS, recordedReadsFor, recordedSeriesFor } from "./recorded.js";

/**
 * Build a `{spec="ETH1",...}` label selector; empty for no filters. Each value
 * is one escaped string literal (`promString`), so no value can close the
 * matcher; each name must be a label name.
 */
export function selector(labels: Record<string, string | undefined>): PromQL {
  const parts = Object.entries(labels)
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== "")
    .map(([k, v]) => promql`${labelName(k)}=${promString(v)}`);
  return parts.length ? promql`{${joinPromQL(parts, promql`,`)}}` : promql``;
}

export function rangeFor(window: MetricWindow): PromQL {
  return duration(WINDOWS[window].rangeSeconds);
}

/** ` offset 86400s` suffix for prior-window comparisons; empty when unset. */
function off(offset?: string): PromQL {
  return offset ? promql` offset ${duration(offset)}` : promql``;
}

/* ── Ranges for series drawn every `step` ────────────────────────────────── */

/** The range a rate line drawn every `step` reads: the step, or a minute when the step is shorter. */
export function rateRange(step: string): PromQL {
  return durationSeconds(step) < MIN_RATE_RANGE_SEC ? promql`1m` : duration(step);
}

/**
 * How many points of a `step` grid a counter step lands in: the fewest that
 * make the count range (`countRangeSec`) a minute at least. One for a
 * `single` read, which no other point overlaps.
 */
export function countPointsPerStep(step: string, single = false): number {
  const sec = durationSeconds(step);
  if (single || !(sec > 0)) return 1;
  return Math.max(1, Math.ceil((MIN_RATE_RANGE_SEC - SCRAPE_INTERVAL_SECONDS) / sec));
}

/**
 * The range a count drawn every `step` reads: m steps and one scrape. A
 * counter step sits inside it for exactly m steps, so it lands in m points at
 * 1/m each, at every phase of the scrape clock, and the points add up to the
 * counter's delta.
 */
export function countRangeSec(step: string, single = false): number {
  return countPointsPerStep(step, single) * durationSeconds(step) + SCRAPE_INTERVAL_SECONDS;
}

/** The count per point of a series drawn every `step` (errors, volume); see `countRangeSec`. */
export function countOverStep(series: PromQL, step: string, single = false): PromQL {
  const sec = durationSeconds(step);
  if (!(sec > 0)) return promql`increase(${series}[${duration(step)}])`;
  return promql`(rate(${series}[${duration(countRangeSec(step, single))}]) * ${sec})`;
}

/** `round()` where a counter step lands in one point; a point holding shares of steps stays as it is. */
function roundWhole(expr: PromQL, step: string, single = false): PromQL {
  return countPointsPerStep(step, single) === 1 ? promql`round(${expr})` : expr;
}

/* ── Recorded-series forms (see recorded.ts) ─────────────────────────────── */

/** Per-minute rate samples summed over a range: a count once scaled by `K`. */
function sot(series: PromQL, range: string, offset?: string): PromQL {
  return promql`sum_over_time(${series}[${duration(range)}]${off(offset)})`;
}

/** Per-minute rate samples averaged over a range: the mean rate across it. */
function aot(series: PromQL, range: string): PromQL {
  return promql`avg_over_time(${series}[${duration(range)}])`;
}

/** The seconds each recorded sample stands for. */
const K = RECORDED_INTERVAL_SECONDS;

/** The recorded relay pair a grouping reads: the family that carries that label. */
function recordedPair(by: ErrorsGroupBy): { total: PromQL; ok: PromQL } {
  if (by === "provider_address") return { total: RECORDED.requestsByProvider, ok: RECORDED.successByProvider };
  if (by === "method") return { total: RECORDED.requestsByMethod, ok: RECORDED.successByMethod };
  return { total: RECORDED.requests, ok: RECORDED.success };
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
  window: MetricWindow = DEFAULT_WINDOW,
  offset?: string,
): PromQL {
  if (recordedReadsFor(window, offset ? 2 : 1)) {
    return promql`round(sum(${sot(promql`${RECORDED.requests}${selector({ spec })}`, rangeFor(window), offset)}) * ${K})`;
  }
  // round(): increase() extrapolates to the window edges and returns a float, so
  // a young counter yields e.g. 239.1 "requests" — a request count is inherently
  // a whole number, so round it back to an integer.
  return promql`round(sum(increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/* ── Client-scoped request counts (latency-histogram _count) ─────────────── */

/** Client requests served over the window (one increment per client request). */
export function qClientRequestsTotal(
  spec?: string,
  window: MetricWindow = DEFAULT_WINDOW,
  offset?: string,
): PromQL {
  if (recordedReadsFor(window, offset ? 2 : 1)) {
    return promql`round(sum(${sot(promql`${RECORDED.clientRequests}${selector({ spec })}`, rangeFor(window), offset)}) * ${K})`;
  }
  return promql`round(sum(increase(${ROUTER_METRICS.latencyCount}${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/** Client requests grouped by a label (`spec` or `function` = method). The
 *  recorded series carry no `function`, so that grouping always reads raw. */
export function qClientRequestsBy(
  by: "spec" | "function",
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): PromQL {
  if (by === "spec" && recordedReadsFor(window)) {
    return promql`round(sum by (spec) (${sot(promql`${RECORDED.clientRequests}${selector({ spec })}`, rangeFor(window))}) * ${K})`;
  }
  return promql`round(sum by (${labelName(by)}) (increase(${ROUTER_METRICS.latencyCount}${selector({ spec })}[${rangeFor(window)}])))`;
}

/** Instant client requests/sec (rate over the last 5m). */
export function qClientRps(spec?: string): PromQL {
  return promql`sum(rate(${ROUTER_METRICS.latencyCount}${selector({ spec })}[5m]))`;
}

/** Client RPS series. `window` lets a long window read the recorded series. */
export function qClientRpsSeriesExpr(step: string, spec?: string, window?: MetricWindow): PromQL {
  if (recordedSeriesFor(window)) {
    return promql`sum(${aot(promql`${RECORDED.clientRequests}${selector({ spec })}`, step)})`;
  }
  return promql`sum(rate(${ROUTER_METRICS.latencyCount}${selector({ spec })}[${rateRange(step)}]))`;
}

/** Per-method p95/p50/… — the histogram DOES carry the method (as `function`). */
export function qMethodLatencyQuantile(
  quantile: number,
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): PromQL {
  return promql`histogram_quantile(${quantile}, sum by (function, le) (rate(${ROUTER_METRICS.latencyBucket}${selector({ spec })}[${rangeFor(window)}])))`;
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
  window: MetricWindow = DEFAULT_WINDOW,
  offset?: string,
): PromQL {
  const sel = selector({ spec });
  const r = rangeFor(window);
  const o = off(offset);
  if (recordedReadsFor(window, offset ? 2 : 1)) {
    return promql`clamp_max(sum(${sot(promql`${RECORDED.success}${sel}`, r, offset)}) / sum(${sot(promql`${RECORDED.requests}${sel}`, r, offset)}), 1)`;
  }
  return promql`clamp_max(sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]${o})) / sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]${o})), 1)`;
}

/** 1 - success/total → error rate (0..1). */
export function qErrorRate(
  spec?: string,
  window: MetricWindow = DEFAULT_WINDOW,
  offset?: string,
): PromQL {
  return promql`1 - (${qAvailability(spec, window, offset)})`;
}

/**
 * histogram_quantile over the router latency histogram, for the window. All
 * chains in scope count as one distribution - one series, so `scalar()` reads
 * it whole; `spec` narrows it to one chain. Per-chain lines use
 * `qPerSpecLatencySeriesExpr`.
 */
export function qLatencyQuantile(
  quantile: number,
  spec?: string,
  window: MetricWindow = DEFAULT_WINDOW,
  offset?: string,
): PromQL {
  const sel = selector({ spec });
  const r = rangeFor(window);
  if (recordedReadsFor(window, offset ? 2 : 1)) {
    return promql`histogram_quantile(${quantile}, sum by (le) (${sot(promql`${RECORDED.latencyBucket}${sel}`, r, offset)}))`;
  }
  return promql`histogram_quantile(${quantile}, sum by (le) (rate(${ROUTER_METRICS.latencyBucket}${sel}[${r}]${off(offset)})))`;
}

/** Instant requests/sec (rate over the last 5m). */
export function qRps(spec?: string): PromQL {
  return promql`sum(rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[5m]))`;
}

/** Latest observed block per chain (instant gauge). */
export function qLatestBlock(spec?: string): PromQL {
  return promql`max by (spec) (${ROUTER_METRICS.latestBlock}${selector({ spec })})`;
}

/** Per-chain health gauge (1/0). */
export function qOverallHealth(): PromQL {
  return ROUTER_METRICS.overallHealth;
}

/** Per-endpoint composite QoS (selection_score), instant. */
export function qEndpointScore(scoreType: string, spec?: string): PromQL {
  return promql`${ENDPOINT_METRICS.selectionScore}${selector({ spec, score_type: scoreType })}`;
}

/** Per-endpoint request totals over the window, grouped by endpoint_id. */
export function qEndpointRequests(spec?: string, window: MetricWindow = DEFAULT_WINDOW): PromQL {
  if (recordedReadsFor(window)) {
    return promql`sum by (endpoint_id) (${sot(promql`${RECORDED.endpointRelays}${selector({ spec })}`, rangeFor(window))}) * ${K}`;
  }
  return promql`sum by (endpoint_id) (increase(${ENDPOINT_METRICS.totalRelaysServiced}${selector({ spec })}[${rangeFor(window)}]))`;
}

/** Relays served per (upstream, chain) over the window — the roster's volume column. */
export function qEndpointRelaysBySpec(window: MetricWindow = DEFAULT_WINDOW, spec?: string): PromQL {
  const sel = selector({ spec });
  if (recordedReadsFor(window)) {
    return promql`sum by (endpoint_id, spec) (${sot(promql`${RECORDED.endpointRelays}${sel}`, rangeFor(window))}) * ${K}`;
  }
  return promql`sum by (endpoint_id, spec) (increase(${ENDPOINT_METRICS.totalRelaysServiced}${sel}[${rangeFor(window)}]))`;
}

/** A latency quantile per (upstream, chain) over the window — the roster's p95. */
export function qEndpointLatencyQuantileBySpec(
  quantile: number,
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): PromQL {
  const sel = selector({ spec });
  if (recordedReadsFor(window)) {
    return promql`histogram_quantile(${quantile}, sum by (endpoint_id, spec, le) (${sot(promql`${RECORDED.endpointLatencyBucket}${sel}`, rangeFor(window))}))`;
  }
  return promql`histogram_quantile(${quantile}, sum by (endpoint_id, spec, le) (rate(${ENDPOINT_METRICS.latencyBucket}${sel}[${rangeFor(window)}])))`;
}

/**
 * The router's per-provider blocked gauge (1 = no url in rotation, so no
 * traffic; 0 = serving), keyed by `endpoint_id` like the per-endpoint
 * families: `provider_address` carries the same configured name.
 */
export function qProviderBlockedByEndpoint(spec?: string): PromQL {
  return promql`label_replace(${ROUTER_METRICS.csmProviderBlocked}${selector({ spec })}, "endpoint_id", "$1", "provider_address", "(.*)")`;
}

/* ── Derived error math (real: total − success, clamped ≥ 0) ─────────────── */

/** Absolute error count over the window (total − success), whole number. */
export function qErrorCount(
  spec?: string,
  window: MetricWindow = DEFAULT_WINDOW,
  offset?: string,
): PromQL {
  const sel = selector({ spec });
  const r = rangeFor(window);
  const o = off(offset);
  if (recordedReadsFor(window, offset ? 2 : 1)) {
    return promql`round(clamp_min((sum(${sot(promql`${RECORDED.requests}${sel}`, r, offset)}) - sum(${sot(promql`${RECORDED.success}${sel}`, r, offset)})) * ${K}, 0))`;
  }
  return promql`round(clamp_min(sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]${o})) - sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]${o})), 0))`;
}

export type ErrorsGroupBy = "spec" | "provider_address" | "method";

/**
 * Error counts grouped by a label. The `or … * 0` keeps groups whose success
 * series is absent (all-errors groups would otherwise vanish from the result).
 */
export function qErrorsBy(
  by: ErrorsGroupBy,
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): PromQL {
  const sel = selector({ spec });
  const r = rangeFor(window);
  if (recordedReadsFor(window)) {
    const pair = recordedPair(by);
    const tot = promql`sum by (${labelName(by)}) (${sot(promql`${pair.total}${sel}`, r)})`;
    const ok = promql`sum by (${labelName(by)}) (${sot(promql`${pair.ok}${sel}`, r)})`;
    return promql`round(clamp_min((${tot} - (${ok} or ${tot} * 0)) * ${K}, 0))`;
  }
  const tot = promql`sum by (${labelName(by)}) (increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]))`;
  const ok = promql`sum by (${labelName(by)}) (increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]))`;
  return promql`round(clamp_min(${tot} - (${ok} or ${tot} * 0), 0))`;
}

/**
 * Failed relays per (chain × upstream) - `qErrorsBy` with both labels on one
 * vector, the pair the Errors hotspots and the Retry upstream panel list.
 */
export function qErrorsByUpstream(window: MetricWindow = DEFAULT_WINDOW, spec?: string): PromQL {
  const sel = selector({ spec });
  const r = rangeFor(window);
  if (recordedReadsFor(window)) {
    const tot = promql`sum by (spec, provider_address) (${sot(promql`${RECORDED.requestsByProvider}${sel}`, r)})`;
    const ok = promql`sum by (spec, provider_address) (${sot(promql`${RECORDED.successByProvider}${sel}`, r)})`;
    return promql`round(clamp_min((${tot} - (${ok} or ${tot} * 0)) * ${K}, 0))`;
  }
  const tot = promql`sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]))`;
  const ok = promql`sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]))`;
  return promql`round(clamp_min(${tot} - (${ok} or ${tot} * 0), 0))`;
}

/** Relays per (chain × upstream) over the window, whole numbers — the pair the Errors hotspots divide by. */
export function qRequestsByUpstream(window: MetricWindow = DEFAULT_WINDOW, spec?: string): PromQL {
  const sel = selector({ spec });
  if (recordedReadsFor(window)) {
    return promql`round(sum by (spec, provider_address) (${sot(promql`${RECORDED.requestsByProvider}${sel}`, rangeFor(window))}) * ${K})`;
  }
  return promql`round(sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsTotal}${sel}[${rangeFor(window)}])))`;
}

/** Relays per (upstream, chain) over the window — the roster's denominator, unrounded. */
export function qUpstreamRelays(window: MetricWindow = DEFAULT_WINDOW, spec?: string): PromQL {
  const sel = selector({ spec });
  if (recordedReadsFor(window)) {
    return promql`sum by (provider_address, spec) (${sot(promql`${RECORDED.requestsByProvider}${sel}`, rangeFor(window))}) * ${K}`;
  }
  return promql`sum by (provider_address, spec) (increase(${ROUTER_METRICS.requestsTotal}${sel}[${rangeFor(window)}]))`;
}

/** Successful relays per (upstream, chain) over the window — the roster's numerator, unrounded. */
export function qUpstreamSuccesses(window: MetricWindow = DEFAULT_WINDOW, spec?: string): PromQL {
  const sel = selector({ spec });
  if (recordedReadsFor(window)) {
    return promql`sum by (provider_address, spec) (${sot(promql`${RECORDED.successByProvider}${sel}`, rangeFor(window))}) * ${K}`;
  }
  return promql`sum by (provider_address, spec) (increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${rangeFor(window)}]))`;
}

/** Read relays per method over the window — the methods tab's read column. */
export function qReadRequestsByMethod(window: MetricWindow = DEFAULT_WINDOW, spec?: string): PromQL {
  const sel = selector({ spec });
  if (recordedReadsFor(window)) {
    return promql`sum by (method) (${sot(promql`${RECORDED.readByMethod}${sel}`, rangeFor(window))}) * ${K}`;
  }
  return promql`sum by (method) (increase(${ROUTER_METRICS.requestsReadTotal}${sel}[${rangeFor(window)}]))`;
}

/** Relays grouped by a label over the window (whole numbers). */
export function qRequestsBy(
  by: ErrorsGroupBy,
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): PromQL {
  if (recordedReadsFor(window)) {
    return promql`round(sum by (${labelName(by)}) (${sot(promql`${recordedPair(by).total}${selector({ spec })}`, rangeFor(window))}) * ${K})`;
  }
  return promql`round(sum by (${labelName(by)}) (increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}])))`;
}

/**
 * Labelled error counters grouped by a label (whole numbers). Valid for
 * `smartrouter_node_errors_total` / `smartrouter_protocol_errors_total`
 * ({spec, apiInterface, provider_address, method}) once the family exists.
 */
export function qLabelledErrorsBy(
  metricName: PromQL,
  by: "spec" | "method" | "provider_address",
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): PromQL {
  return promql`round(sum by (${labelName(by)}) (increase(${metricName}${selector({ spec })}[${rangeFor(window)}])))`;
}

/** Total of a labelled error counter over the window (whole number). */
export function qLabelledErrorsTotal(
  metricName: PromQL,
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
  offset?: string,
): PromQL {
  return promql`round(sum(increase(${metricName}${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/* ── Retries (absent until the router's first retry) ─────────────────────── */

/** Two `<n>s` durations (what `rangeFor` returns) added up. */
function addSeconds(a: string, b?: string): PromQL {
  const sec = (d: string) => Number(/^(\d+)s$/.exec(d)?.[1] ?? NaN);
  return b ? duration(sec(a) + sec(b)) : duration(a);
}

/**
 * `increase()` that also counts a series' birth. The router creates each
 * labelled retry counter on its first retry, so a series born inside the range
 * starts at its first value, not 0, and plain `increase()` drops that value.
 * A series with no sample at the range start has its first value (the minimum,
 * for a counter) added back, unless it was seen in the day before with a value
 * no higher: that is a gap in scraping, not a birth.
 *
 * Only when the store holds the router's gauge from that day: past the store's
 * first sample every series looks newborn, and its first value is everything
 * it counted before. The zero side is `increase() * 0`, which keeps series that
 * stopped reporting in the range; a series seen once there keeps its birth
 * value on its own. `range` and `offset` are `rangeFor` durations.
 */
export function increaseFromBirth(series: PromQL, range: string, offset?: string): PromQL {
  const o = off(offset);
  const before = addSeconds(range, offset);
  const inc = promql`increase(${series}[${duration(range)}]${o})`;
  const first = promql`min_over_time(${series}[${duration(range)}]${o})`;
  const storeHeld = promql`count(last_over_time(${ROUTER_METRICS.overallHealth}[1d] offset ${before})) > 0`;
  const birth = promql`(((${first} unless ${series} offset ${before}) unless (${first} >= last_over_time(${series}[1d] offset ${before}))) and on () (${storeHeld}))`;
  return promql`((${inc} + (${birth} or ${inc} * 0)) or ${birth})`;
}

/** How a retried request ended: a reply in the end (`recovered`) or an error. */
export type RetryOutcome = "recovered" | "failed";

const RETRY_OUTCOME_METRIC: Record<RetryOutcome, PromQL> = {
  recovered: OPTIONAL_METRICS.retriesSuccessTotal,
  failed: OPTIONAL_METRICS.retriesFailedTotal,
};

/** Retried requests with one outcome over the window, per (spec × method); `offset` = a window back. */
export function qRetriesByMethod(
  outcome: RetryOutcome,
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
  offset?: string,
): PromQL {
  return promql`round(sum by (spec, method) ${increaseFromBirth(promql`${RETRY_OUTCOME_METRIC[outcome]}${selector({ spec })}`, rangeFor(window), offset)})`;
}

/** The per-method rows added up - the hero's "successful retries", equal to the Errors tab's card. */
export function qRetriesTotal(
  outcome: RetryOutcome,
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
  offset?: string,
): PromQL {
  return promql`sum(${qRetriesByMethod(outcome, window, spec, offset)})`;
}

/** Mean extra attempts per retried request: the histogram's sum ÷ count. */
export function qRetryAvgExtraAttempts(
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): PromQL {
  const sel = selector({ spec });
  const r = rangeFor(window);
  return promql`sum${increaseFromBirth(promql`${OPTIONAL_METRICS.retryAttemptsSum}${sel}`, r)} / sum${increaseFromBirth(promql`${OPTIONAL_METRICS.retryAttemptsCount}${sel}`, r)}`;
}

/**
 * Client requests served over the window, births included - the retry
 * rate's denominator, counted the way the retries are: a method first called
 * inside the window is a new series on both sides.
 */
export function qClientRequestsFromBirth(
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): PromQL {
  return promql`round(sum${increaseFromBirth(promql`${ROUTER_METRICS.latencyCount}${selector({ spec })}`, rangeFor(window))})`;
}


/* ── Series expressions (for query_range; [step] = per-bucket lookback) ──── */

/** Availability ratio series (success/total rate over each step bucket).
 *  clamp_max(…, 1): same rate()-extrapolation guard as qAvailability. */
export function qAvailabilitySeriesExpr(step: string, spec?: string, window?: MetricWindow): PromQL {
  const sel = selector({ spec });
  if (recordedSeriesFor(window)) {
    return promql`clamp_max(sum(${aot(promql`${RECORDED.success}${sel}`, step)}) / sum(${aot(promql`${RECORDED.requests}${sel}`, step)}), 1)`;
  }
  return promql`clamp_max(sum(rate(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${rateRange(step)}])) / sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[${rateRange(step)}])), 1)`;
}

/** Error-rate series (1 − availability). */
export function qErrorRateSeriesExpr(step: string, spec?: string, window?: MetricWindow): PromQL {
  return promql`1 - (${qAvailabilitySeriesExpr(step, spec, window)})`;
}

/** Error-count series: errors per step, whole from a one-minute step up. */
export function qErrorCountSeriesExpr(step: string, spec?: string, window?: MetricWindow): PromQL {
  const sel = selector({ spec });
  if (recordedSeriesFor(window)) {
    return promql`round(clamp_min((sum(${sot(promql`${RECORDED.requests}${sel}`, step)}) - sum(${sot(promql`${RECORDED.success}${sel}`, step)})) * ${K}, 0))`;
  }
  return roundWhole(promql`clamp_min(sum(${countOverStep(promql`${ROUTER_METRICS.requestsTotal}${sel}`, step)}) - sum(${countOverStep(promql`${ROUTER_METRICS.requestsSuccessTotal}${sel}`, step)}), 0)`, step);
}

/** RPS series. */
export function qRpsSeriesExpr(step: string, spec?: string, window?: MetricWindow): PromQL {
  if (recordedSeriesFor(window)) {
    return promql`sum(${aot(promql`${RECORDED.requests}${selector({ spec })}`, step)})`;
  }
  return promql`sum(rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rateRange(step)}]))`;
}

/** Latency-quantile series over the router histogram. */
export function qLatencySeriesExpr(
  quantile: number,
  step: string,
  spec?: string,
  window?: MetricWindow,
): PromQL {
  if (recordedSeriesFor(window)) {
    return promql`histogram_quantile(${quantile}, sum by (le) (${aot(promql`${RECORDED.latencyBucket}${selector({ spec })}`, step)}))`;
  }
  return promql`histogram_quantile(${quantile}, sum by (le) (rate(${ROUTER_METRICS.latencyBucket}${selector({ spec })}[${rateRange(step)}])))`;
}

/** Latency-quantile series per chain (the Dashboard's per-chain latency lines). */
export function qPerSpecLatencySeriesExpr(quantile: number, step: string, window?: MetricWindow): PromQL {
  if (recordedSeriesFor(window)) {
    return promql`histogram_quantile(${quantile}, sum by (spec, le) (${aot(RECORDED.latencyBucket, step)}))`;
  }
  return promql`histogram_quantile(${quantile}, sum by (spec, le) (rate(${ROUTER_METRICS.latencyBucket}[${rateRange(step)}])))`;
}

/* ── Grouped chain-level reads (one query for every group, joined on labels) ── */

/**
 * The labels a grouped read keeps: `["spec"]` for one row per chain, or
 * `["spec", <target label>]` for one row per (chain, scrape target) when the
 * Routers table attributes rows to routers. Read with `query()` and join on
 * the labels — `scalar()` would keep whichever row comes first. The target
 * label passes `isValidScopeLabel` before it reaches a query.
 */
export type GroupBy = readonly string[];

const by = (g: GroupBy): PromQL => labelList(g);

/** Client requests (histogram _count) over the window, per group. */
export function qGroupedClientRequests(g: GroupBy, window: MetricWindow = DEFAULT_WINDOW): PromQL {
  if (recordedReadsFor(window)) {
    return promql`sum by (${by(g)}) (${sot(RECORDED.clientRequests, rangeFor(window))}) * ${K}`;
  }
  return promql`sum by (${by(g)}) (increase(${ROUTER_METRICS.latencyCount}[${rangeFor(window)}]))`;
}

/** success/total over the window, per group — both sides carry the group's labels, so they match one-to-one. */
export function qGroupedAvailability(g: GroupBy, window: MetricWindow = DEFAULT_WINDOW): PromQL {
  const r = rangeFor(window);
  if (recordedReadsFor(window)) {
    return promql`clamp_max(sum by (${by(g)}) (${sot(RECORDED.success, r)}) / sum by (${by(g)}) (${sot(RECORDED.requests, r)}), 1)`;
  }
  return promql`clamp_max(sum by (${by(g)}) (increase(${ROUTER_METRICS.requestsSuccessTotal}[${r}])) / sum by (${by(g)}) (increase(${ROUTER_METRICS.requestsTotal}[${r}])), 1)`;
}

/** A latency quantile over the window, per group. `spec` narrows the read to one chain. */
export function qGroupedLatencyQuantile(
  quantile: number,
  g: GroupBy,
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): PromQL {
  if (recordedReadsFor(window)) {
    return promql`histogram_quantile(${quantile}, sum by (${by(g)}, le) (${sot(promql`${RECORDED.latencyBucket}${selector({ spec })}`, rangeFor(window))}))`;
  }
  return promql`histogram_quantile(${quantile}, sum by (${by(g)}, le) (rate(${ROUTER_METRICS.latencyBucket}${selector({ spec })}[${rangeFor(window)}])))`;
}

/** Mean composite selection score, per group. */
export function qGroupedQos(g: GroupBy): PromQL {
  return promql`avg by (${by(g)}) (${ENDPOINT_METRICS.selectionScore}${selector({ score_type: "composite" })})`;
}

/** Health per group (1/0) from the blocked gauge: 1 while any provider of the group is in rotation. */
export function qGroupedHealth(g: GroupBy, spec?: string): PromQL {
  return promql`1 - min by (${by(g)}) (${ROUTER_METRICS.csmProviderBlocked}${selector({ spec })})`;
}

/** The router's latest block, per group. */
export function qGroupedLatestBlock(g: GroupBy): PromQL {
  return promql`max by (${by(g)}) (${ROUTER_METRICS.latestBlock})`;
}

/** One row per (group, endpoint_id) on the blocked gauge — a group's upstream count is its row count. */
export function qGroupedUpstreams(g: GroupBy): PromQL {
  return promql`count by (${by(g)}, endpoint_id) (${qProviderBlockedByEndpoint()})`;
}

/** Health per chain from the blocked gauge — `qGroupedHealth` by spec. */
export function qPerSpecHealth(spec?: string): PromQL {
  return qGroupedHealth(["spec"], spec);
}

/** Per-upstream RPS series (stacked upstream-mix charts). */
export function qPerUpstreamRpsExpr(step: string, spec?: string, window?: MetricWindow): PromQL {
  if (recordedSeriesFor(window)) {
    return promql`sum by (provider_address) (${aot(promql`${RECORDED.requestsByProvider}${selector({ spec })}`, step)})`;
  }
  return promql`sum by (provider_address) (rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rateRange(step)}]))`;
}

/** Per-chain RPS series (stacked per-chain charts). */
export function qPerSpecRpsExpr(step: string, window?: MetricWindow): PromQL {
  if (recordedSeriesFor(window)) {
    return promql`sum by (spec) (${aot(RECORDED.requests, step)})`;
  }
  return promql`sum by (spec) (rate(${ROUTER_METRICS.requestsTotal}[${rateRange(step)}]))`;
}

/**
 * Share of traffic served by the named backup upstreams (0..1 series).
 * Upstream names are regex-escaped and OR-joined.
 */
export function qBackupShareExpr(
  spec: string,
  backupNames: string[],
  step: string,
  window?: MetricWindow,
): PromQL {
  const sel = selector({ spec });
  // Case-INSENSITIVE on purpose. These names come from the mounted values file,
  // while `provider_address` carries the name the ROUTER was configured with —
  // a helm deployment renders one from the other and the case need not survive
  // (`Blockdaemon` in the values, `blockdaemon` on the series). A case-sensitive
  // match silently yields an empty numerator, which reads as "0% backup" rather
  // than "no data" (MAG-2537).
  const backups = promRegex(regex`(?i)(${regexAlt(backupNames.map(regexLiteral))})`);
  const backupSel = promql`{spec=${promString(spec)},provider_address=~${backups}}`;
  if (recordedSeriesFor(window)) {
    return promql`sum(${aot(promql`${RECORDED.requestsByProvider}${backupSel}`, step)}) / sum(${aot(promql`${RECORDED.requestsByProvider}${sel}`, step)})`;
  }
  return promql`sum(rate(${ROUTER_METRICS.requestsTotal}${backupSel}[${rateRange(step)}])) / sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[${rateRange(step)}]))`;
}

/**
 * Failed tries per second for every upstream of one chain, one series per
 * `provider_address`: its relays minus its successes, on the same step and
 * range as `qAvailabilitySeriesExpr` so a point lines up with the chain's
 * availability at that time. An upstream whose success counter was never born
 * failed every try (`or … * 0`). Recorded series from the chart floor up.
 */
export function qPerUpstreamFailedRpsExpr(step: string, spec: string, window?: MetricWindow): PromQL {
  const sel = selector({ spec });
  const [tot, ok] = recordedSeriesFor(window)
    ? [
        promql`sum by (provider_address) (${aot(promql`${RECORDED.requestsByProvider}${sel}`, step)})`,
        promql`sum by (provider_address) (${aot(promql`${RECORDED.successByProvider}${sel}`, step)})`,
      ]
    : [
        promql`sum by (provider_address) (rate(${ROUTER_METRICS.requestsTotal}${sel}[${rateRange(step)}]))`,
        promql`sum by (provider_address) (rate(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${rateRange(step)}]))`,
      ];
  return promql`clamp_min(${tot} - (${ok} or ${tot} * 0), 0)`;
}

/**
 * Latest-block polls per step for every upstream of one chain, one series per
 * `endpoint_id` - the chain tracker polls every configured upstream, backups
 * included, whatever the traffic. `kind` picks successes or failures. No
 * recorded series exists for this family; it is one counter per upstream ×
 * interface × router pod, so a long window reads a few series, not a
 * histogram's thousands. ⚠ Zero on both is "not polled", never "healthy"
 * (see `qEndpointPolls`).
 */
export function qPerEndpointPollsSeriesExpr(kind: "ok" | "failed", spec: string, step: string): PromQL {
  const metric = kind === "ok" ? ENDPOINT_METRICS.fetchLatestSuccess : ENDPOINT_METRICS.fetchLatestFails;
  return promql`sum by (endpoint_id) (increase(${metric}${selector({ spec })}[${rateRange(step)}]))`;
}

/* ── Per-upstream (one name on one chain) latency + volume ─────────────── */

/*
 * These take an `UpstreamRef`, never a bare name: a vendor reuses its node
 * name on every chain it serves, so a name-only selector sums them all. Two
 * families address an upstream under two label names — `rpc_endpoint_*` by
 * `endpoint_id`, `smartrouter_*` by `provider_address` — and both carry `spec`.
 */

/** `{spec, endpoint_id}` selector — the `rpc_endpoint_*` families. */
export function upstreamEndpointSelector(ref: UpstreamRef): PromQL {
  return selector({ spec: ref.spec, endpoint_id: ref.endpointId });
}

/** `{spec, provider_address}` selector — the `smartrouter_*` families. */
export function upstreamProviderSelector(ref: UpstreamRef): PromQL {
  return selector({ spec: ref.spec, provider_address: ref.endpointId });
}

/** histogram_quantile over ONE upstream's latency histogram (window scalar). */
export function qEndpointLatencyQuantile(
  quantile: number,
  ref: UpstreamRef,
  window: MetricWindow = DEFAULT_WINDOW,
): PromQL {
  if (recordedReadsFor(window)) {
    return promql`histogram_quantile(${quantile}, sum by (le) (${sot(promql`${RECORDED.endpointLatencyBucket}${upstreamEndpointSelector(ref)}`, rangeFor(window))}))`;
  }
  return promql`histogram_quantile(${quantile}, sum by (le) (rate(${ENDPOINT_METRICS.latencyBucket}${upstreamEndpointSelector(ref)}[${rangeFor(window)}])))`;
}

/** Latency-quantile series for one upstream. */
export function qEndpointLatencySeriesExpr(
  quantile: number,
  ref: UpstreamRef,
  step: string,
  window?: MetricWindow,
): PromQL {
  if (recordedSeriesFor(window)) {
    return promql`histogram_quantile(${quantile}, sum by (le) (${aot(promql`${RECORDED.endpointLatencyBucket}${upstreamEndpointSelector(ref)}`, step)}))`;
  }
  return promql`histogram_quantile(${quantile}, sum by (le) (rate(${ENDPOINT_METRICS.latencyBucket}${upstreamEndpointSelector(ref)}[${rateRange(step)}])))`;
}

/**
 * A latency-quantile series for EVERY endpoint of one chain - one series per
 * `endpoint_id`, so an upstream can be read against its peers on one chart.
 */
export function qEndpointLatencyByEndpointSeriesExpr(
  quantile: number,
  spec: string,
  lookback: string,
  presence: string,
  window?: MetricWindow,
): PromQL {
  // Only where the upstream was scraped in the last `presence`: a quantile
  // over `lookback` would otherwise carry the last value that far into a
  // stretch with no data at all.
  if (recordedSeriesFor(window)) {
    const seen = promql`sum by (endpoint_id) (count_over_time(${RECORDED.endpointLatencyBucket}${selector({ spec, le: "+Inf" })}[${duration(presence)}])) > 0`;
    return promql`histogram_quantile(${quantile}, sum by (le, endpoint_id) (${aot(promql`${RECORDED.endpointLatencyBucket}${selector({ spec })}`, lookback)})) and on (endpoint_id) (${seen})`;
  }
  const seen = promql`sum by (endpoint_id) (count_over_time(${ENDPOINT_METRICS.latencyBucket}${selector({ spec, le: "+Inf" })}[${duration(presence)}])) > 0`;
  return promql`histogram_quantile(${quantile}, sum by (le, endpoint_id) (rate(${ENDPOINT_METRICS.latencyBucket}${selector({ spec })}[${duration(lookback)}]))) and on (endpoint_id) (${seen})`;
}

/**
 * Requests per second for every upstream of one chain, one series per
 * upstream: the `rateWindow` rates averaged over `lookback`, at `step`. An
 * average of what is THERE - one long `rate()` divides by the whole lookback
 * whatever part of it holds data, so after any stretch with no scrapes (a
 * router restarting, a laptop asleep) its line slides to zero and climbs
 * back for a whole lookback, traffic that never changed. Only where the
 * upstream was scraped in the last `rateWindow`, so a gap is a gap.
 */
export function qUpstreamRpsByUpstreamSeriesExpr(spec: string, lookback: string, rateWindow: string, step: string, window?: MetricWindow): PromQL {
  if (recordedSeriesFor(window)) {
    const rm = promql`${RECORDED.requestsByProvider}${selector({ spec })}`;
    return promql`avg_over_time((sum by (provider_address) (${rm}))[${duration(lookback)}:${duration(step)}]) and on (provider_address) (sum by (provider_address) (count_over_time(${rm}[${duration(rateWindow)}])) > 0)`;
  }
  const m = promql`${ROUTER_METRICS.requestsTotal}${selector({ spec })}`;
  return promql`avg_over_time((sum by (provider_address) (rate(${m}[${duration(rateWindow)}])))[${duration(lookback)}:${duration(step)}]) and on (provider_address) (sum by (provider_address) (count_over_time(${m}[${duration(rateWindow)}])) > 0)`;
}

/** One upstream's request-volume series (router scope). */
export function qUpstreamVolumeSeriesExpr(ref: UpstreamRef, step: string, window?: MetricWindow): PromQL {
  if (recordedSeriesFor(window)) {
    return promql`sum(${sot(promql`${RECORDED.requestsByProvider}${upstreamProviderSelector(ref)}`, step)}) * ${K}`;
  }
  return promql`sum(${countOverStep(promql`${ROUTER_METRICS.requestsTotal}${upstreamProviderSelector(ref)}`, step)})`;
}

/** One upstream's READ-volume series (requests_read_total is real). */
export function qUpstreamReadVolumeSeriesExpr(ref: UpstreamRef, step: string): PromQL {
  return promql`sum(${countOverStep(promql`${ROUTER_METRICS.requestsReadTotal}${upstreamProviderSelector(ref)}`, step)})`;
}

/**
 * One upstream's failed tries per bucket - its requests minus its successes
 * (an upstream's JSON-RPC error reply counts as a success here). `single`:
 * one read over the `step` just past (the error bar still filling).
 */
export function qUpstreamFailedSeriesExpr(ref: UpstreamRef, step: string, window?: MetricWindow, single = false): PromQL {
  const sel = upstreamProviderSelector(ref);
  if (recordedSeriesFor(window)) {
    const tot = promql`sum(${sot(promql`${RECORDED.requestsByProvider}${sel}`, step)})`;
    const ok = promql`sum(${sot(promql`${RECORDED.successByProvider}${sel}`, step)})`;
    return promql`round(clamp_min((${tot} - (${ok} or ${tot} * 0)) * ${K}, 0))`;
  }
  const tot = promql`sum(${countOverStep(promql`${ROUTER_METRICS.requestsTotal}${sel}`, step, single)})`;
  const ok = promql`sum(${countOverStep(promql`${ROUTER_METRICS.requestsSuccessTotal}${sel}`, step, single)})`;
  // The success counter exists only after a first success: without it every try failed.
  return roundWhole(promql`clamp_min(${tot} - (${ok} or ${tot} * 0), 0)`, step, single);
}

/** One upstream's JSON-RPC error replies per bucket - absent until the family fires. `single` as above. */
export function qUpstreamNodeErrorSeriesExpr(ref: UpstreamRef, step: string, single = false): PromQL {
  return roundWhole(promql`sum(${countOverStep(promql`${OPTIONAL_METRICS.nodeErrorsTotal}${upstreamProviderSelector(ref)}`, step, single)})`, step, single);
}

/** One upstream's relays over the window (router scope), unrounded. */
export function qUpstreamRequestsTotal(ref: UpstreamRef, window: MetricWindow = DEFAULT_WINDOW): PromQL {
  const sel = upstreamProviderSelector(ref);
  if (recordedReadsFor(window)) {
    return promql`sum(${sot(promql`${RECORDED.requestsByProvider}${sel}`, rangeFor(window))}) * ${K}`;
  }
  return promql`sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${rangeFor(window)}]))`;
}

/** One upstream's success / total over the window (router scope), clamped to 1 as `qAvailability` is. */
export function qUpstreamAvailability(ref: UpstreamRef, window: MetricWindow = DEFAULT_WINDOW): PromQL {
  const sel = upstreamProviderSelector(ref);
  const r = rangeFor(window);
  if (recordedReadsFor(window)) {
    return promql`clamp_max(sum(${sot(promql`${RECORDED.successByProvider}${sel}`, r)}) / sum(${sot(promql`${RECORDED.requestsByProvider}${sel}`, r)}), 1)`;
  }
  return promql`clamp_max(sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}])) / sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}])), 1)`;
}

/** One upstream's failed relays over the window (total − success, whole, ≥ 0). */
export function qUpstreamFailedCount(ref: UpstreamRef, window: MetricWindow = DEFAULT_WINDOW): PromQL {
  const sel = upstreamProviderSelector(ref);
  const r = rangeFor(window);
  if (recordedReadsFor(window)) {
    return promql`round(clamp_min((sum(${sot(promql`${RECORDED.requestsByProvider}${sel}`, r)}) - sum(${sot(promql`${RECORDED.successByProvider}${sel}`, r)})) * ${K}, 0))`;
  }
  return promql`round(clamp_min(sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}])) - sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}])), 0))`;
}

/** Per-upstream error rate over the window (router scope). */
export function qUpstreamErrorRate(
  ref: UpstreamRef,
  window: MetricWindow = DEFAULT_WINDOW,
): PromQL {
  const sel = upstreamProviderSelector(ref);
  const r = rangeFor(window);
  if (recordedReadsFor(window)) {
    return promql`1 - (sum(${sot(promql`${RECORDED.successByProvider}${sel}`, r)}) / sum(${sot(promql`${RECORDED.requestsByProvider}${sel}`, r)}))`;
  }
  return promql`1 - (sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}])) / sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}])))`;
}

/* ── Health / block-lag / scores / gauges ────────────────────────────────── */

/** Block lag per endpoint: spec-max latest block − each endpoint's block. */
export function qBlockLagByEndpoint(spec?: string): PromQL {
  const sel = selector({ spec });
  return promql`max by (spec) (${ENDPOINT_METRICS.latestBlock}${sel}) - on(spec) group_right() ${ENDPOINT_METRICS.latestBlock}${sel}`;
}

/* ── Block tips (latest block per router / per upstream) ─────────────────── */

/**
 * The TIP-STALENESS window. Long enough that a slow chain's normal inter-block
 * gap doesn't read as frozen, short enough that a genuinely stuck endpoint
 * surfaces within a poll or two.
 */
export const TIP_WINDOW = duration("15m");

/** `TIP_WINDOW` in seconds, for the "did this chain produce blocks?" test. */
export const TIP_WINDOW_SECONDS = 15 * 60;

/**
 * Chain block RATE in blocks/sec, from the per-endpoint gauge (which advances
 * every poll — the router gauge is far coarser, see `qRouterTips`).
 *
 * This is the unit converter that makes a block delta comparable ACROSS chains:
 * APT1 moves ~28 versions/sec and ETH1 ~0.08 blocks/sec, so a raw "7000 blocks
 * behind" is 4 minutes on one chain and four centuries on the other. Every
 * `behind` number the UI shows in seconds is a block delta divided by this.
 */
export function qBlockRateBySpec(spec?: string): PromQL {
  return promql`max by (spec) (deriv(${ENDPOINT_METRICS.latestBlock}${selector({ spec })}[${TIP_WINDOW}]))`;
}

/** Best (highest) upstream tip per chain — the reference every lag measures against. */
export function qBestTipBySpec(spec?: string): PromQL {
  return promql`max by (spec) (${ENDPOINT_METRICS.latestBlock}${selector({ spec })})`;
}

/**
 * Router tips split by DEPLOYMENT and interface.
 *
 * `smartrouter_latest_block` carries only `{spec, apiInterface}` — the router
 * labels its series with the chain, not with itself — so two deployments
 * serving one chain are told apart solely by the scrape target label
 * (`ROUTER_SCOPE_LABEL`, `service` under the Prometheus Operator). Grouping BY
 * that label is what turns one flattened number into a row per router; an
 * invalid or absent label degrades to the interface-only split rather than
 * emitting a query Prometheus rejects.
 *
 * ⚠ This gauge refreshes far more coarsely than the per-endpoint one (it moves
 * on accepted tip observations, not on every poll), so its delta against the
 * best upstream is dominated by refresh cadence on fast chains. Report it in
 * SECONDS (see `qBlockRateBySpec`), never as a raw block count.
 */
export function qRouterTips(scopeLabel?: string, spec?: string): PromQL {
  const by = scopeLabel && isValidScopeLabelName(scopeLabel)
    ? promql`${labelName(scopeLabel)}, spec, apiInterface`
    : promql`spec, apiInterface`;
  return promql`max by (${by}) (${ROUTER_METRICS.latestBlock}${selector({ spec })})`;
}

/**
 * The tip every endpoint of one chain reports, one series per `endpoint_id`
 * (its highest interface) - the highest it reached within each `step`, so a
 * sample between two scrapes can't hide a tip that moved.
 */
export function qEndpointTipsSeriesExpr(spec: string, step: string): PromQL {
  return promql`max by (endpoint_id) (max_over_time(${ENDPOINT_METRICS.latestBlock}${selector({ spec })}[${rateRange(step)}]))`;
}

/** Per-upstream tips, keeping the interface split a per-endpoint_id roll-up loses. */
export function qUpstreamTips(spec?: string): PromQL {
  return promql`max by (spec, endpoint_id, apiInterface) (${ENDPOINT_METRICS.latestBlock}${selector({ spec })})`;
}

/**
 * How many times each ROUTER tip changed over `TIP_WINDOW` — i.e. the gauge's
 * own refresh cadence, which is the yardstick its lag has to be judged against.
 *
 * `smartrouter_latest_block` moves on accepted tip observations, not on every
 * poll, so it sits a refresh-interval behind the upstream gauge BY CONSTRUCTION.
 * Comparing it to a fixed seconds threshold paints every healthy router amber;
 * comparing it to `TIP_WINDOW ÷ changes` asks the only question that matters —
 * is this router further behind than its own update rate explains?
 */
export function qRouterTipChanges(scopeLabel?: string, spec?: string): PromQL {
  const by = scopeLabel && isValidScopeLabelName(scopeLabel)
    ? promql`${labelName(scopeLabel)}, spec, apiInterface`
    : promql`spec, apiInterface`;
  return promql`max by (${by}) (changes(${ROUTER_METRICS.latestBlock}${selector({ spec })}[${TIP_WINDOW}]))`;
}

/**
 * How many times each upstream tip CHANGED over `TIP_WINDOW`. Zero means the
 * gauge is frozen — but only counts as stale once the chain is fast enough to
 * have produced blocks in that window (the caller pairs this with
 * `qBlockRateBySpec`), otherwise every Bitcoin poll would flag stale.
 */
export function qTipChanges(spec?: string): PromQL {
  return promql`changes(${ENDPOINT_METRICS.latestBlock}${selector({ spec })}[${TIP_WINDOW}])`;
}

/** A label name Prometheus accepts in a `by (…)` clause. Mirrors `scope.ts`. */
function isValidScopeLabelName(label: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label);
}

/** Block-lag series for ONE upstream: its chain's best tip − its own. */
export function qEndpointBlockLagSeriesExpr(ref: UpstreamRef): PromQL {
  return promql`max(${ENDPOINT_METRICS.latestBlock}${selector({ spec: ref.spec })}) - max(${ENDPOINT_METRICS.latestBlock}${upstreamEndpointSelector(ref)})`;
}

/** Specs whose every provider is blocked (bool per spec). */
export function qChainDown(): PromQL {
  return promql`min by (spec) (${ROUTER_METRICS.csmProviderBlocked}) == bool 1`;
}

/** Selection-score expression (gauge; also valid for query_range series). */
export function qScoreExpr(
  scoreType: string,
  spec?: string,
  endpointId?: string,
): PromQL {
  return promql`avg(${ENDPOINT_METRICS.selectionScore}${selector({ spec, endpoint_id: endpointId, score_type: scoreType })})`;
}

/** Optimizer-scope composite score per spec (no apiInterface label). */
export function qOptimizerScore(scoreType: string, spec?: string): PromQL {
  return promql`avg(${OPTIMIZER_METRICS.selectionScore}${selector({ spec, score_type: scoreType })})`;
}

/**
 * Optimizer-scope selection scores keyed PER ENDPOINT — the roster's QoS.
 *
 * The router computes one set of scores per upstream and publishes it through
 * two gauges. `rpc_endpoint_selection_score` is written by the routing path, so
 * it only appears once a relay has been routed and only covers the candidates
 * of that selection (backups sit in a separate pool consulted on fallback, so
 * they are usually absent from it entirely). `rpc_optimizer_selection_score` is
 * written by a sampler that walks EVERY registered upstream on a timer, fed by
 * the router's proactive probe loop — so it is there with no traffic at all.
 *
 * The numbers are the same numbers: both gauges are filled from one iteration
 * of the optimizer's `CalculateProviderScores`, from the same locals. This is
 * the same family `qOptimizerScore` reads for the chain-level series; the only
 * difference here is that the rows are kept per `endpoint_id` instead of
 * averaged, and every `score_type` comes back in one query.
 *
 * It carries no `apiInterface` label (one optimizer per chain), which suits the
 * roster: rows are keyed by `endpoint_id` alone, so the per-interface gauge
 * would silently let one interface's score overwrite another's.
 */
export function qOptimizerScoresByEndpoint(spec?: string): PromQL {
  return promql`${OPTIMIZER_METRICS.selectionScore}${selector({ spec })}`;
}

/**
 * Latest-block poll outcomes per endpoint over the window — the liveness a
 * zero-traffic upstream can still be judged by.
 *
 * `kind` picks the counter: successes or failures. Both are incremented by the
 * per-endpoint chain tracker, which polls every configured upstream (backups
 * included) whether or not anything routes to it.
 *
 * ⚠ Zero on BOTH counters means "not polled in this window", NOT "healthy" and
 * not "down": the tracker has a gate that suppresses a poll when served traffic
 * or a peer's poll already refreshed the tip. A caller must treat the
 * both-zero case as unknown rather than reading 0 failures as good news.
 */
export function qEndpointPolls(
  kind: "ok" | "failed",
  spec?: string,
  window: MetricWindow = DEFAULT_WINDOW,
): PromQL {
  const metric =
    kind === "ok" ? ENDPOINT_METRICS.fetchLatestSuccess : ENDPOINT_METRICS.fetchLatestFails;
  // `spec` in the by-clause: the roster joins rows on (upstream × chain), and
  // a poll row without it became a second, chain-less copy of every upstream.
  return promql`sum by (endpoint_id, spec) (increase(${metric}${selector({ spec })}[${rangeFor(window)}]))`;
}

/**
 * Consistency checks RUN over the window (smartrouter_consistency_total =
 * "relay requests that enforced a minimum seen block").
 */
export function qConsistencyChecked(
  window: MetricWindow = DEFAULT_WINDOW,
  offset?: string,
  spec?: string,
): PromQL {
  return promql`round(sum(increase(${ROUTER_METRICS.consistencyTotal}${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/**
 * Stale responses actually CAUGHT = consistency checks that FAILED
 * (smartrouter_consistency_failed_total — lazily registered; absent family
 * means zero failures, not "unknown"). NOTE: consistency_success_total counts
 * checks that PASSED — using it here would report every healthy read as a
 * "caught stale response" (the bug this replaced).
 */
export function qConsistencyCaught(
  window: MetricWindow = DEFAULT_WINDOW,
  offset?: string,
  spec?: string,
): PromQL {
  return promql`round(sum(increase(smartrouter_consistency_failed_total${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/** The four csm_* gauges in one instant query. */
export function qCsm(): PromQL {
  return promql`{__name__=~"${ROUTER_METRICS.csmBlockedProviders}|${ROUTER_METRICS.csmBlockedBackupProviders}|${ROUTER_METRICS.csmReportedProviders}|${ROUTER_METRICS.csmStickySessions}"}`;
}

/** Presence probe: non-empty result ⇒ the family is registered/emitted. */
export function qPresence(metricName: string): PromQL {
  return promql`count({__name__=${promString(metricName)}})`;
}

/** `{spec="…"}` with the value quoted as a PromQL string, so no value can close the matcher; empty without a spec. */
function specMatcher(spec?: string): PromQL {
  return selector({ spec });
}

/**
 * Failed tries (no usable answer) per chain and provider in each `step`
 * stretch - the Errors tab's incidents (`detectErrorIncidents`). A `spec`
 * reads that chain's series only.
 */
export function qFailedTriesBySpecProvider(step: string, spec?: string): PromQL {
  return promql`sum by (spec, provider_address) (increase(${OPTIONAL_METRICS.requestsFailedTotal}${specMatcher(spec)}[${duration(step)}]))`;
}

/**
 * `qFailedTriesBySpecProvider` from the recorded relays per provider, for
 * long windows: a month of the raw failed counters on a large deployment is
 * a read of seconds. Each try is counted on the total and on exactly one of
 * success or failed, with the same labels, so a provider's tries minus its
 * successes are its failed tries, a minute earlier (see recorded.ts); a
 * provider with no success series failed every try (`or … * 0`). Rounded per
 * stretch, as the recorded failed-tries bars are.
 */
export function qFailedTriesBySpecProviderRecorded(step: string, spec?: string): PromQL {
  const sel = specMatcher(spec);
  const tot = promql`sum by (spec, provider_address) (${sot(promql`${RECORDED.requestsByProvider}${sel}`, step)})`;
  const ok = promql`sum by (spec, provider_address) (${sot(promql`${RECORDED.successByProvider}${sel}`, step)})`;
  return promql`round(clamp_min((${tot} - (${ok} or ${tot} * 0)) * ${K}, 0))`;
}

/**
 * Recorded samples in each `step` stretch, the most any series of the chain
 * has: one a minute where the ruler evaluated every minute of the stretch.
 * Fewer is a stretch the ruler skipped minutes of (a store restart, say),
 * whose increments the recorded series never hold - while the raw counters
 * do, since the collector delivers its samples late after an outage and the
 * ruler doesn't go back.
 */
export function qRecordedSamplesPerStep(step: string, spec?: string): PromQL {
  return promql`max(count_over_time(${RECORDED.requestsByProvider}${specMatcher(spec)}[${duration(step)}]))`;
}

/** Provider error replies per chain and provider in each `step` stretch - the incidents' other kind. */
export function qErrorRepliesBySpecProvider(step: string, spec?: string): PromQL {
  return promql`sum by (spec, provider_address) (increase(${OPTIONAL_METRICS.nodeErrorsTotal}${specMatcher(spec)}[${duration(step)}]))`;
}
