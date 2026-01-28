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
    Chain,
    ChainHealth,
    ChainMetrics,
    ChainsMetricsResponse,
    ChainsToProvidersResponse,
    Provider,
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
)
from app.core.calculations import (
    calculate_adaptive_step_size,
    calculate_graph_step_minutes,
    calculate_provider_uptime_percentage,
    calculate_uptime_percentage,
    calculate_latency_ms,
    calculate_provider_latency_ms,
    calculate_chain_reachability_percentage,
    calculate_requests_in_time_window,
    calculate_chain_latest_block_number,
    calculate_provider_latest_block_number,
    calculate_provider_requests_in_time_window,
)


router = APIRouter()

# Prometheus query constants
PROMETHEUS_QUERIES = {
    "consumer_health": "lava_consumer_overall_health",
    "provider_health": "lava_provider_overall_health",
    "consumer_traffic": "lava_consumer_total_relays_serviced",
    "provider_traffic": "lava_provider_total_relays_serviced",
    "consumer_latest_block": "lava_consumer_latest_provider_block",
    "provider_latest_block": "lava_latest_block",
    "consumer_latency": "lava_consumer_end_to_end_latency_milliseconds",
    "provider_latency": "lava_provider_end_to_end_latency_milliseconds",
    # Usage metrics - method-level breakdown (per function)
    "requests_per_function": "lava_provider_total_relays_serviced_per_function",
    "latency_per_function": "lava_provider_request_latency_per_function",
    "errors_per_function": "lava_provider_total_relays_errored_per_function",
    # Usage metrics - total successful relays (for graphs)
    "total_relays_serviced": "lava_provider_total_relays_serviced",
    # Dashboard summary metrics - node errors and recovery
    "total_node_errors": "lava_consumer_total_node_errors_received_from_providers",
    "recovered_errors": "lava_consumer_total_node_errors_recovered_successfully",
    # Cache metrics
    "cache_hits": "cache_total_hits",
}

# Default values
DEFAULT_TIME_WINDOW_MINUTES = 15
DEFAULT_STEP_SIZE = 5


def get_prometheus_service() -> PrometheusService:
    return prometheus_service


def get_configuration_service() -> ConfigurationService:
    """Dependency accessor for ConfigurationService."""
    return configuration_service


async def fetch_chain_metrics_data(
    svc: PrometheusService, time_window_minutes: int, step_size: int
) -> tuple[
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
]:
    """Fetch all required metrics data for chains in parallel."""
    time_range = f"{time_window_minutes}m"
    end_time = datetime.now()
    start_time = end_time - timedelta(minutes=time_window_minutes)

    (
        consumers_data,
        latency_data,
        chain_traffic_data,
        provider_health_data,
        consumer_latest_block_data,
        provider_latest_block_data,
    ) = await asyncio.gather(
        svc.query_range(
            PROMETHEUS_QUERIES["consumer_health"],
            start_time,
            end_time,
            f"{step_size}s",
        ),
        svc.query_range(
            f"avg(avg_over_time({PROMETHEUS_QUERIES['consumer_latency']}[{time_range}])) by (spec, service)",
            start_time,
            end_time,
            f"{step_size}s",
        ),
        svc.query_range(
            f"increase({PROMETHEUS_QUERIES['consumer_traffic']}[{time_range}])",
            start_time,
            end_time,
            f"{step_size}s",
        ),
        svc.query_range(
            PROMETHEUS_QUERIES["provider_health"],
            start_time,
            end_time,
            f"{step_size}s",
        ),
        svc.query_range(
            PROMETHEUS_QUERIES["consumer_latest_block"],
            start_time,
            end_time,
            f"{step_size}s",
        ),
        svc.query_range(
            PROMETHEUS_QUERIES["provider_latest_block"],
            start_time,
            end_time,
            f"{step_size}s",
        ),
    )

    return (
        consumers_data,
        latency_data,
        chain_traffic_data,
        provider_health_data,
        consumer_latest_block_data,
        provider_latest_block_data,
    )


async def fetch_provider_metrics_data(
    svc: PrometheusService, time_window_minutes: int, step_size: int
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Fetch all required metrics data for providers in parallel."""
    time_range = f"{time_window_minutes}m"
    end_time = datetime.now()
    start_time = end_time - timedelta(minutes=time_window_minutes)

    (
        providers_data,
        provider_traffic_data,
        provider_latest_block_data,
        provider_latency_data,
    ) = await asyncio.gather(
        svc.query_range(
            PROMETHEUS_QUERIES["provider_health"],
            start_time,
            end_time,
            f"{step_size}s",
        ),
        svc.query_range(
            f"increase({PROMETHEUS_QUERIES['provider_traffic']}[{time_range}])",
            start_time,
            end_time,
            f"{step_size}s",
        ),
        svc.query_range(
            PROMETHEUS_QUERIES["provider_latest_block"],
            start_time,
            end_time,
            f"{step_size}s",
        ),
        svc.query_range(
            f"avg(avg_over_time({PROMETHEUS_QUERIES['provider_latency']}[{time_range}])) by (spec, service)",
            start_time,
            end_time,
            f"{step_size}s",
        ),
    )

    return (
        providers_data,
        provider_traffic_data,
        provider_latest_block_data,
        provider_latency_data,
    )


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
):
    """Alias endpoint for default metrics (kept for compatibility)."""
    try:
        return await svc.get_default_metrics()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/chains-metrics", response_model=ChainsMetricsResponse)
async def get_chains_metrics(
    time_window_minutes: int = Query(
        DEFAULT_TIME_WINDOW_MINUTES,
        description="Number of minutes of data to fetch",
    ),
    choosen_network: str | None = Query(
        default=None,
        description="If provided, only include chains that belong to this network",
    ),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Get metrics for all chains"""
    try:
        # Get available chains
        available_chains = configuration_service.get_chains_providers_configuration
        if choosen_network:
            # Filter chains to selected network only
            available_chains = [
                chain
                for chain in available_chains
                if getattr(chain, "network", None) == choosen_network
            ]
        if not available_chains:
            return ChainsMetricsResponse(
                chains={},
                avg=ChainMetrics(
                    uptime=0.0,
                    latency_in_ms=0,
                    reachability=0.0,
                    requests_in_window=0,
                    latest_block=0,
                ),
                p90=ChainMetrics(
                    uptime=0.0,
                    latency_in_ms=0,
                    reachability=0.0,
                    requests_in_window=0,
                    latest_block=0,
                ),
            )

        # Fetch all required metrics in parallel
        (
            chains_data,
            latency_data,
            chain_traffic_data,
            provider_health_data,
            consumer_latest_block_data,
            _,
        ) = await fetch_chain_metrics_data(
            svc, time_window_minutes, calculate_adaptive_step_size(time_window_minutes)
        )

        # Calculate metrics for each chain
        chains_data_dict = {}
        for chain in available_chains:
            # Use network as key as there could be several
            chains_data_dict[chain.id] = ChainMetrics(
                network=chain.network,
                uptime=calculate_uptime_percentage(chains_data, chain.id),
                latency_in_ms=calculate_latency_ms(latency_data, chain.id),
                reachability=calculate_chain_reachability_percentage(
                    provider_health_data,
                    [
                        f"{chain.id}-{provider.name}".lower()
                        for provider in chain.providers
                    ],
                ),
                requests_in_window=calculate_requests_in_time_window(
                    chain_traffic_data, chain.id
                ),
                latest_block=calculate_chain_latest_block_number(
                    consumer_latest_block_data, chain.network
                ),
            )

        # Calculate statistical measures
        all_chains = list(chains_data_dict.values())
        # Extract values for statistics
        uptimes = [chain.uptime for chain in all_chains]
        latencies = [chain.latency_in_ms for chain in all_chains]
        reachabilities = [chain.reachability for chain in all_chains]
        requests = [chain.requests_in_window for chain in all_chains]

        # Create average metrics
        avg_metrics = ChainMetrics(
            uptime=round(sum(uptimes) / len(all_chains), 2),
            latency_in_ms=int(round(sum(latencies) / len(all_chains))),
            reachability=round(sum(reachabilities) / len(all_chains), 2),
            requests_in_window=sum(requests),
            latest_block=0,  # No average for latest block
        )

        # Create 90th percentile metrics
        # quantiles requires at least 2 data points
        if len(all_chains) >= 2:
            p90_metrics = ChainMetrics(
                uptime=round(statistics.quantiles(uptimes, n=10)[8], 2),
                latency_in_ms=int(round(statistics.quantiles(latencies, n=10)[8])),
                reachability=round(statistics.quantiles(reachabilities, n=10)[8], 2),
                requests_in_window=round(statistics.quantiles(requests, n=10)[8]),
                latest_block=0,  # No p90 for latest block
            )
        else:
            # If only one chain, use its values as p90
            p90_metrics = ChainMetrics(
                uptime=uptimes[0] if uptimes else 0.0,
                latency_in_ms=latencies[0] if latencies else 0,
                reachability=reachabilities[0] if reachabilities else 0.0,
                requests_in_window=requests[0] if requests else 0,
                latest_block=0,  # No p90 for latest block
            )

        return ChainsMetricsResponse(
            chains=chains_data_dict, avg=avg_metrics, p90=p90_metrics
        )

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error fetching chains metrics: {str(e)}"
        )


@router.get("/chains-metrics/{chain_id}", response_model=ChainMetrics)
async def get_chain_metrics(
    chain_id: str,
    time_window_minutes: int = Query(
        DEFAULT_TIME_WINDOW_MINUTES,
        description="Number of minutes of data to fetch",
    ),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Get metrics for a specific chain"""
    try:
        # Get available chains
        available_chains = configuration_service.get_chains_providers_configuration
        if not available_chains:
            raise HTTPException(status_code=404, detail="No chains available")
        selected_chain = next(
            (chain for chain in available_chains if chain.id == chain_id), None
        )
        if not chain_id or not selected_chain:
            raise HTTPException(status_code=404, detail=f"Chain '{chain_id}' not found")

        # Fetch all required metrics in parallel
        (
            consumers_data,
            latency_data,
            chain_traffic_data,
            provider_health_data,
            consumer_latest_block_data,
            _,
        ) = await fetch_chain_metrics_data(
            svc, time_window_minutes, calculate_adaptive_step_size(time_window_minutes)
        )

        # Calculate metrics for the specific chain
        chain_metrics = ChainMetrics(
            network=selected_chain.network,
            uptime=calculate_uptime_percentage(consumers_data, selected_chain.id),
            latency_in_ms=calculate_latency_ms(latency_data, selected_chain.id),
            reachability=calculate_chain_reachability_percentage(
                provider_health_data,
                [
                    f"{selected_chain.id}-{provider.name}".lower()
                    for provider in selected_chain.providers
                ],
            ),
            requests_in_window=calculate_requests_in_time_window(
                chain_traffic_data, selected_chain.id
            ),
            latest_block=calculate_chain_latest_block_number(
                consumer_latest_block_data, selected_chain.network
            ),
        )

        return chain_metrics

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching chain metrics for '{chain_id}': {str(e)}",
        )


@router.get("/providers-metrics", response_model=ProvidersMetricsResponse)
async def get_providers_metrics(
    time_window_minutes: int = Query(
        DEFAULT_TIME_WINDOW_MINUTES,
        description="Number of minutes of data to fetch",
    ),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Get metrics for all providers"""
    try:
        # Get available providers
        available_chains = configuration_service.get_chains_providers_configuration
        if not available_chains:
            return ProvidersMetricsResponse(
                providers={},
                avg=ProviderMetrics(
                    uptime=0.0, latency_in_ms=0, requests_in_window=0, latest_block=0
                ),
                p90=ProviderMetrics(
                    uptime=0.0, latency_in_ms=0, requests_in_window=0, latest_block=0
                ),
            )

        # Fetch all required metrics in parallel
        (
            providers_data,
            provider_traffic_data,
            provider_latest_block_data,
            provider_latency_data,
        ) = await fetch_provider_metrics_data(
            svc,
            time_window_minutes,
            calculate_adaptive_step_size(time_window_minutes),
        )

        # Calculate metrics for each provider
        providers_data_dict = {}
        for chain in available_chains:
            for provider in chain.providers:
                provider_key = f"{chain.id}-{provider.name}".lower()
                providers_data_dict[provider_key] = ProviderMetrics(
                    provider_name=provider.name,
                    network=chain.network,
                    uptime=calculate_provider_uptime_percentage(
                        providers_data, provider_key
                    ),
                    latency_in_ms=calculate_provider_latency_ms(
                        provider_latency_data, provider_key
                    ),
                    requests_in_window=calculate_provider_requests_in_time_window(
                        provider_traffic_data, provider_key
                    ),
                    latest_block=calculate_provider_latest_block_number(
                        provider_latest_block_data, provider_key
                    ),
                )

        # Calculate statistical measures
        all_provider_metrics = list(
            providers_data_dict.values()
        )  # Extract values for statistics
        uptimes = [provider_metrics.uptime for provider_metrics in all_provider_metrics]
        requests = [
            provider_metrics.requests_in_window
            for provider_metrics in all_provider_metrics
        ]
        latencies = [
            provider_metrics.latency_in_ms
            for provider_metrics in all_provider_metrics
            if provider_metrics.latency_in_ms is not None
            and provider_metrics.latency_in_ms > 0
        ]

        # Create average metrics
        avg_latency = round(sum(latencies) / len(latencies)) if latencies else 0
        avg_metrics = ProviderMetrics(
            uptime=round(sum(uptimes) / len(all_provider_metrics), 2),
            latency_in_ms=avg_latency,
            requests_in_window=sum(requests),
            latest_block=0,  # No average for latest block
        )

        # Create 90th percentile metrics
        # quantiles requires at least 2 data points
        if len(all_provider_metrics) >= 2:
            p90_latency = (
                round(statistics.quantiles(latencies, n=10)[8])
                if len(latencies) >= 2
                else (latencies[0] if latencies else 0)
            )
            p90_metrics = ProviderMetrics(
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
                latest_block=0,  # No p90 for latest block
            )
        else:
            # If only one provider, use its values as p90
            p90_latency = latencies[0] if latencies else 0
            p90_metrics = ProviderMetrics(
                uptime=uptimes[0] if uptimes else 0.0,
                latency_in_ms=p90_latency,
                requests_in_window=requests[0] if requests else 0,
                latest_block=0,  # No p90 for latest block
            )

        return ProvidersMetricsResponse(
            providers=providers_data_dict, avg=avg_metrics, p90=p90_metrics
        )

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error fetching providers metrics: {str(e)}"
        )


@router.get("/chains-to-providers", response_model=ChainsToProvidersResponse)
async def get_chains_to_providers(
    time_window_minutes: int = Query(
        DEFAULT_TIME_WINDOW_MINUTES,
        description="Number of minutes of data to fetch",
    ),
    step_size: int = Query(
        DEFAULT_STEP_SIZE,
        description="Step size for range queries in seconds",
    ),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """Get mapping of chains to their providers using Chain and Provider dataclasses"""
    try:
        # Get chains from configuration service
        chains = configuration_service.get_chains_providers_configuration

        if not chains:
            return ChainsToProvidersResponse(chains=[])

        # Fetch all required metrics in parallel
        (
            _,
            _,
            _,
            provider_health_data,
            _,
            _,
        ) = await fetch_chain_metrics_data(
            svc, time_window_minutes, calculate_adaptive_step_size(time_window_minutes)
        )

        # Convert to dictionary format with chain_id as key
        chains_list = []
        for chain in chains:
            providers_per_chain = []
            for provider in chain.providers:
                # Get provider health from provider health breakdown
                provider_key = f"{chain.id}-{provider.name}".lower()
                provider_uptime = calculate_provider_uptime_percentage(
                    provider_health_data, provider_key
                )

                # Convert endpoints to SafeEndpoint (excluding URL and addons)
                safe_endpoints = [
                    {"interface": ep.interface} for ep in provider.endpoints
                ]

                providers_per_chain.append(
                    {
                        "name": provider.name,
                        "endpoints": safe_endpoints,
                        "health_status": (
                            ProviderHealth.HEALTHY
                            if provider_uptime > 0
                            else ProviderHealth.UNHEALTHY
                        ),
                    }
                )

            # Determine chain health status
            if all(
                p["health_status"] == ProviderHealth.HEALTHY
                for p in providers_per_chain
            ):
                chain_health = ChainHealth.HEALTHY
            elif all(
                p["health_status"] == ProviderHealth.UNHEALTHY
                for p in providers_per_chain
            ):
                chain_health = ChainHealth.UNHEALTHY
            else:
                chain_health = ChainHealth.MIXED

            chains_list.append(
                {
                    "id": chain.id,
                    "network": chain.network,
                    "providers": providers_per_chain,
                    "health_status": chain_health,
                }
            )

        return ChainsToProvidersResponse(chains=chains_list)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching chains-to-providers mapping: {str(e)}",
        )


async def fetch_usage_metrics_data(
    svc: PrometheusService, time_window_minutes: int
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any], datetime, datetime, int]:
    """Fetch all required metrics data for usage analysis in parallel.
    
    Uses per-function metrics:
    - lava_provider_total_relays_serviced_per_function (requests - all relays including errors)
    - lava_provider_request_latency_per_function (latency)
    - lava_provider_total_relays_errored_per_function (errors)
    
    Batch requests are identified by "&" in the function name (e.g., "getBlock&getBlock")
    
    Note: For total counts (requests, errors), we use instant queries with increase() over the
    full time range to avoid double-counting that would occur with query_range.
    For the time series graph, we use query_range with step-sized intervals.
    """
    time_range = f"{time_window_minutes}m"
    end_time = datetime.now()
    start_time = end_time - timedelta(minutes=time_window_minutes)
    graph_step_minutes = calculate_graph_step_minutes(time_window_minutes)

    # Fetch requests, latency, errors per function, and total relays over time
    (
        requests_data,
        latency_data,
        errors_data,
        total_relays_data,
    ) = await asyncio.gather(
        # Total requests per function - use increase() to get new requests in the time window
        svc.query(
            f'sum(increase({PROMETHEUS_QUERIES["requests_per_function"]}[{time_range}])) by (spec, function)',
        ),
        # Latency per function - average over the time window
        svc.query(
            f'avg(avg_over_time({PROMETHEUS_QUERIES["latency_per_function"]}[{time_range}])) by (spec, function)',
        ),
        # Errors per function - use increase() to get new errors in the time window
        svc.query(
            f'sum(increase({PROMETHEUS_QUERIES["errors_per_function"]}[{time_range}])) by (spec, function)',
        ),
        # Total relays over time (for graph) - use increase() to show new requests per interval
        # Note: increase() only shows changes when counters are actively incrementing
        svc.query_range(
            f'sum(increase({PROMETHEUS_QUERIES["requests_per_function"]}[{graph_step_minutes}m])) by (spec)',
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


def is_batch_function(function_name: str) -> bool:
    """Check if a function name represents a batch request (contains '&')."""
    return "&" in function_name


def get_batch_function_counts(function_name: str) -> dict[str, int]:
    """
    Parse a batch function name and return counts of individual functions.
    
    Example: "eth_call&eth_call&getSlot" -> {"eth_call": 2, "getSlot": 1}
    """
    functions = function_name.split("&")
    counts: dict[str, int] = {}
    for func in functions:
        counts[func] = counts.get(func, 0) + 1
    return counts


def get_normalized_batch_key(function_name: str) -> str:
    """
    Create a normalized display key for a batch function.
    Groups all permutations of the same function combination together.
    
    Example: 
      "eth_call&eth_call&getSlot" -> "2 x eth_call\n1 x getSlot"
      "getSlot&eth_call&eth_call" -> "2 x eth_call\n1 x getSlot"
      "eth_call&getSlot&eth_call" -> "2 x eth_call\n1 x getSlot"
    
    The output is sorted by count (descending), then alphabetically by function name.
    Each function is on a separate line for better readability.
    """
    counts = get_batch_function_counts(function_name)
    # Sort by count (descending), then alphabetically by function name
    sorted_funcs = sorted(counts.items(), key=lambda x: (-x[1], x[0]))
    parts = [f"{count} x {func}" for func, count in sorted_funcs]
    return "\n".join(parts)


def get_batch_size(function_name: str) -> int:
    """Get the batch size (number of functions in the batch)."""
    return len(function_name.split("&"))


def get_batch_size_from_normalized_key(normalized_key: str) -> int:
    """
    Get the batch size from a normalized key like "2 x eth_call, 1 x getSlot".
    
    Example: "2 x eth_call, 1 x getSlot" -> 3 (2 + 1)
    """
    matches = re.findall(r"(\d+) x", normalized_key)
    return sum(int(m) for m in matches) if matches else 1


def process_usage_data(
    requests_data: dict[str, Any],
    latency_data: dict[str, Any],
    errors_data: dict[str, Any],
    network: str,
    is_batch: bool,
) -> tuple[list[MethodUsage], int, int, int, float | None]:
    """
    Process Prometheus data to extract method-level usage metrics for a specific network.
    
    For regular requests: aggregates by function name directly.
    For batch requests: aggregates by normalized batch composition.
                        All permutations of the same composition are grouped together.
                        Example: "eth_call&eth_call&getSlot", "getSlot&eth_call&eth_call", 
                                 "eth_call&getSlot&eth_call" all become "2 x eth_call, 1 x getSlot"
    
    Args:
        requests_data: Prometheus data for requests per function
        latency_data: Prometheus data for latency per function
        errors_data: Prometheus data for errors per function
        network: Network/spec to filter by (e.g., "eth1", "base", "solana"), or "all" for all networks.
                 Prometheus spec label is the network in uppercase (e.g., ETH1, BASE, SOLANA).
        is_batch: If True, only process batch requests (functions with "&")
                  If False, only process single requests (functions without "&")
    
    Returns: (methods list, total_requests, total_individual_requests, total_errors, avg_latency)
             For regular requests, total_individual_requests equals total_requests.
             For batch requests, total_individual_requests is the sum of all individual function calls.
    """
    methods_dict: dict[str, dict] = {}
    total_requests = 0  # Total number of batch calls (for batch) or requests (for regular)
    total_individual_requests = 0  # Total individual function calls (for batch only)
    total_errors = 0
    latency_sum = 0.0
    latency_count = 0

    # Process requests data
    if requests_data.get("status") == "success" and requests_data.get("data", {}).get("result"):
        for series in requests_data["data"]["result"]:
            metric = series.get("metric", {})
            spec = metric.get("spec", "").lower()
            
            # Match network (case-insensitive) - Prometheus spec is network in uppercase
            if network.lower() != "all" and spec != network.lower():
                continue
            
            function_name = metric.get("function", "unknown")
            
            # Filter by batch vs single
            if is_batch_function(function_name) != is_batch:
                continue
            
            # Handle both instant query (value) and range query (values) formats
            value = series.get("value")
            values = series.get("values", [])
            
            if value:
                # Instant query format: [timestamp, value]
                raw_value = value[1] if len(value) > 1 else "0"
                method_requests = int(float(raw_value)) if raw_value != "NaN" else 0
            elif values:
                # Range query format: [[timestamp, value], ...]
                method_requests = int(sum(float(v[1]) for v in values if v[1] != "NaN"))
            else:
                continue
                
            if method_requests > 0:
                if is_batch:
                    # For batch: use normalized key to group all permutations together
                    normalized_key = get_normalized_batch_key(function_name)
                    batch_size = get_batch_size(function_name)
                    
                    if normalized_key not in methods_dict:
                        methods_dict[normalized_key] = {
                            "requests": 0,
                            "errors": 0,
                            "latency_sum": 0,
                            "latency_count": 0,
                            "batch_size": batch_size,
                        }
                    
                    methods_dict[normalized_key]["requests"] += method_requests
                    total_requests += method_requests
                    total_individual_requests += method_requests * batch_size
                else:
                    # For regular: use function name directly
                    if function_name not in methods_dict:
                        methods_dict[function_name] = {
                            "requests": 0,
                            "errors": 0,
                            "latency_sum": 0,
                            "latency_count": 0,
                        }
                    methods_dict[function_name]["requests"] += method_requests
                    total_requests += method_requests

    # Process errors data
    if errors_data.get("status") == "success" and errors_data.get("data", {}).get("result"):
        for series in errors_data["data"]["result"]:
            metric = series.get("metric", {})
            spec = metric.get("spec", "").lower()
            
            # Match network (case-insensitive)
            if network.lower() != "all" and spec != network.lower():
                continue
            
            function_name = metric.get("function", "unknown")
            
            # Filter by batch vs single
            if is_batch_function(function_name) != is_batch:
                continue
            
            # Handle both instant query (value) and range query (values) formats
            value = series.get("value")
            values = series.get("values", [])
            
            if value:
                # Instant query format: [timestamp, value]
                raw_value = value[1] if len(value) > 1 else "0"
                method_errors = int(float(raw_value)) if raw_value != "NaN" else 0
            elif values:
                # Range query format: [[timestamp, value], ...]
                method_errors = int(sum(float(v[1]) for v in values if v[1] != "NaN"))
            else:
                continue
                
            if method_errors > 0:
                if is_batch:
                    normalized_key = get_normalized_batch_key(function_name)
                    if normalized_key in methods_dict:
                        methods_dict[normalized_key]["errors"] += method_errors
                        total_errors += method_errors
                else:
                    if function_name in methods_dict:
                        methods_dict[function_name]["errors"] += method_errors
                        total_errors += method_errors

    # Process latency data
    if latency_data.get("status") == "success" and latency_data.get("data", {}).get("result"):
        for series in latency_data["data"]["result"]:
            metric = series.get("metric", {})
            spec = metric.get("spec", "").lower()
            
            # Match network (case-insensitive)
            if network.lower() != "all" and spec != network.lower():
                continue
            
            function_name = metric.get("function", "unknown")
            
            # Filter by batch vs single
            if is_batch_function(function_name) != is_batch:
                continue
            
            # Handle both instant query (value) and range query (values) formats
            value = series.get("value")
            values = series.get("values", [])
            
            method_avg_latency = None
            if value:
                # Instant query format: [timestamp, value]
                raw_value = value[1] if len(value) > 1 else None
                if raw_value and raw_value != "NaN":
                    method_avg_latency = float(raw_value)
            elif values:
                # Range query format: [[timestamp, value], ...]
                valid_latencies = [float(v[1]) for v in values if v[1] != "NaN"]
                if valid_latencies:
                    method_avg_latency = sum(valid_latencies) / len(valid_latencies)
            
            if method_avg_latency is not None:
                if is_batch:
                    normalized_key = get_normalized_batch_key(function_name)
                    if normalized_key in methods_dict:
                        methods_dict[normalized_key]["latency_sum"] += method_avg_latency
                        methods_dict[normalized_key]["latency_count"] += 1
                else:
                    if function_name in methods_dict:
                        methods_dict[function_name]["latency_sum"] += method_avg_latency
                        methods_dict[function_name]["latency_count"] += 1
                
                latency_sum += method_avg_latency
                latency_count += 1

    # Build method usage list (skip methods with 0 requests)
    methods_list = []
    
    for method_name, data in methods_dict.items():
        requests = data["requests"]
        
        # Skip methods with 0 requests
        if requests == 0:
            continue
        
        errors = data["errors"]
        error_rate = (errors / requests * 100) if requests > 0 else 0
        
        # Calculate latency (None if no data)
        method_latency = None
        if data["latency_count"] > 0:
            method_latency = round(data["latency_sum"] / data["latency_count"], 2)
        
        percentage = (requests / total_requests * 100) if total_requests > 0 else 0
        
        methods_list.append(
            MethodUsage(
                method=method_name,
                requests=requests,
                errors=errors,
                error_rate=round(error_rate, 2),
                avg_latency_ms=method_latency,
                percentage=round(percentage, 1),
            )
        )

    # Sort by requests descending
    methods_list.sort(key=lambda x: x.requests, reverse=True)

    # Calculate overall latency
    overall_latency = round(latency_sum / latency_count, 2) if latency_count > 0 else None

    # For regular requests, total_individual_requests = total_requests
    if not is_batch:
        total_individual_requests = total_requests
    
    return methods_list, total_requests, total_individual_requests, total_errors, overall_latency


def get_timestamp_format(time_window_minutes: int) -> str:
    """
    Get the appropriate timestamp format string based on time window.
    
    - <= 6 hours: HH:MM (e.g., "14:30")
    - <= 7 days: Mon HH:MM (e.g., "Mon 14:30") - shows day to avoid midnight confusion
    - > 7 days: Mon DD (e.g., "Jan 15")
    """
    if time_window_minutes <= 360:  # <= 6 hours
        return "%H:%M"
    elif time_window_minutes <= 10080:  # <= 7 days
        return "%a %H:%M"
    else:  # > 7 days
        return "%b %d"


def process_requests_over_time(
    total_relays_data: dict[str, Any],
    network: str,
    time_window_minutes: int,
    start_time: datetime,
    end_time: datetime,
    step_minutes: int,
) -> list[TimeSeriesDataPoint]:
    """
    Process total relays data to create a time series of requests aggregated in time buckets.
    
    Creates a continuous time series from start_time to end_time at step_minutes intervals,
    filling in zeros where Prometheus has no data. This ensures the graph shows the full
    time range even when data is sparse.
    
    Args:
        total_relays_data: Prometheus data for total relays (already at step intervals)
        network: Network/spec to filter by (e.g., "eth1", "base", "solana"), or "all" for all networks.
                 Prometheus spec label is the network in uppercase (e.g., ETH1, BASE, SOLANA).
        time_window_minutes: The time window in minutes (used for timestamp formatting)
        start_time: Start of the time range
        end_time: End of the time range
        step_minutes: Step size in minutes for the time series
    """
    # Sum values at each timestamp across all matching specs from Prometheus data
    timestamp_values: dict[float, float] = {}
    
    if total_relays_data.get("status") == "success" and total_relays_data.get("data", {}).get("result"):
        for series in total_relays_data["data"]["result"]:
            metric = series.get("metric", {})
            spec = metric.get("spec", "").lower()
            
            # Match network (case-insensitive) - Prometheus spec is network in uppercase
            if network.lower() != "all" and spec != network.lower():
                continue
            
            values = series.get("values", [])
            
            for timestamp, value in values:
                if value != "NaN":
                    ts = float(timestamp)
                    if ts not in timestamp_values:
                        timestamp_values[ts] = 0
                    timestamp_values[ts] += float(value)
    
    # Get appropriate timestamp format based on time window
    ts_format = get_timestamp_format(time_window_minutes)
    
    # Generate all expected timestamps from start to end at step intervals
    # This ensures we have a continuous time series even when Prometheus has gaps
    # Note: We generate timestamps up to the requested end_time, even if Prometheus
    # doesn't have data for the most recent period (due to scrape lag)
    requests_over_time: list[TimeSeriesDataPoint] = []
    step_seconds = step_minutes * 60
    
    # Align start_time to step boundary
    start_ts = start_time.timestamp()
    end_ts = end_time.timestamp()
    
    # Round start to nearest step boundary
    aligned_start = (int(start_ts) // step_seconds) * step_seconds
    
    # Round end to nearest step boundary (to ensure we include the final bucket)
    aligned_end = ((int(end_ts) // step_seconds) + 1) * step_seconds
    
    current_ts = aligned_start
    while current_ts <= aligned_end:
        # Find closest matching timestamp in data (within half a step)
        value = 0.0
        for data_ts, data_val in timestamp_values.items():
            if abs(data_ts - current_ts) < step_seconds / 2:
                value += data_val
        
        requests_over_time.append(
            TimeSeriesDataPoint(
                timestamp=datetime.fromtimestamp(current_ts).strftime(ts_format),
                value=round(value, 0),
            )
        )
        current_ts += step_seconds
    
    return requests_over_time


@router.get("/usage/{chain_id}", response_model=UsageMetricsResponse)
@router.get("/usage", response_model=UsageMetricsResponse)
async def get_usage_metrics(
    chain_id: str | None = None,
    time_window_minutes: int = Query(
        DEFAULT_TIME_WINDOW_MINUTES,
        description="Number of minutes of data to fetch",
    ),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """
    Get usage metrics including method-level breakdown for single and batch requests.
    
    Returns request counts, error counts, and latency metrics broken down by RPC method for each chain.
    
    Single requests: Functions without "&" in their name
    Batch requests: Functions with "&" in their name (e.g., "getBlock&getBlock")
    
    Latency is only available for single requests.
    If no latency data and total_relays == total_errors, status is "all_errors".
    """
    try:
        # Get available chains
        available_chains = configuration_service.get_chains_providers_configuration
        if not available_chains:
            return UsageMetricsResponse(chains={})

        # Filter to specific chain if requested (same logic as chains-metrics/{chain_id} endpoint)
        if chain_id:
            selected_chain = next(
                (chain for chain in available_chains if chain.id == chain_id), None
            )
            if not selected_chain:
                raise HTTPException(status_code=404, detail=f"Chain '{chain_id}' not found")
            available_chains = [selected_chain]

        # Fetch all usage metrics data in parallel
        (
            requests_data,
            latency_data,
            errors_data,
            total_relays_data,
            graph_start_time,
            graph_end_time,
            graph_step_minutes,
        ) = await fetch_usage_metrics_data(svc, time_window_minutes)

        # Process metrics for each chain
        chains_usage: dict[str, ChainUsageMetrics] = {}
        
        for chain in available_chains:
            # Process regular requests (functions without "&")
            # Note: Prometheus spec label matches chain.network in uppercase (e.g., ETH1, BASE, SOLANA)
            (
                single_methods,
                single_total,
                _,  # total_individual same as total for regular
                single_errors,
                single_avg_latency,
            ) = process_usage_data(requests_data, latency_data, errors_data, chain.network, is_batch=False)

            # Process batch requests (functions with "&")
            (
                batch_methods,
                batch_total,
                _,  # Not used
                batch_errors,
                batch_avg_latency,
            ) = process_usage_data(requests_data, latency_data, errors_data, chain.network, is_batch=True)

            # Get requests over time (all relays) - fills gaps with zeros for continuous graph
            requests_over_time = process_requests_over_time(
                total_relays_data, 
                chain.network, 
                time_window_minutes,
                graph_start_time,
                graph_end_time,
                graph_step_minutes,
            )

            # Calculate average batch size from unique batch compositions
            # Sum of batch sizes for each unique composition / number of unique compositions
            if batch_methods:
                total_batch_sizes = sum(get_batch_size_from_normalized_key(m.method) for m in batch_methods)
                avg_batch_size = total_batch_sizes / len(batch_methods)
            else:
                avg_batch_size = 0.0

            # Calculate error rates
            single_error_rate = (single_errors / single_total * 100) if single_total > 0 else 0
            batch_error_rate = (batch_errors / batch_total * 100) if batch_total > 0 else 0

            chains_usage[chain.id] = ChainUsageMetrics(
                chain_id=chain.id,
                network=chain.network,
                single=RequestTypeUsage(
                    total_requests=single_total,
                    total_errors=single_errors,
                    error_rate=round(single_error_rate, 2),
                    avg_latency_ms=single_avg_latency,
                    methods=single_methods,
                    requests_over_time=requests_over_time,
                ),
                batch=BatchRequestUsage(
                    total_requests=batch_total,
                    total_errors=batch_errors,
                    error_rate=round(batch_error_rate, 2),
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
            status_code=500,
            detail=f"Error fetching usage metrics: {str(e)}",
        )


@router.get("/dashboard-summary", response_model=DashboardSummaryMetrics)
async def get_dashboard_summary_metrics(
    time_window_minutes: int = Query(
        DEFAULT_TIME_WINDOW_MINUTES,
        description="Time window in minutes for rate calculations",
    ),
    choosen_network: str | None = Query(
        default=None,
        description="If provided, filter metrics to this network/spec only",
    ),
    svc: PrometheusService = Depends(get_prometheus_service),
    current_user: str = Depends(get_current_user),
):
    """
    Get dashboard summary metrics including:
    - Total requests (from consumer traffic)
    - Cache hit rate (cache_total_hits / total_relays_serviced)
    - Node error recovery statistics
    
    Optionally filter by network/spec.
    """
    try:
        time_range = f"{time_window_minutes}m"
        
        # Build spec filter if network is specified
        # Note: Prometheus spec label is in uppercase (e.g., ETH1, BASE, SOLANA)
        spec_filter = f'{{spec="{choosen_network.upper()}"}}' if choosen_network else ""
        
        # Build the queries
        # Total requests from consumer traffic
        total_requests_query = f"sum(increase({PROMETHEUS_QUERIES['consumer_traffic']}{spec_filter}[{time_range}]))"
        
        # Cache hits - for cache hit rate calculation
        cache_hits_query = f"sum(increase({PROMETHEUS_QUERIES['cache_hits']}{spec_filter}[{time_range}]))"
        
        # Node errors metrics - use increase() for actual counts in time window
        total_errors_query = f"sum(increase({PROMETHEUS_QUERIES['total_node_errors']}{spec_filter}[{time_range}]))"
        recovered_errors_query = f"sum(increase({PROMETHEUS_QUERIES['recovered_errors']}{spec_filter}[{time_range}]))"
        
        # Recovery by attempt number
        recovery_by_attempt_query = f"sum by (attempt) (increase({PROMETHEUS_QUERIES['recovered_errors']}{spec_filter}[{time_range}]))"
        
        # Errors by chain/spec (only when not filtering by specific network)
        errors_by_chain_query = f"sum by (spec) (increase({PROMETHEUS_QUERIES['total_node_errors']}[{time_range}]))"
        
        # Execute all queries in parallel
        (
            total_requests_data,
            cache_hits_data,
            total_errors_data,
            recovered_errors_data,
            recovery_by_attempt_data,
            errors_by_chain_data,
        ) = await asyncio.gather(
            svc.query(total_requests_query),
            svc.query(cache_hits_query),
            svc.query(total_errors_query),
            svc.query(recovered_errors_query),
            svc.query(recovery_by_attempt_query),
            svc.query(errors_by_chain_query),
        )
        
        # Extract values from Prometheus responses
        def extract_scalar(data: dict) -> float:
            """Extract scalar value from Prometheus instant query result."""
            if data.get("status") != "success":
                return 0.0
            result = data.get("data", {}).get("result", [])
            if not result:
                return 0.0
            # For instant queries, value is [timestamp, value]
            value = result[0].get("value", [0, "0"])
            try:
                return float(value[1])
            except (ValueError, IndexError):
                return 0.0
        
        def extract_by_label(data: dict, label: str) -> dict[str, float]:
            """Extract values grouped by a label from Prometheus query result."""
            result_dict: dict[str, float] = {}
            if data.get("status") != "success":
                return result_dict
            results = data.get("data", {}).get("result", [])
            for item in results:
                metric = item.get("metric", {})
                label_value = metric.get(label, "unknown")
                value = item.get("value", [0, "0"])
                try:
                    result_dict[label_value] = float(value[1])
                except (ValueError, IndexError):
                    result_dict[label_value] = 0.0
            return result_dict
        
        # Parse the results
        total_requests = extract_scalar(total_requests_data)
        cache_hits = extract_scalar(cache_hits_data)
        total_node_errors = extract_scalar(total_errors_data)
        recovered_requests = extract_scalar(recovered_errors_data)
        
        # Calculate cache hit rate: cache_hits / total_requests * 100
        cache_hit_rate = (cache_hits / total_requests * 100) if total_requests > 0 else 0.0
        
        # Calculate recovery rate
        recovery_rate = (recovered_requests / total_node_errors * 100) if total_node_errors > 0 else 0.0
        
        # Extract grouped data
        recovery_by_attempt = extract_by_label(recovery_by_attempt_data, "attempt")
        errors_by_chain = extract_by_label(errors_by_chain_data, "spec")
        
        return DashboardSummaryMetrics(
            total_requests=round(total_requests, 0),
            cache_hit_rate=round(cache_hit_rate, 2),
            cache_hits=round(cache_hits, 0),
            cache_misses=round(total_requests - cache_hits, 0),  # Derived from total - hits
            error_recovery=ErrorRecoveryMetrics(
                total_node_errors=round(total_node_errors, 0),  # Actual count
                recovered_requests=round(recovered_requests, 0),  # Actual count
                recovery_rate=round(recovery_rate, 2),
                recovery_by_attempt={k: round(v, 0) for k, v in recovery_by_attempt.items()},
                errors_by_chain={k: round(v, 0) for k, v in errors_by_chain.items()},
            ),
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching dashboard summary metrics: {str(e)}",
        )
