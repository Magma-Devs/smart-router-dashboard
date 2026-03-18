# Dashboard Fix Plan — Metrics Rework Alignment

Scoped to **restoring the dashboard to a working state**. No new features.
Validated against actual Go source across all 4 PRs in the lava repo.

---

## What Each PR Breaks in the Dashboard

| PR | Branch | What it removes / renames | Dashboard impact |
|---|---|---|---|
| 1+2 | `feat/metrics-rework` → `main` | `lava_rpcsmartrouter_total_relays_serviced` | Traffic panels show 0 |
| 1+2 | `feat/metrics-rework` → `main` | `lava_rpcsmartrouter_total_errored` | Error data shows 0 |
| 1+2 | `feat/metrics-rework` → `main` | `lava_rpcsmartrouter_node_errors_received` | Recovery card shows 0 |
| 1+2 | `feat/metrics-rework` → `main` | `lava_rpcsmartrouter_node_errors_recovered` | Recovery card shows 0 |
| 1+2 | `feat/metrics-rework` → `main` | `function` label on traffic/error metrics → now `method` | Usage page method table empty |
| 3 | `metrics-cleanup` → `feat/metrics-rework` | `lava_rpc_endpoint_info` | Flow visualization: all router health shows unhealthy |

PR4 (`metrics-provider-only`) touches only provider-side metrics — no dashboard impact.

---

## Replacements Available in the New Metric Set

| Removed metric | Replacement | Label change |
|---|---|---|
| `lava_rpcsmartrouter_total_relays_serviced` | `lava_rpcsmartrouter_requests_total` | `function` → `method` (also adds `provider_address`, `apiInterface`) |
| `lava_rpcsmartrouter_total_errored` | `lava_rpcsmartrouter_requests_failed_total` | `function` → `method` |
| `lava_rpcsmartrouter_node_errors_received` | `lava_rpcsmartrouter_node_errors_total` | — |
| `lava_rpcsmartrouter_node_errors_recovered` | `lava_rpcsmartrouter_retries_success_total` | — |
| `lava_rpc_endpoint_info` (used for spec→job bridge) | `lava_rpcsmartrouter_overall_health_breakdown {spec, apiInterface}` | Direct spec label, no bridge needed |

**Important nuance:** `lava_rpcsmartrouter_end_to_end_latency_milliseconds` still exists and **still uses the `function` label** (`routerFunctionLabels`). Only the request and error counters moved to `method`.

---

## Changes Required

All changes are in a single file: **`backend/app/api/routes/metrics.py`**

---

### Fix 1 — Rename metrics in `PROMETHEUS_QUERIES` (lines 56–72)

```python
# Before
"router_traffic":       "lava_rpcsmartrouter_total_relays_serviced",
"router_errored":       "lava_rpcsmartrouter_total_errored",
"router_node_errors":   "lava_rpcsmartrouter_node_errors_received",
"router_node_recovered":"lava_rpcsmartrouter_node_errors_recovered",
"endpoint_info":        "lava_rpc_endpoint_info",

# After
"router_traffic":       "lava_rpcsmartrouter_requests_total",
"router_errored":       "lava_rpcsmartrouter_requests_failed_total",
"router_node_errors":   "lava_rpcsmartrouter_node_errors_total",
"router_node_recovered":"lava_rpcsmartrouter_retries_success_total",
"router_health_by_spec":"lava_rpcsmartrouter_overall_health_breakdown",
# remove endpoint_info key
```

---

### Fix 2 — Update usage queries: `function` → `method` label (lines 221–241)

Only the request and error queries change. The latency histogram retains the `function` label.

```python
# requests_data query — change grouping
f'sum(increase({PROMETHEUS_QUERIES["router_traffic"]}[{time_range}])) by (spec, function)'
# →
f'sum(increase({PROMETHEUS_QUERIES["router_traffic"]}[{time_range}])) by (spec, method)'

# errors_data query — change grouping
f'sum(increase({PROMETHEUS_QUERIES["router_errored"]}[{time_range}])) by (spec, function)'
# →
f'sum(increase({PROMETHEUS_QUERIES["router_errored"]}[{time_range}])) by (spec, method)'

# latency_data queries — NO CHANGE, still uses `function` label
```

---

### Fix 3 — Update label extraction in `process_usage_data`

Same asymmetry: requests/errors use `method`, latency still uses `function`.

```python
# For requests_data loop
function_name = metric.get("function", "unknown")
# →
function_name = metric.get("method", "unknown")

# For errors_data loop
function_name = metric.get("function", "unknown")
# →
function_name = metric.get("method", "unknown")

# For latency_data loop — NO CHANGE, still reads "function"
```

The join across the three datasets works correctly because both `method` and `function` labels carry the same RPC method name values (e.g., `"eth_call"`).

---

### Fix 4 — Replace `endpoint_info` + `job`-bridge in `get_chains_to_providers`

**Current flow (broken after PR3):**
1. Query `lava_rpc_endpoint_info` → build `{spec → job}` map
2. Query `lava_rpcsmartrouter_overall_health` → build `{job → health}` map
3. Join via `spec → job → health`

**New flow:**
1. Query `lava_rpcsmartrouter_overall_health_breakdown{spec, apiInterface}` directly
2. Build `{spec → health}` map — no bridging needed
3. Remove the `endpoint_info_data` fetch and the `spec_to_job` / `job_to_health` logic

The three-query `asyncio.gather` in `get_chains_to_providers` (line 583) becomes a two-query gather:

```python
# Before
endpoint_health_data, endpoint_info_data, router_health_data = await asyncio.gather(
    svc.query_range(PROMETHEUS_QUERIES["endpoint_health"], ...),
    svc.query(PROMETHEUS_QUERIES["endpoint_info"]),
    svc.query(PROMETHEUS_QUERIES["router_health"]),
)

# After
endpoint_health_data, router_health_data = await asyncio.gather(
    svc.query_range(PROMETHEUS_QUERIES["endpoint_health"], ...),
    svc.query(PROMETHEUS_QUERIES["router_health_by_spec"]),
)
```

The router health lookup per chain changes from:
```python
# Before — two-level lookup via job
job = spec_to_job.get(r.network.upper(), "")
router_healthy = job_to_health.get(job, 0.0) > 0 if job else False

# After — direct spec lookup
router_healthy = spec_health.get(r.network.upper(), 0.0) > 0
```

Where `spec_health` is built from `lava_rpcsmartrouter_overall_health_breakdown`:
```python
spec_health: dict[str, float] = {}
for series in router_health_data.get("data", {}).get("result", []):
    spec = series.get("metric", {}).get("spec", "").upper()
    value_pair = series.get("value", [])
    try:
        value = float(value_pair[1]) if len(value_pair) > 1 else 0.0
    except (ValueError, TypeError):
        value = 0.0
    if spec:
        spec_health[spec] = max(spec_health.get(spec, 0.0), value)
```

---

## Testing

### Existing tests to update

**`backend/tests/test_metrics_more_endpoints.py`** — `FakePromAgg` matches on query substrings:
- `"traffic"` in query → update to match `"requests_total"`
- Any hardcoded old metric names in fake responses

**`backend/tests/test_metrics_network_filter.py`** — Verify the two filter tests pass after Fix 1; update query-string matchers if not.

**`backend/tests/test_chains_to_providers_safety.py`** — The existing test calls `/api/metrics/chains-to-providers`. After Fix 4 it no longer queries `endpoint_info`. Update the fake Prometheus responses to drop the `endpoint_info` stub and replace with a `overall_health_breakdown` response.

### New tests to write

#### `backend/tests/test_usage_endpoint.py`

| Test | Verifies |
|---|---|
| `test_usage_method_label_used_for_requests` | Query strings sent to Prometheus use `by (spec, method)` for requests/errors |
| `test_usage_function_label_used_for_latency` | Latency query still uses `by (spec, function)` |
| `test_usage_returns_methods_populated` | Fake data with `method` label → `single.methods` is non-empty |
| `test_usage_empty_on_no_data` | All queries empty → zero totals, empty methods list |
| `test_usage_error_rate_calculation` | requests=100, errors=10 → `error_rate=10.0` |

#### `backend/tests/test_dashboard_summary_endpoint.py`

| Test | Verifies |
|---|---|
| `test_summary_uses_new_traffic_metric` | Query string contains `requests_total` not `total_relays_serviced` |
| `test_summary_uses_new_error_metric` | Query string contains `retries_success_total` not `node_errors_recovered` |
| `test_summary_node_errors_and_recovery` | node_errors=100, retries_success=30 → `recovery_rate=30.0` |
| `test_summary_zero_division_safe` | node_errors=0 → `recovery_rate=0.0` (no crash) |
| `test_summary_prometheus_failure` | Prometheus raises → HTTP 500 |

#### `backend/tests/test_chains_to_providers_router_health.py`

| Test | Verifies |
|---|---|
| `test_router_health_uses_breakdown_metric` | Query string contains `overall_health_breakdown` not `endpoint_info` |
| `test_router_healthy_when_breakdown_is_1` | `overall_health_breakdown` returns 1 for spec → router shows healthy |
| `test_router_unhealthy_when_no_data` | No breakdown data → router shows unhealthy |

---

## Summary

4 fixes, 1 file, all backend:

| Fix | Lines affected | Broken panel |
|---|---|---|
| 1 — Rename 4 metrics + add `router_health_by_spec` | `PROMETHEUS_QUERIES` dict | Traffic, errors, recovery all show 0 |
| 2 — `method` label in usage queries (requests + errors only) | `fetch_usage_metrics_data` | Usage methods table empty |
| 3 — `metric.get("method")` in usage processing (requests + errors only) | `process_usage_data` | Usage methods table empty |
| 4 — Replace `endpoint_info` bridge with `overall_health_breakdown` | `get_chains_to_providers` | Flow diagram: all routers show unhealthy |
