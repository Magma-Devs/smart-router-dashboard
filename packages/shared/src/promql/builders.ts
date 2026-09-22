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
import { DEFAULT_WINDOW, WINDOWS, type MetricWindow } from "../constants/windows.js";

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
  window: MetricWindow = DEFAULT_WINDOW,
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
  window: MetricWindow = DEFAULT_WINDOW,
  offset?: string,
): string {
  return `round(sum(increase(${ROUTER_METRICS.latencyCount}${selector({ spec })}[${rangeFor(window)}]${off(offset)})))`;
}

/** Client requests grouped by a label (`spec` or `function` = method). */
export function qClientRequestsBy(
  by: "spec" | "function",
  window: MetricWindow = DEFAULT_WINDOW,
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
  window: MetricWindow = DEFAULT_WINDOW,
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
  window: MetricWindow = DEFAULT_WINDOW,
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
  window: MetricWindow = DEFAULT_WINDOW,
  offset?: string,
): string {
  return `1 - (${qAvailability(spec, window, offset)})`;
}

/** histogram_quantile over the router latency histogram. */
export function qLatencyQuantile(
  quantile: number,
  spec?: string,
  window: MetricWindow = DEFAULT_WINDOW,
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
export function qEndpointRequests(spec?: string, window: MetricWindow = DEFAULT_WINDOW): string {
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
  window: MetricWindow = DEFAULT_WINDOW,
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
  window: MetricWindow = DEFAULT_WINDOW,
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
  window: MetricWindow = DEFAULT_WINDOW,
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
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): string {
  return `round(sum by (${by}) (increase(${metricName}${selector({ spec })}[${rangeFor(window)}])))`;
}

/** Total of a labelled error counter over the window (whole number). */
export function qLabelledErrorsTotal(
  metricName: string,
  window: MetricWindow = DEFAULT_WINDOW,
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
  // Case-INSENSITIVE on purpose. These names come from the mounted values file,
  // while `provider_address` carries the name the ROUTER was configured with —
  // a helm deployment renders one from the other and the case need not survive
  // (`Blockdaemon` in the values, `blockdaemon` on the series). A case-sensitive
  // match silently yields an empty numerator, which reads as "0% backup" rather
  // than "no data" (MAG-2537).
  const backupSel = `{spec="${spec}",provider_address=~"(?i)(${escaped.join("|")})"}`;
  return `sum(rate(${ROUTER_METRICS.requestsTotal}${backupSel}[${step}])) / sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[${step}]))`;
}

/* ── Endpoint-scope (per-upstream) latency + volume ──────────────────────── */

/** histogram_quantile over ONE endpoint's latency histogram (window scalar). */
export function qEndpointLatencyQuantile(
  quantile: number,
  endpointId: string,
  window: MetricWindow = DEFAULT_WINDOW,
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
  window: MetricWindow = DEFAULT_WINDOW,
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

/* ── Block tips (latest block per router / per upstream) ─────────────────── */

/**
 * The TIP-STALENESS window. Long enough that a slow chain's normal inter-block
 * gap doesn't read as frozen, short enough that a genuinely stuck endpoint
 * surfaces within a poll or two.
 */
export const TIP_WINDOW = "15m";

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
export function qBlockRateBySpec(spec?: string): string {
  return `max by (spec) (deriv(${ENDPOINT_METRICS.latestBlock}${selector({ spec })}[${TIP_WINDOW}]))`;
}

/** Best (highest) upstream tip per chain — the reference every lag measures against. */
export function qBestTipBySpec(spec?: string): string {
  return `max by (spec) (${ENDPOINT_METRICS.latestBlock}${selector({ spec })})`;
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
export function qRouterTips(scopeLabel?: string, spec?: string): string {
  const by = scopeLabel && isValidScopeLabelName(scopeLabel)
    ? `${scopeLabel}, spec, apiInterface`
    : "spec, apiInterface";
  return `max by (${by}) (${ROUTER_METRICS.latestBlock}${selector({ spec })})`;
}

/** Per-upstream tips, keeping the interface split a per-endpoint_id roll-up loses. */
export function qUpstreamTips(spec?: string): string {
  return `max by (spec, endpoint_id, apiInterface) (${ENDPOINT_METRICS.latestBlock}${selector({ spec })})`;
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
export function qRouterTipChanges(scopeLabel?: string, spec?: string): string {
  const by = scopeLabel && isValidScopeLabelName(scopeLabel)
    ? `${scopeLabel}, spec, apiInterface`
    : "spec, apiInterface";
  return `max by (${by}) (changes(${ROUTER_METRICS.latestBlock}${selector({ spec })}[${TIP_WINDOW}]))`;
}

/**
 * How many times each upstream tip CHANGED over `TIP_WINDOW`. Zero means the
 * gauge is frozen — but only counts as stale once the chain is fast enough to
 * have produced blocks in that window (the caller pairs this with
 * `qBlockRateBySpec`), otherwise every Bitcoin poll would flag stale.
 */
export function qTipChanges(spec?: string): string {
  return `changes(${ENDPOINT_METRICS.latestBlock}${selector({ spec })}[${TIP_WINDOW}])`;
}

/** A label name Prometheus accepts in a `by (…)` clause. Mirrors `scope.ts`. */
function isValidScopeLabelName(label: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label);
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
export function qOptimizerScoresByEndpoint(spec?: string): string {
  return `${OPTIMIZER_METRICS.selectionScore}${selector({ spec })}`;
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
): string {
  const metric =
    kind === "ok" ? ENDPOINT_METRICS.fetchLatestSuccess : ENDPOINT_METRICS.fetchLatestFails;
  return `sum by (endpoint_id) (increase(${metric}${selector({ spec })}[${rangeFor(window)}]))`;
}

/**
 * Consistency checks RUN over the window (smartrouter_consistency_total =
 * "relay requests that enforced a minimum seen block").
 */
export function qConsistencyChecked(
  window: MetricWindow = DEFAULT_WINDOW,
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
  window: MetricWindow = DEFAULT_WINDOW,
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
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): string {
  return `sum by (le) (increase(${ROUTER_METRICS.latencyBucket}${selector({ spec })}[${rangeFor(window)}]))`;
}

/** Presence probe: non-empty result ⇒ the family is registered/emitted. */
export function qPresence(metricName: string): string {
  return `count({__name__="${metricName}"})`;
}

/* ── Fault split — whose problem is it ──────────────────────────────────── */

/**
 * `error_name` prefix → owning layer, in `error_codes.go` order.
 *
 * The prefix set is CLOSED (`PROTOCOL_` / `NODE_` / `CHAIN_` / `USER_`), so a
 * name matching none of them is genuinely unnamed by the registry rather than a
 * gap in this table — which is why the caller buckets the remainder as
 * `unclassified` instead of picking a nearest match.
 */
export const FAULT_LAYER_PREFIX = {
  router: "PROTOCOL_",
  upstream: "NODE_",
  chain: "CHAIN_",
  caller: "USER_",
} as const;

/**
 * Classified errors grouped by `error_name` over the window.
 *
 * ⚠ `smartrouter_errors_total` keys on **`chain_id`**, not `spec` — it is the
 * one family that does, and it carries NO provider label. So this can answer
 * "what kind of failure" or (via `nodeErrorsTotal`) "which upstream", never
 * both at once.
 *
 * ⚠ NOT `increase()`. Each error code is its own series, born the first time
 * that code ever fires, and `increase()` cannot see a birth: with no prior
 * sample to subtract from, a series that appears mid-window at 11 and stays
 * there reads as **0**. Verified live — `USER_INVALID_PARAMS` sat at 11 events
 * while `increase(…[30m])` returned 0, hiding the entire caller-fault layer.
 *
 * That is the common case here rather than an edge one: a caller ships a bug,
 * fires a burst of invalid requests, someone fixes it — burst-then-silence is
 * exactly the shape `increase()` erases, and error codes fire in bursts by
 * nature.
 *
 * So: subtract the window-start value, and fall back to the current value for
 * any series with no window-start sample (`or` fills only series absent from
 * the left operand, which is precisely the born-inside-the-window set).
 */
export function qClassifiedErrorsByName(
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): string {
  const m = `${OPTIONAL_METRICS.errorsClassifiedTotal}${selector({ chain_id: spec })}`;
  const r = rangeFor(window);
  return `round(sum by (error_name) ((${m} - (${m} offset ${r})) or ${m}))`;
}

/* ── Per-upstream faults — which provider, on which chains ──────────────── */

/**
 * Errors an upstream RETURNED, by (provider, chain).
 *
 * This is the count a per-provider error rate normally misses: the upstream
 * answered, so the relay counts as a transport success, while the answer itself
 * was an error. On GK8 production this is where a provider's real breakage
 * lives — 635k/day on one (provider × chain) pair against 22 failed relays.
 */
export function qNodeErrorsByUpstream(
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
  offset?: string,
): string {
  return `round(sum by (provider_address, spec) (increase(${OPTIONAL_METRICS.nodeErrorsTotal}${selector({ spec })}[${rangeFor(window)}]${offset ? ` offset ${offset}` : ""})))`;
}

/** Relays to an upstream that never got an answer, by (endpoint, chain). */
export function qUnreachableByUpstream(
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): string {
  return `round(sum by (endpoint_id, spec) (increase(${ENDPOINT_METRICS.totalErrored}${selector({ spec })}[${rangeFor(window)}])))`;
}

/** Relays an upstream DID serve — the denominator for reachability. */
export function qRelaysServicedByUpstream(
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): string {
  return `round(sum by (endpoint_id, spec) (increase(${ENDPOINT_METRICS.totalRelaysServiced}${selector({ spec })}[${rangeFor(window)}])))`;
}

/** Classified error kinds per chain — the `what` that pairs with the `who`. */
export function qClassifiedErrorsByChainAndName(
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): string {
  const m = `${OPTIONAL_METRICS.errorsClassifiedTotal}${selector({ chain_id: spec })}`;
  const r = rangeFor(window);
  return `round(sum by (chain_id, error_name) ((${m} - (${m} offset ${r})) or ${m}))`;
}

/**
 * Peak sustained request rate an upstream actually achieved, per second.
 *
 * The estimate behind "this is roughly your ceiling": the highest one-minute
 * rate that got served before the upstream started refusing. It is a LOWER
 * BOUND on the real limit, never the limit itself — the provider publishes
 * that, we can only report the fastest we were let go.
 */
export function qPeakServedRateByUpstream(
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): string {
  const w = rangeFor(window);
  // Resolution follows the window: a 1-minute grid over a day is 1,440
  // evaluations per endpoint — past an ingress timeout on a real deployment —
  // and a ceiling estimate does not need minute precision over a day.
  const secs = WINDOWS[window].rangeSeconds;
  const res = secs <= 3 * 3600 ? "1m" : secs <= 86400 ? "5m" : "15m";
  return `max by (endpoint_id, spec) (max_over_time(rate(${ENDPOINT_METRICS.totalRelaysServiced}${selector({ spec })}[${res}])[${w}:${res}]))`;
}


/* ── Answered, but not usable ────────────────────────────────────────────
   The axis a failure-counter page cannot see. Every one of these fires while
   the upstream is returning HTTP 200 and every error counter reads zero. */

/**
 * Per-upstream tip movement over the window.
 *
 * ⚠ Deliberately NOT gated on `deriv(rpc_endpoint_latest_block)` by spec. That
 * reference is derived from the very gauges being tested, so a chain whose only
 * upstream is frozen yields a block rate of 0, and a staleness check built on it
 * concludes "blocks were not expected to move" and passes the frozen node. The
 * caller must compare this against a STATIC expected block time per chain.
 */
export function qTipMovement(window: MetricWindow = DEFAULT_WINDOW, spec?: string): string {
  return `changes(${ENDPOINT_METRICS.latestBlock}${selector({ spec })}[${rangeFor(window)}])`;
}

/** Current tip per upstream — the value the movement check is about. */
export function qTipNow(spec?: string): string {
  return `${ENDPOINT_METRICS.latestBlock}${selector({ spec })}`;
}

/**
 * Customer-visible requests slower than a ceiling, per chain.
 *
 * `_count` is client-scoped (one per customer request) and `le` must be one of
 * the histogram's own bucket edges. This is the only metric that can express
 * "served correctly, too late to be useful" — the case where our provider wait
 * and the caller's client timeout are both 10s, so four customer-visible
 * failures were recorded as four successes.
 */
export function qSlowerThan(
  leMs: number,
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
): string {
  const r = rangeFor(window);
  const sel = selector({ spec });
  const bucketSel = selector({ spec, le: String(leMs) });
  return `round(clamp_min(sum by (spec) (increase(${ROUTER_METRICS.latencyCount}${sel}[${r}])) - sum by (spec) (increase(${ROUTER_METRICS.latencyBucket}${bucketSel}[${r}])), 0))`;
}

/**
 * Requests answered within `leMs`, per chain — the cumulative bucket alone.
 * The complement of `qSlowerThan` for a caller that already holds the
 * per-chain request count: one family read instead of two, which on a large
 * deployment is the difference between a day-long window answering and not.
 * `offset` (e.g. `"7d"`) reads the same window that long ago.
 */
export function qAnsweredWithin(
  leMs: number,
  window: MetricWindow = DEFAULT_WINDOW,
  spec?: string,
  offset?: string,
): string {
  const r = rangeFor(window);
  const bucketSel = selector({ spec, le: String(leMs) });
  return `round(sum by (spec) (increase(${ROUTER_METRICS.latencyBucket}${bucketSel}[${r}]${offset ? ` offset ${offset}` : ""})))`;
}

/** Reads that enforced a minimum seen block, per chain. A flat zero is itself
 *  the finding: nothing on that chain is checking the answer's freshness. */
export function qFreshnessChecks(window: MetricWindow = DEFAULT_WINDOW, spec?: string): string {
  const r = rangeFor(window);
  return `round(sum by (spec) (increase(${ROUTER_METRICS.consistencyTotal}${selector({ spec })}[${r}])))`;
}

/**
 * Those checks that FAILED — a stale answer caught before it was served.
 *
 * Lazily registered: an absent family means zero failures, not "unknown". So an
 * empty result here is a true zero, whereas an empty `qFreshnessChecks` means
 * nothing on the chain is checking at all. The two empties say opposite things.
 */
export function qFreshnessCaught(window: MetricWindow = DEFAULT_WINDOW, spec?: string): string {
  const r = rangeFor(window);
  return `round(sum by (spec) (increase(${OPTIONAL_METRICS.consistencyFailedTotal}${selector({ spec })}[${r}])))`;
}

/**
 * The optimizer's own reasoning, per upstream and score type.
 *
 * This is the one metric that answers "why that provider and not the other" —
 * it is emitted on every deployment and nothing in the product reads it. It
 * detects nothing; it ADJUDICATES. A sync score sitting at 1.0 while the tip is
 * frozen says the optimizer never saw the staleness; a higher-scoring upstream
 * taking no traffic says selection ignored its own score.
 */
export function qSelectionScores(spec?: string): string {
  return `${ENDPOINT_METRICS.selectionScore}${selector({ spec })}`;
}

/** Each upstream's share of served traffic — the counterweight to the score. */
export function qServedShare(window: MetricWindow = DEFAULT_WINDOW, spec?: string): string {
  return `round(sum by (endpoint_id, spec) (increase(${ENDPOINT_METRICS.totalRelaysServiced}${selector({ spec })}[${rangeFor(window)}])))`;
}


/* ── Verification: is anything checking the answers, and who fails it ──── */

/**
 * Cross-validation rounds per chain, and those that FAILED with a reason.
 *
 * Lazily registered: the whole family is absent until cross-validation fires
 * for the first time, so callers probe presence first. On GK8 production it
 * has never registered — every verification there is the consistency check.
 */
export function qCrossValidationRounds(window: MetricWindow = DEFAULT_WINDOW, spec?: string): string {
  return `round(sum by (spec) (increase(${OPTIONAL_METRICS.crossValidationRequestsTotal}${selector({ spec })}[${rangeFor(window)}])))`;
}
export function qCrossValidationFailedByReason(window: MetricWindow = DEFAULT_WINDOW, spec?: string): string {
  return `round(sum by (spec, reason) (increase(${OPTIONAL_METRICS.crossValidationFailuresTotal}${selector({ spec })}[${rangeFor(window)}])))`;
}

/**
 * Per-provider agreements and disagreements — the one place a provider is
 * NAMED on a verification outcome. No attribution inference: the counter
 * carries `provider_address`. "Disagreed" means this provider's answer was the
 * one that did not match the quorum — it gave a different answer from its
 * peers to the same question.
 */
export function qCrossValidationDisagreementsByUpstream(window: MetricWindow = DEFAULT_WINDOW, spec?: string): string {
  return `round(sum by (spec, provider_address) (increase(${OPTIONAL_METRICS.crossValidationDisagreementsTotal}${selector({ spec })}[${rangeFor(window)}])))`;
}
export function qCrossValidationAgreementsByUpstream(window: MetricWindow = DEFAULT_WINDOW, spec?: string): string {
  return `round(sum by (spec, provider_address) (increase(${OPTIONAL_METRICS.crossValidationAgreementsTotal}${selector({ spec })}[${rangeFor(window)}])))`;
}
