/**
 * Smart Router Prometheus metric catalog — GROUND TRUTH.
 *
 * These names were captured from a live `~/projects/smart-router` build's
 * `/metrics` endpoint (router on :7779), NOT from the design-drop docs.
 *
 * ⚠️ The `SR Dashboard/*.md` docs say `lava_rpcsmartrouter_*`. The real build
 * emits a bare `smartrouter_*` prefix (router scope) plus `rpc_endpoint_*` /
 * `rpc_optimizer_*` (per-endpoint / optimizer scope). Always verify against a
 * live scrape, not the doc.
 *
 * Families absent here (cache/retries/hedge/cross-validation/errors/ws/write/
 * batch) are simply not registered until that feature fires — the API and UI
 * must degrade to "no data" rather than invent values.
 */

/** Router-scope counters/gauges (aggregated across all backing endpoints). */
export const ROUTER_METRICS = {
  requestsTotal: "smartrouter_requests_total",
  requestsSuccessTotal: "smartrouter_requests_success_total",
  requestsReadTotal: "smartrouter_requests_read_total",
  latencyBucket: "smartrouter_end_to_end_latency_milliseconds_bucket",
  latencyCount: "smartrouter_end_to_end_latency_milliseconds_count",
  latencySum: "smartrouter_end_to_end_latency_milliseconds_sum",
  latestBlock: "smartrouter_latest_block",
  overallHealth: "smartrouter_overall_health",
  consistencyTotal: "smartrouter_consistency_total",
  consistencySuccessTotal: "smartrouter_consistency_success_total",
  totalRelaysServiced: "smartrouter_total_relays_serviced",
  protocolVersion: "smartrouter_protocol_version",
  csmBlockedProviders: "smartrouter_csm_blocked_providers",
  csmBlockedBackupProviders: "smartrouter_csm_blocked_backup_providers",
  csmReportedProviders: "smartrouter_csm_reported_providers",
  csmStickySessions: "smartrouter_csm_sticky_sessions",
} as const;

/** Per-endpoint-scope metrics (label `endpoint_id` = the resolved provider name). */
export const ENDPOINT_METRICS = {
  overallHealth: "rpc_endpoint_overall_health",
  latestBlock: "rpc_endpoint_latest_block",
  selectionScore: "rpc_endpoint_selection_score",
  requestsInFlight: "rpc_endpoint_requests_in_flight",
  totalRelaysServiced: "rpc_endpoint_total_relays_serviced",
  fetchLatestSuccess: "rpc_endpoint_fetch_latest_success",
  latencyBucket: "rpc_endpoint_end_to_end_latency_milliseconds_bucket",
  latencyCount: "rpc_endpoint_end_to_end_latency_milliseconds_count",
  latencySum: "rpc_endpoint_end_to_end_latency_milliseconds_sum",
} as const;

/** Optimizer-scope selection score (no apiInterface label). */
export const OPTIMIZER_METRICS = {
  selectionScore: "rpc_optimizer_selection_score",
} as const;

/**
 * `score_type` values carried by `*_selection_score`. This is what makes the
 * QoS panels real on this build — the design doc wrongly called QoS "no metric".
 */
export const SCORE_TYPES = [
  "availability",
  "latency",
  "sync",
  "stake",
  "composite",
] as const;
export type ScoreType = (typeof SCORE_TYPES)[number];

/** Histogram bucket boundaries (ms) shared by every latency histogram. */
export const LATENCY_BUCKETS = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
] as const;

/**
 * Families the router registers only once the feature fires (absent from
 * `/metrics` until then). The API probes these with `qPresence()` and returns
 * `emitted: false` + nulls instead of inventing values; panels light up
 * automatically the first time a family appears.
 */
export const OPTIONAL_METRICS = {
  requestsFailedTotal: "smartrouter_requests_failed_total",
  requestsWriteTotal: "smartrouter_requests_write_total",
  requestsBatchTotal: "smartrouter_requests_batch_total",
  nodeErrorsTotal: "smartrouter_node_errors_total",
  protocolErrorsTotal: "smartrouter_protocol_errors_total",
  cacheTotalHits: "cache_total_hits",
  cacheTotalMisses: "cache_total_misses",
  retriesTotal: "smartrouter_retries_total",
  retriesSuccessTotal: "smartrouter_retries_success_total",
  hedgeTotal: "smartrouter_hedge_total",
  crossValidationTotal: "smartrouter_cross_validation_total",
  crossValidationSuccessTotal: "smartrouter_cross_validation_success_total",
  wsConnectionsActive: "smartrouter_ws_connections_active",
  wsSubscriptionsTotal: "smartrouter_ws_subscriptions_total",
  wsSubscriptionErrorsTotal: "smartrouter_ws_subscription_errors_total",
} as const;
