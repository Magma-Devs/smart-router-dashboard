# Metrics Mapping — UI value → real Prometheus series

Source of truth is a **live `/metrics` scrape**, not the `../SR Dashboard/*.md`
design docs. Those docs use the prefix `lava_rpcsmartrouter_*`; the real build
emits `smartrouter_*` / `rpc_endpoint_*` / `rpc_optimizer_*`. The catalog lives
in `packages/shared/src/constants/metrics.ts`.

## Label conventions

| UI concept | Prometheus label |
|---|---|
| Chain | `spec` (e.g. `ETH1`) |
| Provider (backing endpoint) | `provider_address` (router scope) / `endpoint_id` (endpoint scope) |
| API interface | `apiInterface` (`jsonrpc`, `rest`, `tendermintrpc`, `grpc`) |
| Method | `method` on `requests_*`; latency histogram uses `function` instead |
| Selection score axis | `score_type ∈ {availability, latency, sync, stake, composite}` |
| Time window | PromQL range — `rate(m[5m])`, `increase(m[$w])` |

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

## UI value → query

| UI value | Builder (`@sr/shared/promql`) |
|---|---|
| Requests served | `qRequestsTotal(spec, window)` |
| Success rate / Availability | `qAvailability(spec, window)` |
| Error rate | `qErrorRate(spec, window)` |
| P95 latency | `qLatencyQuantile(0.95, spec, window)` |
| RPS series | `rate(smartrouter_requests_total[step])` |
| Latest block | `qLatestBlock(spec)` |
| QoS / per-endpoint scores | `rpc_endpoint_selection_score{score_type=…}` |
| Provider requests | `rpc_endpoint_total_relays_serviced` |
| Provider / chain health | `*_overall_health` |

## Gaps — absent on this build (render `—`, never invent)

These families aren't registered until the feature fires. Each is a candidate
**PR against `smart-router`** to emit the series (a separate PR per family, in a
worktree so as not to disturb the other agent's checkout):

| Family | Panels it would light up | Metric to emit |
|---|---|---|
| `cache_*` | Cache offload / hit rate | `smartrouter_cache_{requests,success,failed}_total`, `cache_latency_milliseconds` |
| `retries_*` | "Successful retries" card | `smartrouter_retries_{total,success,failed}_total`, `retry_attempts` histogram |
| `hedge_*` | Hedge rate / win | `smartrouter_hedge_{total,success,failed}_total` |
| `cross_validation_*` | Correctness / disagreement | `smartrouter_cross_validation_*` (+ per-provider agree/disagree) |
| errors by layer/code | Errors tab, by-code panel | `smartrouter_errors_total{layer,code}` (bounded) or `node_/protocol_errors_total` |
| `requests_failed/write/batch_total` | Class split, error rate | emit alongside `requests_total` |
| `ws_*` | WebSocket panel | `smartrouter_ws_{connections_active,subscriptions_total,subscription_errors_total}` |
| latency `method`/`provider_address` labels | per-method / per-provider P95 | add bounded labels to `end_to_end_latency_milliseconds` |

> The histogram lacking `provider_address` is why per-provider P95 reads `—`;
> source it from `rpc_endpoint_end_to_end_latency_milliseconds` instead, or add
> the label upstream.
