# Metrics Mapping — UI value → real Prometheus series

Source of truth is a **live `/metrics` scrape**, not the `../SR_Dashboard/*.md`
design docs. Those docs use the prefix `lava_rpcsmartrouter_*`; the real build
emits `smartrouter_*` / `rpc_endpoint_*` / `rpc_optimizer_*`. The catalog lives
in `packages/shared/src/constants/metrics.ts`; the typed query builders in
`packages/shared/src/promql/builders.ts`.

> **Scrape the router exactly once.** Every query aggregates with `sum()`, so if
> Prometheus scrapes the same router through two targets (e.g. `router:7779`
> *and* `host.docker.internal:7779`), all counts double. `deploy/prometheus.yml`
> uses a single `host.docker.internal:7779` target for that reason.

## Label conventions

| UI concept | Prometheus label |
|---|---|
| Chain | `spec` (e.g. `ETH1`) |
| Provider (backing endpoint) | `provider_address` (router scope) / `endpoint_id` (endpoint scope) — both carry the resolved provider name |
| API interface | `apiInterface` (`jsonrpc`, `rest`, `tendermintrpc`, `grpc`) |
| Method | `method` on `requests_*`; latency histogram uses `function` instead |
| Selection score axis | `score_type ∈ {availability, latency, sync, stake, composite}` |
| Time window | PromQL range from the 13-window catalog (`constants/windows.ts`) — scalars use `increase(m[$range])`, series use `rate(m[$step])` via `query_range`; prior-window KPIs add `offset $range` |

## Confirmed real series (this build)

**Router scope (`smartrouter_*`)** — labels `spec, apiInterface, method, provider_address`
unless noted:
`requests_total`, `requests_success_total`, `requests_read_total`,
`end_to_end_latency_milliseconds_{bucket,count,sum}` (`spec, apiInterface, function`),
`latest_block` (`spec, apiInterface`), `overall_health` (no labels),
`consistency_total`, `consistency_success_total`, `total_relays_serviced`,
`csm_{blocked_providers,blocked_backup_providers,reported_providers,sticky_sessions}`,
`protocol_version`.

**Endpoint scope (`rpc_endpoint_*`)** — labels include `endpoint_id`:
`overall_health`, `latest_block`, `selection_score` (+ `score_type`),
`requests_in_flight`, `total_relays_serviced`, `fetch_latest_success`,
`end_to_end_latency_milliseconds_*`.

**Optimizer scope:** `rpc_optimizer_selection_score` (`spec, endpoint_id, score_type`).

## Absent-until-fired families & the presence probe

The router registers several families **only once the feature fires** — they
are simply missing from `/metrics` until then. They're catalogued in
`OPTIONAL_METRICS`, and the API probes each one at read time with

```promql
qPresence(name) = count({__name__="<name>"})
```

A non-empty result ⇒ the family is registered on this build. Until then the
API returns `null` / empty **plus an explicit flag** — `emitted: false`
(`HeroSummary`, `CrossValidationReport`, `WebSocketReport`, `ProviderDetail`),
`families.*: false` (`ErrorsReport`), `classTotals.emitted.*`
(`/api/metrics/methods`) — and the UI renders the design's own empty states.
**Panels light up automatically the first time a family appears**; no code
change or redeploy needed.

## Counter semantics — ground truth (verified by controlled experiment)

Established 2026-07-08 with an exact known load (90s idle fingerprint + 40
client requests) against the live router:

- **`smartrouter_requests_total` counts RELAYS, not client requests.** A
  2-participant cross-validated request increments it twice (one per
  `provider_address`; ≡ `total_relays_serviced`), cache-served requests appear
  as `provider_address="Cached"`, and the router's own chain-tracker/probe
  traffic lands in it while fully idle. Use it ONLY for per-provider/relay
  lenses.
- **`smartrouter_end_to_end_latency_milliseconds_count` is the client-request
  counter** — exactly one increment per client request (matched 40/40; flat at
  idle), labels `{spec, apiInterface, function}` where `function` = the method.
  Every "requests served"/per-chain/per-method/RPS figure reads THIS.
- **`requests_success_total` is TRANSPORT success** — an upstream answering
  with a JSON-RPC error object (e.g. `-32601`) still counts as success (it
  increments `node_errors_total` instead). "Success rate" tooltips say so.
  Derived errors (`total − success`) therefore = transport/routing failures.
- **`consistency_total`** = reads that enforced a minimum seen block;
  **`consistency_success_total`** = checks that PASSED; stale responses caught
  = **`consistency_failed_total`** (lazily registered — absent family means
  zero failures, not "unknown").
- Unknown methods are forwarded and minted as `Default-<method>` label values
  (unbounded caller-controlled cardinality — flagged to the router team).

## UI value → query

| UI value | Builder (`@sr/shared/promql`) |
|---|---|
| Requests served (client-scoped) | `qClientRequestsTotal(spec, window)` = `round(sum(increase(…latency_milliseconds_count[$w])))` |
| Requests by chain / method (client-scoped) | `qClientRequestsBy("spec" \| "function")` |
| Relays (per-provider lens only) | `qRequestsTotal(spec, window)` — see semantics above |
| Success rate / Availability | `qAvailability(spec, window)` = `clamp_max(success / total, 1)` — the clamp guards against `increase()` extrapolation pushing the ratio above 1 on a counter younger than the window (would render as a >100% success rate) |
| Error rate | `qErrorRate(spec, window)` = `1 − qAvailability` — non-negative because availability is clamped ≤ 1 |
| Error count (derived, whole) | `qErrorCount` = `round(clamp_min(total − success, 0))` |
| Errors by chain/method/provider | `qErrorsBy(label)` — rounded; the `or … * 0` keeps all-error groups whose success series is absent |
| Node / protocol error counts | `qLabelledErrorsTotal` / `qLabelledErrorsBy` over `smartrouter_{node,protocol}_errors_total` `{spec, apiInterface, provider_address, method}` |
| P50/P95/P99 latency | `qLatencyQuantile(q, spec, window)` |
| **Per-method P95** | `qMethodLatencyQuantile(q, window, spec)` — the histogram's method label is named **`function`** (the "no method label" note in the design doc was wrong) |
| Latency distribution (buckets) | `qLatencyDistribution` = `sum by (le) (increase(…_bucket[$w]))` |
| RPS (client-scoped) | `qClientRps` / `qClientRpsSeriesExpr(step, spec)` = `sum(rate(…latency_milliseconds_count[step]))` |
| Per-chain / per-provider RPS stacks | `qPerSpecRpsExpr` / `qPerProviderRpsExpr` |
| Availability / error-rate series | `qAvailabilitySeriesExpr` (also `clamp_max(…, 1)`) / `qErrorRateSeriesExpr` / `qErrorCountSeriesExpr` |
| Latest block | `qLatestBlock(spec)` |
| QoS / per-endpoint scores | `qScoreExpr` (`rpc_endpoint_selection_score`) / `qOptimizerScore` (`rpc_optimizer_selection_score`) |
| Per-provider p95 | `qEndpointLatencyQuantile` — the **endpoint** histogram carries `endpoint_id` (the router histogram doesn't) |
| Provider volume (total/read) | `qProviderVolumeSeriesExpr` / `qProviderReadVolumeSeriesExpr` |
| Provider error rate | `qProviderErrorRate` (router counters by `provider_address`) |
| Block lag | `qBlockLagByEndpoint` / `qEndpointBlockLagSeriesExpr` = spec-max `latest_block` − endpoint's |
| Backup traffic share | `qBackupShareExpr(spec, backupNames, step)` — names from the helm config's `is_backup` |
| Chains fully down | `qChainDown()` = `max by (spec) (rpc_endpoint_overall_health) == bool 0` |
| Stale caught | `qConsistencyCaught` = `round(sum(increase(consistency_failed_total[$w])))` — failed checks; `qConsistencyChecked` = checks run. `consistency_success_total` counts checks that PASSED and must never surface as "caught" |
| Family present? | `qPresence(metricName)` |

## Endpoint → PromQL (what each route runs)

| Endpoint | Queries |
|---|---|
| `/api/metrics/specs` | `count by (spec) (smartrouter_requests_total)` |
| `/api/metrics/dashboard-summary` | `qRequestsTotal` + `qAvailability` + `qLatencyQuantile(0.95)` + stale-caught, each **twice** (current + `offset $range` prior); `count by (endpoint_id) (rpc_endpoint_overall_health)`; `smartrouter_overall_health`; retries/cache KPIs only when `qPresence` says the family exists. No cache on this build ⇒ the documented derived "effective read p95" reduces to the node read p95 (the overall router histogram). |
| `/api/metrics/overview` | KPI pairs (requests, 5m-rate RPS, availability, p50/95/99) + `qErrorCount` (both windows); `query_range` series for throughput / errors / p50/p95/p99; `qLatencyDistribution`; per-provider stack `sum by (provider_address) (rate(requests_total[step]))`; per-chain p50 + health + trend; active routes `sum by (endpoint_id, spec) (increase(rpc_endpoint_total_relays_serviced[$w]))` |
| `/api/metrics/dashboard` | `qRpsSeriesExpr`, `qErrorCountSeriesExpr`, `qErrorRateSeriesExpr`, `qAvailabilitySeriesExpr`, `qLatencySeriesExpr(q)`; per-chain `qPerSpecRpsExpr`, per-spec success ratio, per-spec `histogram_quantile` (the `(spec, le)` grouping of `qLatencyQuantile` with `[$range]→[$step]`); `qPerProviderRpsExpr`; per-provider p95 `histogram_quantile(0.95, sum by (endpoint_id, le) (rate(rpc_endpoint_…_bucket[step])))`; chain list from `count by (spec)` + `max by (spec) (rpc_endpoint_overall_health)` |
| `/api/metrics/chains` | per spec: `qRequestsTotal`, `qAvailability`, `qErrorRate`, `qLatencyQuantile(0.95)`, `avg(rpc_endpoint_selection_score{score_type="composite"})`, `max by (spec) (rpc_endpoint_overall_health)`, `qLatestBlock`, `count by (endpoint_id)` |
| `/api/metrics/providers` | `sum by (endpoint_id, spec) (increase(rpc_endpoint_total_relays_serviced[$w]))`; the `selection_score` / `overall_health` / `latest_block` / `requests_in_flight` gauges; per-endpoint p95 from the endpoint histogram; uptime + errorRate = success/total by `provider_address` on the router counters; blockLag computed as spec-max − endpoint block; `role`/`apiInterface` joined from the mounted config (not Prometheus) |
| `/api/metrics/rps` | `sum(rate(smartrouter_requests_total{spec?}[step]))` via `query_range` |
| `/api/metrics/traffic` | aggregate + per-spec `rate` series; per-chain totals + shares from `qRequestsTotal` |
| `/api/metrics/methods` | `qRequestsBy("method")`; read-set from `sum by (method) (increase(requests_read_total[$w]))`; `qErrorsBy("method")`; class totals + `qPresence` probes for write/batch |
| `/api/metrics/chain-series` | `qAvailabilitySeriesExpr`, `qLatencySeriesExpr(0.95)`, `qErrorRateSeriesExpr`, `qRpsSeriesExpr`; QoS = `qOptimizerScore("composite")`, falling back to `qScoreExpr` (endpoint scope), null when both empty; `qBackupShareExpr` only when the config marks backups |
| `/api/metrics/provider-detail` | router counters scoped by `provider_address` (requests, 5m RPS, availability, `qProviderErrorRate`); `qEndpointLatencyQuantile` + per-quantile series; `qProviderVolumeSeriesExpr` + read variant; `selection_score` gauge + a series per **emitted** score type; `qEndpointBlockLagSeriesExpr`; `qPresence` on node/protocol error counters (gates the errors-by-code panel) |
| `/api/metrics/errors` | `qErrorCount` + `qErrorCountSeriesExpr`; pivots via `qErrorsBy("spec"/"method")`; hotspots = `clamp_min(total − success, 0)` grouped by `(spec, provider_address)` (with the `or … * 0` guard); per-hotspot trend series for the top 5 only (bounded fan-out); `qPresence` on the three error families |
| `/api/metrics/unavailable` | `qChainDown()` |
| `/api/metrics/cross-validation` | `qPresence(smartrouter_cross_validation_requests_total)` — the REAL family names are `…cross_validation_{requests,success,failed,failures}_total` (+`provider_{agreements,disagreements}_total`; there is NO bare `…cross_validation_total`). When present: rounds/consensus per spec, `failures_total{reason}` breakdown, disagreements = `reason="no-agreement"`. **Always**: consistency `total` (checks run) + `caught` (`consistency_failed_total`, 0 when never fired) |
| `/api/metrics/websocket` | `qPresence(smartrouter_ws_subscriptions_total)`; when present: **lifetime totals** (instant `sum(…)`, labelled "since router start") — windowed `increase()` misses a young counter's first increment (counter birth), which read as "0 subscriptions" right after a real one |
| `/api/metrics/query` | whatever you pass — raw instant query, GET-bounded |

## Gaps — absent on this build (nulls + `emitted:false`, never invented)

These families aren't registered until the feature fires. The middle column is
what the API serves **meanwhile**; each family is a candidate **PR against
`smart-router`** to emit the series (a separate PR per family, in a worktree so
as not to disturb the other agent's checkout):

| Family (`OPTIONAL_METRICS`) | API meanwhile | Panels it would light up |
|---|---|---|
| `cache_total_{hits,misses}` | `dashboard-summary.cacheOffloadPct = {null,null}` + `emitted.cache:false`; `dashboard.cacheHitRate: null` | Cache offload / hit rate |
| `smartrouter_retries_{total,success}_total` | `dashboard-summary.retriesRecovered = {null,null}` + `emitted.retries:false` | "Recovered by retries" hero card |
| `smartrouter_hedge_total` | `dashboard.kpis.errorsHandled: {null,null}`; `errorsHandledBreakdown`/`failoverRatio`/`internalAvailability`/`contribution: null` | Errors-handled / hedge win / failover panels |
| `smartrouter_cross_validation_{requests,success,failed,failures}_total` + `provider_{agreements,disagreements}_total` | `/cross-validation` → `emitted:false`, null rounds/consensus/disagreements, empty `byChain` (`consistency` stays real). Fires on the first policy-matched request | Cross-validation panel + per-upstream disagreement rate |
| `smartrouter_{node,protocol}_errors_total` `{spec, apiInterface, provider_address, method}` | when absent: zero node/protocol errors in `errors.pivots.category` + `upstream-detail.errorSplit`; when present: category pivot, per-hotspot `nodeMethods`, upstream node-vs-transport split all light up. `pivots.code` stays `[]` — there is **no `code` label** on these counters | Error classes, node-errors-by-method |
| `smartrouter_consistency_failed_total` | absent ⇒ `staleCaught`/`consistency.caught` = 0 (a true zero — the check never failed) | "Stale responses caught" tile |
| `smartrouter_requests_{write,batch}_total` | `methods.classTotals.{write,batch}: null` + `emitted` flags; `upstream-detail.volume.{write,batch}: null` | Read/write/batch class split |
| `smartrouter_ws_{connections_active,subscriptions_total,subscription_errors_total}` | `/websocket` → `emitted:false` + nulls; once present, totals are lifetime | WebSocket panel |

> **Per-method P95 is no longer a gap**: the router histogram's method label
> is named `function` — `qMethodLatencyQuantile` reads it directly.

> **Per-provider P95 is no longer a gap**: it's sourced from
> `rpc_endpoint_end_to_end_latency_milliseconds_bucket` (which carries
> `endpoint_id`) instead of the router histogram (which has no
> `provider_address`).

**Not metrics at all** (Magma Cloud concepts — the API pins them null, the UI
shows honest "not tracked" states): compute-unit quota (`computeUnits`, `scu`),
RPS cap, `regions` (no region label on any series), team members / invites /
audit events, endpoint JWTs / last-used.
