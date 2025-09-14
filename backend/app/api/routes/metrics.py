import asyncio
import statistics
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from functools import wraps
from typing import Callable, TypeVar

from app.core.auth import get_current_user
from app.services.prometheus import prometheus_service, PrometheusService
from app.services.configuration import configuration_service

T = TypeVar("T")


# Pydantic models for API responses
class ChainMetrics(BaseModel):
    uptime: float
    latency_in_ms: int
    reachability: float  # Percentage of healthy providers for this chain
    requests_per_day: int
    latest_block: int


class ProviderMetrics(BaseModel):
    uptime: float
    latency_in_ms: int | None  # Providers don't have latency metrics
    requests_per_day: int
    latest_block: int


class ChainsResponse(BaseModel):
    chains: dict[str, ChainMetrics]
    avg: ChainMetrics
    p90: ChainMetrics


class ProvidersResponse(BaseModel):
    providers: dict[str, ProviderMetrics]
    avg: ProviderMetrics
    p90: ProviderMetrics


router = APIRouter()

# Prometheus query constants
PROMETHEUS_QUERIES = {
    "consumer_health": "lava_consumer_overall_health_breakdown",
    "provider_health": "lava_provider_overall_health_breakdown",
    "consumer_traffic": "lava_consumer_total_relays_serviced",
    "provider_traffic": "lava_provider_total_relays_serviced",
    "consumer_latest_block": "lava_consumer_latest_provider_block",
    "provider_latest_block": "lava_latest_block",
    "consumer_latency": "lava_consumer_average_latency_in_milliseconds",
}

# Default values
DEFAULT_TIME_WINDOW_MINUTES = 15
DEFAULT_STEP_SIZE = 5


def calculate_adaptive_step_size(
    time_window_minutes: int, target_points: int = 200
) -> int:
    """
    Calculate adaptive step size to keep data points reasonable.
    Target ~200 data points regardless of time window.
    """
    # Calculate step size needed for target number of points
    total_seconds = time_window_minutes * 60
    calculated_step = max(1, total_seconds // target_points)

    # Round to reasonable intervals (1, 5, 10, 15, 30, 60, 300, 600, etc.)
    if calculated_step <= 1:
        return 1
    elif calculated_step <= 5:
        return 5
    elif calculated_step <= 10:
        return 10
    elif calculated_step <= 15:
        return 15
    elif calculated_step <= 30:
        return 30
    elif calculated_step <= 60:
        return 60
    elif calculated_step <= 300:
        return 300
    elif calculated_step <= 600:
        return 600
    elif calculated_step <= 1800:
        return 1800  # 30 minutes
    else:
        return 3600  # 1 hour


def validate_prometheus_data(func: Callable[..., T]) -> Callable[..., T]:
    """
    Decorator to validate Prometheus data structure before processing.

    Validates that the data has:
    - status == "success"
    - data.result exists and is not empty

    Returns the original function result or 0/0.0 for invalid data.
    """

    @wraps(func)
    def wrapper(data: dict[str, Any], *args, **kwargs) -> T:
        if (
            not data
            or data.get("status") != "success"
            or not data.get("data", {}).get("result")
        ):
            # Return appropriate default value based on function name
            if "percentage" in func.__name__:
                return 0.0
            else:
                return 0

        results = data["data"]["result"]
        if not results:
            if "percentage" in func.__name__:
                return 0.0
            else:
                return 0

        return func(data, *args, **kwargs)

    return wrapper


def get_prometheus_service() -> PrometheusService:
    return prometheus_service


# Helper functions


def get_available_chains() -> list[str]:
    """Get list of available chains from configuration."""
    consumer_path = f"{configuration_service.values_dir}/core/consumer.values.yml"
    consumer_data = configuration_service.read_yaml_file(consumer_path)

    if not consumer_data or "chains" not in consumer_data:
        return []

    return list(consumer_data["chains"].keys())


def get_providers_for_chain(chain_id: str) -> list[str]:
    """
    Get list of provider names that serve a specific chain.

    Reads provider configuration and returns providers that have the specified id.

    Args:
        chain_id: The chain identifier (e.g., "eth1", "arbitrum", "cosmoshub")

    Returns:
        List of provider names that serve this chain

    Example:
        get_providers_for_chain("eth1") -> ["eth-lava"]
        get_providers_for_chain("arbitrum") -> ["arbitrum-lava"]
    """
    try:
        provider_path = f"{configuration_service.values_dir}/core/provider.values.yml"
        provider_config = configuration_service.read_yaml_file(provider_path)

        if not provider_config or "chains" not in provider_config:
            return []

        providers = []

        # Find all providers that serve this chain_id
        for provider in provider_config["chains"]:
            if provider.get("id") == chain_id:
                provider_name = provider.get("name")
                if provider_name and provider_name not in providers:
                    providers.append(provider_name)

        return providers
    except Exception as e:
        print(f"Error getting providers for chain {chain_id}: {e}")
        return []


def get_available_providers() -> list[str]:
    """Get list of available providers from provider configuration."""
    provider_path = f"{configuration_service.values_dir}/core/provider.values.yml"
    provider_data = configuration_service.read_yaml_file(provider_path)

    if not provider_data or "chains" not in provider_data:
        return []

    available_providers = []
    for provider in provider_data["chains"]:
        if "name" in provider:
            available_providers.append(provider["name"])

    return available_providers


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
            f"avg_over_time({PROMETHEUS_QUERIES['consumer_latency']}[{time_range}])",
            start_time,
            end_time,
            f"{step_size}s",
        ),
        svc.query_range(
            PROMETHEUS_QUERIES["consumer_traffic"],
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
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Fetch all required metrics data for providers in parallel."""
    end_time = datetime.now()
    start_time = end_time - timedelta(minutes=time_window_minutes)

    providers_data, provider_traffic_data, provider_latest_block_data = (
        await asyncio.gather(
            svc.query_range(
                PROMETHEUS_QUERIES["provider_health"],
                start_time,
                end_time,
                f"{step_size}s",
            ),
            svc.query_range(
                PROMETHEUS_QUERIES["provider_traffic"],
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
    )

    return providers_data, provider_traffic_data, provider_latest_block_data


# Calculation utilities moved from frontend
@validate_prometheus_data
def calculate_uptime_percentage(
    health_data: dict[str, Any], target_chain: str
) -> float:
    """Calculate uptime percentage for a specific chain from health data"""
    results = health_data["data"]["result"]
    total_healthy_time = 0
    total_time = 0

    for result in results:
        spec = result.get("metric", {}).get("spec")

        # For "all chains", process all results
        if target_chain == "all":
            pass  # Process all results without spec filtering
        else:
            # For specific chains, filter by target chain
            if not spec or spec.lower() != target_chain.lower():
                continue

        values = result.get("values", [])

        for timestamp, value in values:
            # Convert string value to float for comparison
            try:
                health_value = float(value)
                is_healthy = health_value == 1.0
            except (ValueError, TypeError):
                is_healthy = value == "1"  # Fallback to string comparison

            total_time += 1
            if is_healthy:
                total_healthy_time += 1

    return (total_healthy_time / total_time * 100) if total_time > 0 else 0.0


@validate_prometheus_data
def calculate_latency_ms(latency_data: dict[str, Any], target_chain: str) -> int:
    """Calculate average latency in milliseconds for a specific chain"""
    results = latency_data["data"]["result"]
    total_latency = 0
    total_samples = 0

    for result in results:
        spec = result.get("metric", {}).get("spec")
        if not spec:
            continue

        # Filter by target chain if not "all"
        if target_chain != "all" and spec.lower() != target_chain.lower():
            continue

        values = result.get("values", [])
        for timestamp, value in values:
            try:
                latency_ms = float(value)
                total_latency += latency_ms
                total_samples += 1
            except (ValueError, TypeError):
                continue

    return int(total_latency / total_samples) if total_samples > 0 else 0


@validate_prometheus_data
def calculate_requests_per_day(traffic_data: dict[str, Any], target_chain: str) -> int:
    """Calculate requests per day for a specific chain"""
    results = traffic_data["data"]["result"]
    total_relays = 0

    for result in results:
        spec = result.get("metric", {}).get("spec")

        # Filter by target chain
        if not spec or spec.lower() != target_chain.lower():
            continue

        values = result.get("values", [])
        if values:
            # Get the latest value (most recent)
            latest_value = values[-1]
            try:
                relays_value = float(latest_value[1])
                total_relays += relays_value
            except (ValueError, TypeError, IndexError):
                continue

    return int(total_relays)


@validate_prometheus_data
def calculate_consumer_latest_block_number(
    block_data: dict[str, Any], target_chain: str
) -> int:
    """Calculate the latest block number for a specific chain from consumer data"""
    results = block_data["data"]["result"]
    latest_block = 0

    for result in results:
        spec = result.get("metric", {}).get("spec")

        # Filter by target chain (consumer query only needs spec)
        if not spec or spec.lower() != target_chain.lower():
            continue

        values = result.get("values", [])
        if values:
            # Get the latest value (most recent)
            latest_value = values[-1]
            try:
                block_value = float(latest_value[1])
                latest_block = max(latest_block, int(block_value))
            except (ValueError, TypeError, IndexError):
                continue

    return latest_block


@validate_prometheus_data
def calculate_provider_latest_block_number(
    block_data: dict[str, Any], target_provider: str
) -> int:
    """Calculate the latest block number for a specific provider"""
    results = block_data["data"]["result"]
    latest_block = 0

    for result in results:
        service = result.get("metric", {}).get("service")

        # Filter by target provider (provider query needs service field)
        # The service field contains the provider name with "-provider" suffix
        if not service or not service.endswith("-provider"):
            continue

        # Extract provider name by removing "-provider" suffix
        provider_name = service.replace("-provider", "")
        if provider_name.lower() != target_provider.lower():
            continue

        values = result.get("values", [])
        if values:
            # Get the latest value (most recent)
            latest_value = values[-1]
            try:
                block_value = float(latest_value[1])
                latest_block = max(latest_block, int(block_value))
            except (ValueError, TypeError, IndexError):
                continue

    return latest_block


@validate_prometheus_data
def calculate_chain_reachability_percentage(
    provider_health_data: dict[str, Any], chain_providers: list[str]
) -> float:
    """
    Calculate overall reachability for a chain based on its providers' health.

    Reachability represents the percentage of providers that are healthy/reachable
    for a given chain. This gives a measure of how many providers are available
    to serve requests for this chain.

    Args:
        provider_health_data: Prometheus health data for all providers
        chain_providers: List of provider names that serve this chain

    Returns:
        float: Percentage of healthy providers (0-100)

    Example:
        If a chain has 3 providers and 2 are healthy: reachability = 66.7%
    """
    if not chain_providers:
        return 0.0

    total_reachability = 0.0
    providers_checked = 0

    for provider in chain_providers:
        try:
            provider_uptime = calculate_provider_uptime_percentage(
                provider_health_data, provider
            )
            total_reachability += provider_uptime
            providers_checked += 1
        except Exception:
            # If we can't get provider health, treat as 0% uptime
            providers_checked += 1
            continue

    return (total_reachability / providers_checked) if providers_checked > 0 else 0.0


@validate_prometheus_data
def calculate_provider_uptime_percentage(
    provider_health_data: dict[str, Any], target_provider: str
) -> float:
    """Calculate uptime percentage for a specific provider from provider health data"""
    results = provider_health_data["data"]["result"]
    total_healthy_time = 0
    total_time = 0

    for result in results:
        service = result.get("metric", {}).get("service")
        if not service:
            continue

        # Check if service matches targetProvider or targetProvider-provider
        service_matches = (
            service.lower() == target_provider.lower()
            or service.lower() == f"{target_provider.lower()}-provider"
        )

        if not service_matches:
            continue

        values = result.get("values", [])

        for timestamp, value in values:
            try:
                health_value = float(value)
                # lava_provider_overall_health_breakdown is 0-1, so multiply by 100 for percentage
                uptime_percentage = health_value * 100
                total_time += 1
                total_healthy_time += uptime_percentage
            except (ValueError, TypeError):
                continue

    return (total_healthy_time / total_time) if total_time > 0 else 0.0


@validate_prometheus_data
def calculate_provider_requests_per_day(
    provider_traffic_data: dict[str, Any], target_provider: str
) -> int:
    """Calculate requests per day for a specific provider"""
    results = provider_traffic_data["data"]["result"]
    total_relays = 0

    for result in results:
        service = result.get("metric", {}).get("service")
        if not service:
            continue

        # Check if service matches targetProvider or targetProvider-provider
        service_matches = (
            service.lower() == target_provider.lower()
            or service.lower() == f"{target_provider.lower()}-provider"
        )

        if not service_matches:
            continue

        values = result.get("values", [])
        if values:
            # Get the latest value (most recent)
            latest_value = values[-1]
            try:
                relays_value = float(latest_value[1])
                total_relays += relays_value
            except (ValueError, TypeError, IndexError):
                continue

    return int(total_relays)


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


@router.get("/chains", response_model=ChainsResponse)
async def get_chains_metrics(
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
    """Get metrics for all chains"""
    try:
        # Get available chains
        available_chains = get_available_chains()
        if not available_chains:
            return ChainsResponse(
                chains={},
                avg=ChainMetrics(
                    uptime=0.0,
                    latency_in_ms=0,
                    reachability=0.0,
                    requests_per_day=0,
                    latest_block=0,
                ),
                p90=ChainMetrics(
                    uptime=0.0,
                    latency_in_ms=0,
                    reachability=0.0,
                    requests_per_day=0,
                    latest_block=0,
                ),
            )

        # Use adaptive step size for better performance
        adaptive_step_size = calculate_adaptive_step_size(time_window_minutes)

        # Fetch all required metrics in parallel
        (
            consumers_data,
            latency_data,
            chain_traffic_data,
            provider_health_data,
            consumer_latest_block_data,
            provider_latest_block_data,
        ) = await fetch_chain_metrics_data(svc, time_window_minutes, adaptive_step_size)

        # Calculate metrics for each chain
        chains_data = {}
        for chain_id in available_chains:
            # Get providers for this chain to calculate reachability
            chain_providers = get_providers_for_chain(chain_id)

            chains_data[chain_id] = ChainMetrics(
                uptime=calculate_uptime_percentage(consumers_data, chain_id),
                latency_in_ms=calculate_latency_ms(latency_data, chain_id),
                reachability=calculate_chain_reachability_percentage(
                    provider_health_data, chain_providers
                ),
                requests_per_day=calculate_requests_per_day(
                    chain_traffic_data, chain_id
                ),
                latest_block=calculate_consumer_latest_block_number(
                    consumer_latest_block_data, chain_id
                ),
            )

        # Calculate statistical measures
        all_chains = list(chains_data.values())
        total_chains = len(all_chains)

        if total_chains > 0:
            # Extract values for statistics
            uptimes = [chain.uptime for chain in all_chains]
            latencies = [chain.latency_in_ms for chain in all_chains]
            reachabilities = [chain.reachability for chain in all_chains]
            requests = [chain.requests_per_day for chain in all_chains]

            # Create average metrics
            avg_metrics = ChainMetrics(
                uptime=round(sum(uptimes) / total_chains, 2),
                latency_in_ms=int(round(sum(latencies) / total_chains)),
                reachability=round(sum(reachabilities) / total_chains, 2),
                requests_per_day=sum(requests),
                latest_block=0,  # No average for latest block
            )

            # Create 90th percentile metrics
            p90_metrics = ChainMetrics(
                uptime=round(statistics.quantiles(uptimes, n=10)[8], 2),
                latency_in_ms=int(round(statistics.quantiles(latencies, n=10)[8])),
                reachability=round(statistics.quantiles(reachabilities, n=10)[8], 2),
                requests_per_day=round(statistics.quantiles(requests, n=10)[8]),
                latest_block=0,  # No p90 for latest block
            )
        else:
            avg_metrics = ChainMetrics(
                uptime=0.0,
                latency_in_ms=0,
                reachability=0.0,
                requests_per_day=0,
                latest_block=0,
            )
            p90_metrics = ChainMetrics(
                uptime=0.0,
                latency_in_ms=0,
                reachability=0.0,
                requests_per_day=0,
                latest_block=0,
            )

        return ChainsResponse(chains=chains_data, avg=avg_metrics, p90=p90_metrics)

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error fetching chains metrics: {str(e)}"
        )


@router.get("/chains/{chain_id}")
async def get_chain_metrics(
    chain_id: str,
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
    """Get metrics for a specific chain"""
    try:
        # Validate chain exists
        available_chains = get_available_chains()
        if chain_id not in available_chains:
            raise HTTPException(
                status_code=404,
                detail=f"Chain '{chain_id}' not found. Available chains: {available_chains}",
            )

        # Use adaptive step size for better performance
        adaptive_step_size = calculate_adaptive_step_size(time_window_minutes)

        # Fetch all required metrics in parallel
        (
            consumers_data,
            latency_data,
            chain_traffic_data,
            provider_health_data,
            consumer_latest_block_data,
            _,
        ) = await fetch_chain_metrics_data(svc, time_window_minutes, adaptive_step_size)

        # Get providers for this chain to calculate reachability
        chain_providers = get_providers_for_chain(chain_id)

        # Calculate metrics for the specific chain
        chain_metrics = {
            "uptime": calculate_uptime_percentage(consumers_data, chain_id),
            "latency_in_ms": calculate_latency_ms(latency_data, chain_id),
            "reachability": calculate_chain_reachability_percentage(
                provider_health_data, chain_providers
            ),
            "requests_per_day": calculate_requests_per_day(
                chain_traffic_data, chain_id
            ),
            "latest_block": calculate_consumer_latest_block_number(
                consumer_latest_block_data, chain_id
            ),
        }

        return chain_metrics

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching chain metrics for {chain_id}: {str(e)}",
        )


@router.get("/providers", response_model=ProvidersResponse)
async def get_providers_metrics(
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
    """Get metrics for all providers"""
    try:
        # Get available providers
        available_providers = get_available_providers()
        if not available_providers:
            return ProvidersResponse(
                providers={},
                avg=ProviderMetrics(
                    uptime=0.0, latency_in_ms=0, requests_per_day=0, latest_block=0
                ),
                p90=ProviderMetrics(
                    uptime=0.0, latency_in_ms=0, requests_per_day=0, latest_block=0
                ),
            )

        # Use adaptive step size for better performance
        adaptive_step_size = calculate_adaptive_step_size(time_window_minutes)

        # Fetch all required metrics in parallel
        providers_data, provider_traffic_data, provider_latest_block_data = (
            await fetch_provider_metrics_data(
                svc, time_window_minutes, adaptive_step_size
            )
        )

        # Calculate metrics for each provider
        providers_data_dict = {}
        for provider_id in available_providers:
            providers_data_dict[provider_id] = ProviderMetrics(
                uptime=calculate_provider_uptime_percentage(
                    providers_data, provider_id
                ),
                latency_in_ms=None,  # Providers don't have latency metrics
                requests_per_day=calculate_provider_requests_per_day(
                    provider_traffic_data, provider_id
                ),
                latest_block=calculate_provider_latest_block_number(
                    provider_latest_block_data, provider_id
                ),
            )

        # Calculate statistical measures
        all_providers = list(providers_data_dict.values())
        total_providers = len(all_providers)

        if total_providers > 0:
            # Extract values for statistics
            uptimes = [provider.uptime for provider in all_providers]
            requests = [provider.requests_per_day for provider in all_providers]

            # Create average metrics (no latency for providers)
            avg_metrics = ProviderMetrics(
                uptime=round(sum(uptimes) / total_providers, 2),
                latency_in_ms=None,  # Providers don't have latency metrics
                requests_per_day=sum(requests),
                latest_block=0,  # No average for latest block
            )

            # Create 90th percentile metrics (no latency for providers)
            p90_metrics = ProviderMetrics(
                uptime=round(statistics.quantiles(uptimes, n=10)[8], 2),
                latency_in_ms=None,  # Providers don't have latency metrics
                requests_per_day=round(statistics.quantiles(requests, n=10)[8]),
                latest_block=0,  # No p90 for latest block
            )
        else:
            avg_metrics = ProviderMetrics(
                uptime=0.0, latency_in_ms=None, requests_per_day=0, latest_block=0
            )
            p90_metrics = ProviderMetrics(
                uptime=0.0, latency_in_ms=None, requests_per_day=0, latest_block=0
            )

        return ProvidersResponse(
            providers=providers_data_dict, avg=avg_metrics, p90=p90_metrics
        )

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error fetching providers metrics: {str(e)}"
        )


@router.get("/providers/{provider_id}")
async def get_provider_metrics(
    provider_id: str,
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
    """Get metrics for a specific provider"""
    try:
        # Validate provider exists
        available_providers = get_available_providers()
        if provider_id not in available_providers:
            raise HTTPException(
                status_code=404,
                detail=f"Provider '{provider_id}' not found. Available providers: {available_providers}",
            )

        # Use adaptive step size for better performance
        adaptive_step_size = calculate_adaptive_step_size(time_window_minutes)

        # Fetch all required metrics in parallel
        providers_data, provider_traffic_data, _ = await fetch_provider_metrics_data(
            svc, time_window_minutes, adaptive_step_size
        )

        # Calculate metrics for the specific provider
        provider_metrics = {
            "uptime": calculate_provider_uptime_percentage(providers_data, provider_id),
            "latency_in_ms": None,  # Providers don't have latency metrics
            "requests_per_day": calculate_provider_requests_per_day(
                provider_traffic_data, provider_id
            ),
        }

        return provider_metrics

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching provider metrics for {provider_id}: {str(e)}",
        )


class ProviderInfo(BaseModel):
    """Provider information"""

    name: str
    interface: str
    endpoint: str
    health_status: bool  # From provider health breakdown metric


class ChainInfo(BaseModel):
    """Chain information"""

    chain_id: str
    consumer_health: bool  # From consumer health breakdown metric
    providers: list[ProviderInfo]


class ChainsToProvidersResponse(BaseModel):
    """Response model for chains-to-providers endpoint"""

    chains: list[ChainInfo]


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
    """Get mapping of chains to their providers with health data"""
    try:
        # Get available chains
        available_chains = get_available_chains()
        if not available_chains:
            return ChainsToProvidersResponse(chains=[])

        # Use adaptive step size for better performance
        adaptive_step_size = calculate_adaptive_step_size(time_window_minutes)

        # Fetch all required metrics in parallel
        (
            consumers_data,
            _,
            _,
            provider_health_data,
            _,
            _,
        ) = await fetch_chain_metrics_data(svc, time_window_minutes, adaptive_step_size)

        # Build chains-to-providers mapping
        chains_info = []

        for chain_id in available_chains:
            # Get chain health from consumer health breakdown
            consumer_uptime = calculate_uptime_percentage(consumers_data, chain_id)
            consumer_health = consumer_uptime > 0

            # Get providers for this chain
            chain_providers = get_providers_for_chain(chain_id)
            providers_info = []

            for provider_name in chain_providers:
                # Get provider health from provider health breakdown
                provider_uptime = calculate_provider_uptime_percentage(
                    provider_health_data, provider_name
                )
                provider_health = provider_uptime > 0

                # Get interface and endpoint from configuration
                interface = "jsonrpc"  # Default
                endpoint = (
                    f"{provider_name}.lava-infra.svc.cluster.local:2200"  # Default
                )

                try:
                    provider_path = (
                        f"{configuration_service.values_dir}/core/provider.values.yml"
                    )
                    provider_data = configuration_service.read_yaml_file(provider_path)

                    if provider_data and "chains" in provider_data:
                        for provider in provider_data["chains"]:
                            if (
                                provider.get("name") == provider_name
                                and provider.get("id") == chain_id
                            ):
                                # Get interface
                                interfaces = provider.get("interfaces", [])
                                if interfaces:
                                    interface = interfaces[0].get(
                                        "interface", "jsonrpc"
                                    )

                                    # Get endpoint from first node
                                    nodes = interfaces[0].get("nodes", [])
                                    if nodes:
                                        endpoint = nodes[0].get("endpoint", endpoint)
                                break
                except Exception:
                    # Use defaults if config read fails
                    pass

                providers_info.append(
                    ProviderInfo(
                        name=provider_name,
                        interface=interface,
                        endpoint=endpoint,
                        health_status=provider_health,
                    )
                )

            chains_info.append(
                ChainInfo(
                    chain_id=chain_id,
                    consumer_health=consumer_health,
                    providers=providers_info,
                )
            )

        return ChainsToProvidersResponse(chains=chains_info)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching chains-to-providers mapping: {str(e)}",
        )
