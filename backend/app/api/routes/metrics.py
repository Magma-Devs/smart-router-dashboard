import asyncio
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
)
from app.core.calculations import (
    calculate_adaptive_step_size,
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
                    consumer_latest_block_data, chain.id
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
                consumer_latest_block_data, selected_chain.id
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
                    {"interface": ep.interface}
                    for ep in provider.endpoints
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
