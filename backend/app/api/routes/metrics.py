import asyncio
import re
import statistics
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import get_current_user
from app.services.prometheus import prometheus_service, PrometheusService
from app.services.configuration import configuration_service, ConfigurationService
from app.core.dataclasses import (
    Router,
    ChainHealth,
    ChainMetrics,
    ChainsMetricsResponse,
    ChainsToProvidersResponse,
    Node,
    ProviderMetrics,
    ProviderHealth,
    ProvidersMetricsResponse,
    MethodUsage,
    TimeSeriesDataPoint,
    RequestTypeUsage,
    BatchRequestUsage,
    ChainUsageMetrics,
    UsageMetricsResponse,
    DashboardSummaryMetrics,
    ErrorRecoveryMetrics,
    SafeRouter,
    SafeNode,
    SafeEndpoint,
)
from app.core.calculations import (
    calculate_adaptive_step_size,
    calculate_graph_step_minutes,
    calculate_uptime_percentage,
    calculate_latency_ms,
    calculate_requests_in_time_window,
    calculate_chain_latest_block_number,
    calculate_node_uptime_percentage,
    calculate_node_latency_ms,
    calculate_node_requests_in_time_window,
    calculate_node_latest_block_number,
)


router = APIRouter()

# ---------------------------------------------------------------------------
# Prometheus metric names — unified smart router
# ---------------------------------------------------------------------------
# Router-scoped: labels = spec, apiInterface, [method]
# Router latency histogram: labels = spec, apiInterface, function  (unchanged)
# Endpoint-scoped: labels = spec, apiInterface, endpoint_id, [function]
# Histograms expose _bucket, _count, _sum suffixes automatically.
PROMETHEUS_QUERIES = {
    # Router-scoped (per chain/spec, all endpoints aggregated)
    "router_traffic": "lava_rpcsmartrouter_requests_total",
    "router_errored": "lava_rpcsmartrouter_requests_failed_total",
    "router_latency": "lava_rpcsmartrouter_end_to_end_latency_milliseconds",
    "router_latest_block": "lava_rpcsmartrouter_latest_block",
    "router_health": "lava_rpcsmartrouter_overall_health",
    "router_health_by_spec": "lava_rpcsmartrouter_overall_health_breakdown",
    "router_retries_total": "lava_rpcsmartrouter_retries_total",
    "router_retries_success": "lava_rpcsmartrouter_retries_success_total",
    # Endpoint-scoped (per RPC node / direct-rpc endpoint)
    "endpoint_health": "lava_rpc_endpoint_overall_health",
    "endpoint_traffic": "lava_rpc_endpoint_total_relays_serviced",
    "endpoint_errored": "lava_rpc_endpoint_total_errored",
    "endpoint_latency": "lava_rpc_endpoint_end_to_end_latency_milliseconds",
    "endpoint_latest_block": "lava_rpc_endpoint_latest_block",
}

DEFAULT_TIME_WINDOW_MINUTES = 15
DEFAULT_STEP_SIZE = 5


def get_prometheus_service() -> PrometheusService:
    return prometheus_service


def get_configuration_service() -> ConfigurationService:
    return configuration_service


# ---------------------------------------------------------------------------
# Shared data-fetch helpers
# ---------------------------------------------------------------------------


async def fetch_chain_metrics_data(
    svc: PrometheusService, time_window_minutes: int, step_size: int
) -> tuple[
    dict[str, Any],  # uptime_data       — max(endpoint_health) by (spec) — 0/1 per step
    dict[str, Any],  # latency_data      — avg latency per spec from histogram
    dict[str, Any],  # traffic_data      — increase(router_traffic) by (spec)
    dict[str, Any],  # endpoint_health   — raw lava_rpc_endpoint_overall_health
    dict[str, Any],  # block_data        — max(router_latest_block) by (spec)
    dict[str, Any],  # reachability_data — avg(endpoint_health) by (spec) — 0-1 fraction
]:
    """Fetch all metrics needed for chain-level KPI calculation."""
    time_range = f"{time_window_minutes}m"
    end_time = datetime.now()
    start_time = end_time - timedelta(minutes=time_window_minutes)
    step = f"{step_size}s"

    (
        uptime_data,
        latency_data,
        traffic_data,
        endpoint_health_data,
        block_data,
        reachability_data,
    ) = await asyncio.gather(
        # Uptime: chain is up if ANY endpoint is healthy
        svc.query_range(
            f"max({PROMETHEUS_QUERIES['endpoint_health']}) by (spec)",
            start_time,
            end_time,
            step,
        ),
        # Latency: router-level p50 from histogram buckets
        svc.query_range(
            f"histogram_quantile(0.5, sum(rate({PROMETHEUS_QUERIES['router_latency']}_bucket[{time_range}])) by (le, spec))",
            start_time,
            end_time,
            step,
        ),
        # Traffic: total new requests per step
        svc.query_range(
            f"sum(increase({PROMETHEUS_QUERIES['router_traffic']}[{time_range}])) by (spec)",
            start_time,
            end_time,
            step,
        ),
        # Raw endpoint health for per-node health matching
        svc.query_range(
            PROMETHEUS_QUERIES["endpoint_health"],
            start_time,
            end_time,
            step,
        ),
        # Latest block: maximum across all apiInterfaces for a spec
        svc.query_range(
            f"max({PROMETHEUS_QUERIES['router_latest_block']}) by (spec)",
            start_time,
            end_time,
            step,
        ),
        # Reachability: fraction of healthy endpoints per spec
        svc.query_range(
            f"avg({PROMETHEUS_QUERIES['endpoint_health']}) by (spec)",
            start_time,
            end_time,
            step,
        ),
    )

    return (
        uptime_data,
        latency_data,
        traffic_data,
        endpoint_health_data,
        block_data,
        reachability_data,
    )


async def fetch_node_metrics_data(
    svc: PrometheusService, time_window_minutes: int, step_size: int
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Fetch all metrics needed for node/endpoint-level KPI calculation."""
    time_range = f"{time_window_minutes}m"
    end_time = datetime.now()
    start_time = end_time - timedelta(minutes=time_window_minutes)
    step = f"{step_size}s"

    (
        endpoint_health_data,
        endpoint_traffic_data,
        endpoint_block_data,
        endpoint_latency_data,
    ) = await asyncio.gather(
        svc.query_range(
            PROMETHEUS_QUERIES["endpoint_health"],
            start_time,
            end_time,
            step,
        ),
        svc.query_range(
            f"sum(increase({PROMETHEUS_QUERIES['endpoint_traffic']}[{time_range}])) by (spec, endpoint_id)",
            start_time,
            end_time,
            step,
        ),
        svc.query_range(
            f"max({PROMETHEUS_QUERIES['endpoint_latest_block']}) by (spec, endpoint_id)",
            start_time,
            end_time,
            step,
        ),
        svc.query_range(
            f"histogram_quantile(0.5, sum(rate({PROMETHEUS_QUERIES['endpoint_latency']}_bucket[{time_range}])) by (le, spec, endpoint_id))",
            start_time,
            end_time,
            step,
        ),
    )

    return (
        endpoint_health_data,
        endpoint_traffic_data,
        endpoint_block_data,
        endpoint_latency_data,
    )


async def fetch_usage_metrics_data(
    svc: PrometheusService, time_window_minutes: int
) -> tuple[
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    datetime,
    datetime,
    int,
]:
    """Fetch per-function (method) usage metrics from router-scoped metrics.

    Uses lava_rpcsmartrouter_total_relays_serviced and lava_rpcsmartrouter_total_errored
    (both have a `function` label), and computes average latency per function from the
    histogram sum/count series.

    Batch requests are identified by "&" in the function name (e.g., "getBlock&getBlock").
    """
    time_range = f"{time_window_minutes}m"
    end_time = datetime.now()
    start_time = end_time - timedelta(minutes=time_window_minutes)
    graph_step_minutes = calculate_graph_step_minutes(time_window_minutes)

    (
        requests_data,
        latency_data,
        errors_data,
        total_relays_data,
    ) = await asyncio.gather(
        # Per-method request count (instant query over full window)
        svc.query(
            f'sum(increase({PROMETHEUS_QUERIES["router_traffic"]}[{time_range}])) by (spec, method)',
        ),
        # Per-function average latency (instant query, histogram-derived)
        # Note: end_to_end_latency_milliseconds still uses the `function` label
        svc.query(
            f'sum(rate({PROMETHEUS_QUERIES["router_latency"]}_sum[{time_range}])) by (spec, function)'
            f' / sum(rate({PROMETHEUS_QUERIES["router_latency"]}_count[{time_range}])) by (spec, function)',
        ),
        # Per-method error count (instant query over full window)
        svc.query(
            f'sum(increase({PROMETHEUS_QUERIES["router_errored"]}[{time_range}])) by (spec, method)',
        ),
        # Total relays over time for the graph (range query)
        svc.query_range(
            f'sum(increase({PROMETHEUS_QUERIES["router_traffic"]}[{graph_step_minutes}m])) by (spec)',
            start_time,
            end_time,
            f"{graph_step_minutes * 60}s",
        ),
    )

    return (
        requests_data,
        latency_data,
        errors_data,
        total_relays_data,
        start_time,
        end_time,
        graph_step_minutes,
    )


# ---------------------------------------------------------------------------
# Generic utility endpoints (proxy to Prometheus)
# ---------------------------------------------------------------------------


@router.get("/")
async def get_default_metrics(
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Get data for all default metrics"""
    try:
        metrics = await svc.get_default_metrics()
        return {"metrics": metrics}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error fetching metrics: {str(e)}")


@router.get("/query")
async def query_metrics(
    query: str,
    start: datetime | None = None,
    end: datetime | None = None,
    step: str = "15s",
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Query Prometheus metrics"""
    try:
        if not start:
            start = datetime.now() - timedelta(hours=1)
        if not end:
            end = datetime.now()
        result = await svc.get_metric_range(
            query=query, start=start.isoformat(), end=end.isoformat(), step=step
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/instant")
async def instant_query(
    query: str = Query(..., description="Prometheus query expression"),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Execute an instant Prometheus query"""
    try:
        result = await svc.query(query)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error executing query: {str(e)}")


@router.get("/range")
async def range_query(
    query: str = Query(..., description="Prometheus query expression"),
    start: str | None = Query(None, description="Start time (ISO format)"),
    end: str | None = Query(None, description="End time (ISO format)"),
    step: str = Query("5s", description="Step size for range queries"),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Execute a range Prometheus query with custom time range"""
    try:
        start_time = (
            datetime.fromisoformat(start)
            if start
            else datetime.now() - timedelta(hours=1)
        )
        end_time = datetime.fromisoformat(end) if end else datetime.now()
        result = await svc.query_range(query, start_time, end_time, step)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error executing query: {str(e)}")


@router.get("/last_minutes")
async def last_n_minutes(
    query: str = Query(..., description="Prometheus query expression"),
    minutes: int = Query(15, description="Number of minutes of data to fetch"),
    step: str = Query("5s", description="Step size for range queries"),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Execute a range Prometheus query for the last n minutes"""
    try:
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=minutes)
        result = await svc.query_range(query, start_time, end_time, step)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error executing query: {str(e)}")


@router.get("/default")
async def get_default_metrics_alias(
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Alias endpoint for default metrics (kept for compatibility)."""
    try:
        return await svc.get_default_metrics()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Chain (router) metrics
# ---------------------------------------------------------------------------


@router.get("/chains-metrics", response_model=ChainsMetricsResponse)
async def get_chains_metrics(
    time_window_minutes: int = Query(DEFAULT_TIME_WINDOW_MINUTES),
    choosen_network: str | None = Query(default=None),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Get KPI metrics for all configured routers (chains)."""
    try:
        available_routers = configuration_service.get_chains_providers_configuration
        if choosen_network:
            available_routers = [
                r for r in available_routers if r.network == choosen_network
            ]
        if not available_routers:
            empty = ChainMetrics(
                uptime=0.0,
                latency_in_ms=0,
                reachability=0.0,
                requests_in_window=0,
                latest_block=0,
            )
            return ChainsMetricsResponse(chains={}, avg=empty, p90=empty)

        (
            uptime_data,
            latency_data,
            traffic_data,
            _endpoint_health,
            block_data,
            reachability_data,
        ) = await fetch_chain_metrics_data(
            svc, time_window_minutes, calculate_adaptive_step_size(time_window_minutes)
        )

        chains_dict: dict[str, ChainMetrics] = {}
        for r in available_routers:
            chains_dict[r.id] = ChainMetrics(
                network=r.network,
                uptime=calculate_uptime_percentage(uptime_data, r.network),
                latency_in_ms=calculate_latency_ms(latency_data, r.network),
                reachability=calculate_uptime_percentage(reachability_data, r.network),
                requests_in_window=calculate_requests_in_time_window(
                    traffic_data, r.network
                ),
                latest_block=calculate_chain_latest_block_number(block_data, r.network),
            )

        all_metrics = list(chains_dict.values())
        uptimes = [m.uptime for m in all_metrics]
        latencies = [m.latency_in_ms for m in all_metrics]
        reachabilities = [m.reachability for m in all_metrics]
        requests = [m.requests_in_window for m in all_metrics]
        n = len(all_metrics)

        avg = ChainMetrics(
            uptime=round(sum(uptimes) / n, 2),
            latency_in_ms=int(round(sum(latencies) / n)),
            reachability=round(sum(reachabilities) / n, 2),
            requests_in_window=sum(requests),
            latest_block=0,
        )

        if n >= 2:
            p90 = ChainMetrics(
                uptime=round(statistics.quantiles(uptimes, n=10)[8], 2),
                latency_in_ms=int(round(statistics.quantiles(latencies, n=10)[8])),
                reachability=round(statistics.quantiles(reachabilities, n=10)[8], 2),
                requests_in_window=round(statistics.quantiles(requests, n=10)[8]),
                latest_block=0,
            )
        else:
            p90 = ChainMetrics(
                uptime=uptimes[0] if uptimes else 0.0,
                latency_in_ms=latencies[0] if latencies else 0,
                reachability=reachabilities[0] if reachabilities else 0.0,
                requests_in_window=requests[0] if requests else 0,
                latest_block=0,
            )

        return ChainsMetricsResponse(chains=chains_dict, avg=avg, p90=p90)

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error fetching chains metrics: {str(e)}"
        )


@router.get("/chains-metrics/{chain_id}", response_model=ChainMetrics)
async def get_chain_metrics(
    chain_id: str,
    time_window_minutes: int = Query(DEFAULT_TIME_WINDOW_MINUTES),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Get KPI metrics for a specific router (chain)."""
    try:
        available_routers = configuration_service.get_chains_providers_configuration
        selected = next((r for r in available_routers if r.id == chain_id), None)
        if not selected:
            raise HTTPException(status_code=404, detail=f"Chain '{chain_id}' not found")

        (
            uptime_data,
            latency_data,
            traffic_data,
            _endpoint_health,
            block_data,
            reachability_data,
        ) = await fetch_chain_metrics_data(
            svc, time_window_minutes, calculate_adaptive_step_size(time_window_minutes)
        )

        return ChainMetrics(
            network=selected.network,
            uptime=calculate_uptime_percentage(uptime_data, selected.network),
            latency_in_ms=calculate_latency_ms(latency_data, selected.network),
            reachability=calculate_uptime_percentage(
                reachability_data, selected.network
            ),
            requests_in_window=calculate_requests_in_time_window(
                traffic_data, selected.network
            ),
            latest_block=calculate_chain_latest_block_number(
                block_data, selected.network
            ),
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching chain metrics for '{chain_id}': {str(e)}",
        )


# ---------------------------------------------------------------------------
# Node (endpoint) metrics  — replaces "providers" endpoints
# ---------------------------------------------------------------------------


@router.get("/providers-metrics", response_model=ProvidersMetricsResponse)
async def get_providers_metrics(
    time_window_minutes: int = Query(DEFAULT_TIME_WINDOW_MINUTES),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Get metrics per node (endpoint) across all configured routers."""
    try:
        available_routers = configuration_service.get_chains_providers_configuration
        if not available_routers:
            empty = ProviderMetrics(
                uptime=0.0, latency_in_ms=0, requests_in_window=0, latest_block=0
            )
            return ProvidersMetricsResponse(providers={}, avg=empty, p90=empty)

        (
            endpoint_health_data,
            endpoint_traffic_data,
            endpoint_block_data,
            endpoint_latency_data,
        ) = await fetch_node_metrics_data(
            svc, time_window_minutes, calculate_adaptive_step_size(time_window_minutes)
        )

        providers_dict: dict[str, ProviderMetrics] = {}
        for r in available_routers:
            for node in r.nodes:
                node_key = f"{r.id}-{node.name}".lower()
                providers_dict[node_key] = ProviderMetrics(
                    provider_name=node.name,
                    network=r.network,
                    uptime=calculate_node_uptime_percentage(
                        endpoint_health_data, node.name, r.network
                    ),
                    latency_in_ms=calculate_node_latency_ms(
                        endpoint_latency_data, node.name, r.network
                    ),
                    requests_in_window=calculate_node_requests_in_time_window(
                        endpoint_traffic_data, node.name, r.network
                    ),
                    latest_block=calculate_node_latest_block_number(
                        endpoint_block_data, node.name, r.network
                    ),
                )

        all_nodes = list(providers_dict.values())
        uptimes = [m.uptime for m in all_nodes]
        requests = [m.requests_in_window for m in all_nodes]
        latencies = [
            m.latency_in_ms
            for m in all_nodes
            if m.latency_in_ms is not None and m.latency_in_ms > 0
        ]

        avg_latency = round(sum(latencies) / len(latencies)) if latencies else 0
        avg = ProviderMetrics(
            uptime=round(sum(uptimes) / len(all_nodes), 2),
            latency_in_ms=avg_latency,
            requests_in_window=sum(requests),
            latest_block=0,
        )

        n = len(all_nodes)
        if n >= 2:
            p90_latency = (
                round(statistics.quantiles(latencies, n=10)[8])
                if len(latencies) >= 2
                else (latencies[0] if latencies else 0)
            )
            p90 = ProviderMetrics(
                uptime=(
                    round(statistics.quantiles(uptimes, n=10)[8], 2)
                    if len(uptimes) >= 2
                    else (uptimes[0] if uptimes else 0.0)
                ),
                latency_in_ms=p90_latency,
                requests_in_window=(
                    round(statistics.quantiles(requests, n=10)[8])
                    if len(requests) >= 2
                    else (requests[0] if requests else 0)
                ),
                latest_block=0,
            )
        else:
            p90_latency = latencies[0] if latencies else 0
            p90 = ProviderMetrics(
                uptime=uptimes[0] if uptimes else 0.0,
                latency_in_ms=p90_latency,
                requests_in_window=requests[0] if requests else 0,
                latest_block=0,
            )

        return ProvidersMetricsResponse(providers=providers_dict, avg=avg, p90=p90)

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error fetching node metrics: {str(e)}"
        )


# ---------------------------------------------------------------------------
# Flow visualization: routers → nodes with health status
# ---------------------------------------------------------------------------


@router.get("/chains-to-providers", response_model=ChainsToProvidersResponse)
async def get_chains_to_providers(
    time_window_minutes: int = Query(DEFAULT_TIME_WINDOW_MINUTES),
    step_size: int = Query(DEFAULT_STEP_SIZE),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Return routers with per-node health status for flow visualization."""
    try:
        routers = configuration_service.get_chains_providers_configuration
        if not routers:
            return ChainsToProvidersResponse(chains=[])

        # Fetch raw endpoint health (labels: spec, apiInterface, endpoint_id)
        # and router health breakdown (labels: spec, apiInterface) — no job-bridge needed.
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=time_window_minutes)
        endpoint_health_data, router_health_data = await asyncio.gather(
            svc.query_range(
                PROMETHEUS_QUERIES["endpoint_health"],
                start_time,
                end_time,
                f"{calculate_adaptive_step_size(time_window_minutes)}s",
            ),
            svc.query(PROMETHEUS_QUERIES["router_health_by_spec"]),
        )

        # Build {endpoint_id_lower: latest_health_value} map from Prometheus results.
        # The endpoint_id label in lava_rpc_endpoint_overall_health is the node name
        # from the router config (e.g. "lava", "google"), stored in lowercase.
        # Multiple series may exist per endpoint_id (one per apiInterface replica);
        # take the max so a node is healthy if any series reports healthy.
        node_health: dict[str, float] = {}
        if endpoint_health_data.get("status") == "success" and endpoint_health_data.get(
            "data", {}
        ).get("result"):
            for series in endpoint_health_data["data"]["result"]:
                endpoint_id = series.get("metric", {}).get("endpoint_id", "")
                if not endpoint_id:
                    continue
                values = series.get("values", [])
                if values:
                    try:
                        health_val = float(values[-1][1])
                    except (ValueError, IndexError):
                        health_val = 0.0
                    key = endpoint_id.lower()
                    node_health[key] = max(node_health.get(key, 0.0), health_val)

        # Build {spec_upper: health_value} map from lava_rpcsmartrouter_overall_health_breakdown.
        # Multiple series may exist per spec (one per apiInterface); take the max.
        spec_health: dict[str, float] = {}
        if router_health_data.get("status") == "success":
            for series in router_health_data.get("data", {}).get("result", []):
                spec = series.get("metric", {}).get("spec", "").upper()
                value_pair = series.get("value", [])
                try:
                    value = float(value_pair[1]) if len(value_pair) > 1 else 0.0
                except (ValueError, TypeError):
                    value = 0.0
                if spec:
                    spec_health[spec] = max(spec_health.get(spec, 0.0), value)

        chains_list: list[SafeRouter] = []
        for r in routers:
            nodes_list: list[SafeNode] = []
            for node in r.nodes:
                # Node health: from lava_rpc_endpoint_overall_health, matched by node name.
                node_healthy = node_health.get(node.name.lower(), 0.0) > 0
                safe_endpoints = [
                    SafeEndpoint(interface=ep.interface) for ep in node.endpoints
                ]
                nodes_list.append(
                    SafeNode(
                        name=node.name,
                        endpoints=safe_endpoints,
                        health_status=(
                            ProviderHealth.HEALTHY
                            if node_healthy
                            else ProviderHealth.UNHEALTHY
                        ),
                        is_backup=node.is_backup,
                    )
                )

            # Router health: from lava_rpcsmartrouter_overall_health_breakdown, keyed by spec.
            router_healthy = spec_health.get(r.network.upper(), 0.0) > 0
            router_health = (
                ChainHealth.HEALTHY if router_healthy else ChainHealth.UNHEALTHY
            )

            chains_list.append(
                SafeRouter(
                    id=r.id,
                    network=r.network,
                    nodes=nodes_list,
                    health_status=router_health,
                )
            )

        return ChainsToProvidersResponse(chains=chains_list)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching chains-to-providers mapping: {str(e)}",
        )


# ---------------------------------------------------------------------------
# Usage page — per-function (RPC method) breakdown
# ---------------------------------------------------------------------------


def is_batch_function(function_name: str) -> bool:
    return "&" in function_name


def get_batch_function_counts(function_name: str) -> dict[str, int]:
    functions = function_name.split("&")
    counts: dict[str, int] = {}
    for func in functions:
        counts[func] = counts.get(func, 0) + 1
    return counts


def get_normalized_batch_key(function_name: str) -> str:
    counts = get_batch_function_counts(function_name)
    sorted_funcs = sorted(counts.items(), key=lambda x: (-x[1], x[0]))
    parts = [f"{count} x {func}" for func, count in sorted_funcs]
    return "\n".join(parts)


def get_batch_size(function_name: str) -> int:
    return len(function_name.split("&"))


def get_batch_size_from_normalized_key(normalized_key: str) -> int:
    matches = re.findall(r"(\d+) x", normalized_key)
    return sum(int(m) for m in matches) if matches else 1


def process_usage_data(
    requests_data: dict[str, Any],
    latency_data: dict[str, Any],
    errors_data: dict[str, Any],
    network: str,
    is_batch: bool,
) -> tuple[list[MethodUsage], int, int, int, float | None]:
    """Process Prometheus data into per-method usage metrics."""
    methods_dict: dict[str, dict] = {}
    total_requests = 0
    total_individual_requests = 0
    total_errors = 0
    latency_sum = 0.0
    latency_count = 0

    # --- requests ---
    if requests_data.get("status") == "success" and requests_data.get("data", {}).get(
        "result"
    ):
        for series in requests_data["data"]["result"]:
            metric = series.get("metric", {})
            spec = metric.get("spec", "").lower()
            if network.lower() != "all" and spec != network.lower():
                continue
            function_name = metric.get("method", "unknown")
            if is_batch_function(function_name) != is_batch:
                continue

            value = series.get("value")
            values = series.get("values", [])
            if value:
                raw = value[1] if len(value) > 1 else "0"
                method_requests = int(float(raw)) if raw != "NaN" else 0
            elif values:
                method_requests = int(sum(float(v[1]) for v in values if v[1] != "NaN"))
            else:
                continue

            if method_requests > 0:
                if is_batch:
                    nk = get_normalized_batch_key(function_name)
                    bs = get_batch_size(function_name)
                    if nk not in methods_dict:
                        methods_dict[nk] = {
                            "requests": 0,
                            "errors": 0,
                            "latency_sum": 0,
                            "latency_count": 0,
                            "batch_size": bs,
                        }
                    methods_dict[nk]["requests"] += method_requests
                    total_requests += method_requests
                    total_individual_requests += method_requests * bs
                else:
                    if function_name not in methods_dict:
                        methods_dict[function_name] = {
                            "requests": 0,
                            "errors": 0,
                            "latency_sum": 0,
                            "latency_count": 0,
                        }
                    methods_dict[function_name]["requests"] += method_requests
                    total_requests += method_requests

    # --- errors ---
    if errors_data.get("status") == "success" and errors_data.get("data", {}).get(
        "result"
    ):
        for series in errors_data["data"]["result"]:
            metric = series.get("metric", {})
            spec = metric.get("spec", "").lower()
            if network.lower() != "all" and spec != network.lower():
                continue
            function_name = metric.get("method", "unknown")
            if is_batch_function(function_name) != is_batch:
                continue

            value = series.get("value")
            values = series.get("values", [])
            if value:
                raw = value[1] if len(value) > 1 else "0"
                method_errors = int(float(raw)) if raw != "NaN" else 0
            elif values:
                method_errors = int(sum(float(v[1]) for v in values if v[1] != "NaN"))
            else:
                continue

            if method_errors > 0:
                if is_batch:
                    nk = get_normalized_batch_key(function_name)
                    if nk in methods_dict:
                        methods_dict[nk]["errors"] += method_errors
                        total_errors += method_errors
                else:
                    if function_name in methods_dict:
                        methods_dict[function_name]["errors"] += method_errors
                        total_errors += method_errors

    # --- latency (histogram-derived average per function) ---
    if latency_data.get("status") == "success" and latency_data.get("data", {}).get(
        "result"
    ):
        for series in latency_data["data"]["result"]:
            metric = series.get("metric", {})
            spec = metric.get("spec", "").lower()
            if network.lower() != "all" and spec != network.lower():
                continue
            function_name = metric.get("function", "unknown")
            if is_batch_function(function_name) != is_batch:
                continue

            value = series.get("value")
            values = series.get("values", [])
            method_avg_latency = None
            if value:
                raw = value[1] if len(value) > 1 else None
                if raw and raw != "NaN":
                    method_avg_latency = float(raw)
            elif values:
                valid = [float(v[1]) for v in values if v[1] != "NaN"]
                if valid:
                    method_avg_latency = sum(valid) / len(valid)

            if method_avg_latency is not None:
                if is_batch:
                    nk = get_normalized_batch_key(function_name)
                    if nk in methods_dict:
                        methods_dict[nk]["latency_sum"] += method_avg_latency
                        methods_dict[nk]["latency_count"] += 1
                else:
                    if function_name in methods_dict:
                        methods_dict[function_name]["latency_sum"] += method_avg_latency
                        methods_dict[function_name]["latency_count"] += 1
                latency_sum += method_avg_latency
                latency_count += 1

    # Build result
    methods_list: list[MethodUsage] = []
    for method_name, data in methods_dict.items():
        reqs = data["requests"]
        if reqs == 0:
            continue
        errs = data["errors"]
        method_latency = None
        if data["latency_count"] > 0:
            method_latency = round(data["latency_sum"] / data["latency_count"], 2)
        methods_list.append(
            MethodUsage(
                method=method_name,
                requests=reqs,
                errors=errs,
                error_rate=round((errs / reqs * 100) if reqs > 0 else 0, 2),
                avg_latency_ms=method_latency,
                percentage=round(
                    (reqs / total_requests * 100) if total_requests > 0 else 0, 1
                ),
            )
        )

    methods_list.sort(key=lambda x: x.requests, reverse=True)
    overall_latency = (
        round(latency_sum / latency_count, 2) if latency_count > 0 else None
    )
    if not is_batch:
        total_individual_requests = total_requests
    return (
        methods_list,
        total_requests,
        total_individual_requests,
        total_errors,
        overall_latency,
    )


def get_timestamp_format(time_window_minutes: int) -> str:
    if time_window_minutes <= 360:
        return "%H:%M"
    elif time_window_minutes <= 10080:
        return "%a %H:%M"
    else:
        return "%b %d"


def process_requests_over_time(
    total_relays_data: dict[str, Any],
    network: str,
    time_window_minutes: int,
    start_time: datetime,
    end_time: datetime,
    step_minutes: int,
) -> list[TimeSeriesDataPoint]:
    timestamp_values: dict[float, float] = {}
    if total_relays_data.get("status") == "success" and total_relays_data.get(
        "data", {}
    ).get("result"):
        for series in total_relays_data["data"]["result"]:
            spec = series.get("metric", {}).get("spec", "").lower()
            if network.lower() != "all" and spec != network.lower():
                continue
            for timestamp, value in series.get("values", []):
                if value != "NaN":
                    ts = float(timestamp)
                    timestamp_values[ts] = timestamp_values.get(ts, 0) + float(value)

    ts_format = get_timestamp_format(time_window_minutes)
    step_seconds = step_minutes * 60
    aligned_start = (int(start_time.timestamp()) // step_seconds) * step_seconds
    aligned_end = ((int(end_time.timestamp()) // step_seconds) + 1) * step_seconds

    result: list[TimeSeriesDataPoint] = []
    current_ts = aligned_start
    while current_ts <= aligned_end:
        value = sum(
            v
            for ts, v in timestamp_values.items()
            if abs(ts - current_ts) < step_seconds / 2
        )
        result.append(
            TimeSeriesDataPoint(
                timestamp=datetime.fromtimestamp(current_ts).strftime(ts_format),
                value=round(value, 0),
            )
        )
        current_ts += step_seconds
    return result


@router.get("/usage/{chain_id}", response_model=UsageMetricsResponse)
@router.get("/usage", response_model=UsageMetricsResponse)
async def get_usage_metrics(
    chain_id: str | None = None,
    time_window_minutes: int = Query(DEFAULT_TIME_WINDOW_MINUTES),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Get per-function (RPC method) usage metrics for each router/chain."""
    try:
        available_routers = configuration_service.get_chains_providers_configuration
        if not available_routers:
            return UsageMetricsResponse(chains={})

        if chain_id:
            selected = next((r for r in available_routers if r.id == chain_id), None)
            if not selected:
                raise HTTPException(
                    status_code=404, detail=f"Chain '{chain_id}' not found"
                )
            available_routers = [selected]

        (
            requests_data,
            latency_data,
            errors_data,
            total_relays_data,
            graph_start,
            graph_end,
            graph_step_minutes,
        ) = await fetch_usage_metrics_data(svc, time_window_minutes)

        chains_usage: dict[str, ChainUsageMetrics] = {}
        for r in available_routers:
            single_methods, single_total, _, single_errors, single_avg_latency = (
                process_usage_data(
                    requests_data, latency_data, errors_data, r.network, is_batch=False
                )
            )
            batch_methods, batch_total, _, batch_errors, batch_avg_latency = (
                process_usage_data(
                    requests_data, latency_data, errors_data, r.network, is_batch=True
                )
            )
            requests_over_time = process_requests_over_time(
                total_relays_data,
                r.network,
                time_window_minutes,
                graph_start,
                graph_end,
                graph_step_minutes,
            )
            avg_batch_size = (
                sum(get_batch_size_from_normalized_key(m.method) for m in batch_methods)
                / len(batch_methods)
                if batch_methods
                else 0.0
            )
            chains_usage[r.id] = ChainUsageMetrics(
                chain_id=r.id,
                network=r.network,
                single=RequestTypeUsage(
                    total_requests=single_total,
                    total_errors=single_errors,
                    error_rate=round(
                        (single_errors / single_total * 100) if single_total > 0 else 0,
                        2,
                    ),
                    avg_latency_ms=single_avg_latency,
                    methods=single_methods,
                    requests_over_time=requests_over_time,
                ),
                batch=BatchRequestUsage(
                    total_requests=batch_total,
                    total_errors=batch_errors,
                    error_rate=round(
                        (batch_errors / batch_total * 100) if batch_total > 0 else 0, 2
                    ),
                    avg_latency_ms=batch_avg_latency,
                    avg_batch_size=round(avg_batch_size, 1),
                    methods=batch_methods,
                    requests_over_time=requests_over_time,
                ),
            )

        return UsageMetricsResponse(chains=chains_usage)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error fetching usage metrics: {str(e)}"
        )


# ---------------------------------------------------------------------------
# Dashboard summary metrics
# ---------------------------------------------------------------------------


@router.get("/dashboard-summary", response_model=DashboardSummaryMetrics)
async def get_dashboard_summary_metrics(
    time_window_minutes: int = Query(DEFAULT_TIME_WINDOW_MINUTES),
    choosen_network: str | None = Query(default=None),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """
    Get dashboard summary metrics.

    Returns:
    - total_requests: sum of all router-level relay traffic
    - cache_hit_rate / cache_hits / cache_misses: from the Lava cache sidecar service
    - error_recovery: retry successes vs total retries from lava_rpcsmartrouter_retries_*
    """
    try:
        time_range = f"{time_window_minutes}m"
        spec_filter = f'{{spec="{choosen_network.upper()}"}}' if choosen_network else ""

        total_requests_query = f"sum(increase({PROMETHEUS_QUERIES['router_traffic']}{spec_filter}[{time_range}]))"
        cache_hits_query = (
            f'sum(increase(cache_total_hits{{total_hits="total_hits"}}[{time_range}]))'
        )
        cache_misses_query = f'sum(increase(cache_total_misses{{total_misses="total_misses"}}[{time_range}]))'
        node_errors_query = f"sum(increase({PROMETHEUS_QUERIES['router_retries_total']}{spec_filter}[{time_range}]))"
        recovered_errors_query = f"sum(increase({PROMETHEUS_QUERIES['router_retries_success']}{spec_filter}[{time_range}]))"

        (
            total_requests_data,
            cache_hits_data,
            cache_misses_data,
            node_errors_data,
            recovered_errors_data,
        ) = await asyncio.gather(
            svc.query(total_requests_query),
            svc.query(cache_hits_query),
            svc.query(cache_misses_query),
            svc.query(node_errors_query),
            svc.query(recovered_errors_query),
        )

        def extract_scalar(data: dict) -> float:
            if data.get("status") != "success":
                return 0.0
            result = data.get("data", {}).get("result", [])
            if not result:
                return 0.0
            value = result[0].get("value", [0, "0"])
            try:
                return float(value[1])
            except (ValueError, IndexError):
                return 0.0

        total_requests = extract_scalar(total_requests_data)
        cache_hits = extract_scalar(cache_hits_data)
        cache_misses = extract_scalar(cache_misses_data)
        total_cache = cache_hits + cache_misses
        cache_hit_rate = (cache_hits / total_cache * 100) if total_cache > 0 else 0.0

        total_node_errors = extract_scalar(node_errors_data)
        recovered_requests = extract_scalar(recovered_errors_data)
        recovery_rate = (
            (recovered_requests / total_node_errors * 100)
            if total_node_errors > 0
            else 0.0
        )

        return DashboardSummaryMetrics(
            total_requests=round(total_requests, 0),
            cache_hit_rate=round(cache_hit_rate, 1),
            cache_hits=round(cache_hits, 0),
            cache_misses=round(cache_misses, 0),
            error_recovery=ErrorRecoveryMetrics(
                total_node_errors=round(total_node_errors, 0),
                recovered_requests=round(recovered_requests, 0),
                recovery_rate=round(recovery_rate, 1),
            ),
        )

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching dashboard summary metrics: {str(e)}",
        )
