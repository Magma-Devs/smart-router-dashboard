# Calculation utilities moved from frontend
import logging
from functools import wraps
from typing import Any, Callable, TypeVar

logger = logging.getLogger(__name__)
T = TypeVar("T")


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


@validate_prometheus_data
def calculate_uptime_percentage(
    health_data: dict[str, Any], target_chain: str
) -> float:
    """Calculate uptime percentage for a specific chain from health data"""
    results = health_data["data"]["result"]
    total_healthy_time = 0
    total_time = 0

    # Track services we've seen to log duplicates
    seen_services = set()

    for result in results:
        service = result.get("metric", {}).get("service")

        # For "all chains", process all results
        if target_chain == "all":
            pass  # Process all results without filtering
        else:
            # For specific chains, filter by target chain
            # Filter by target chain (consumer query needs service field)
            # The service field contains the chain name with "-consumer" suffix
            if not service or not service.endswith("-consumer"):
                continue

            # Extract chain name by removing "-consumer" suffix
            chain_name = service.replace("-consumer", "")
            if not chain_name or chain_name.lower() != target_chain.lower():
                continue

            # Log duplicate services for the same chain
            if service in seen_services:
                logger.warning(
                    f"Duplicate service found for chain {target_chain}: {service}. "
                    "Continuing with calculation (will aggregate values)."
                )
            seen_services.add(service)

        values = result.get("values", [])

        for _, value in values:
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
    """
    Get the latest latency value for a specific chain.

    The input data is pre-aggregated by Prometheus using:
    avg(avg_over_time(lava_consumer_end_to_end_latency_milliseconds[time_window])) by (service)

    Prometheus already calculates the average across all time points,
    so we just return the latest value from the time series.
    """
    results = latency_data["data"]["result"]

    for result in results:
        metric = result.get("metric", {})
        service = metric.get("service")

        # Filter by target chain (consumer query needs service field)
        # The service field contains the chain name with "-consumer" suffix
        if not service or not service.endswith("-consumer"):
            continue

        # Extract chain name by removing "-consumer" suffix
        chain_name = service.replace("-consumer", "")
        if not chain_name or chain_name.lower() != target_chain.lower():
            continue

        values = result.get("values", [])
        if not values:
            continue

        # Prometheus already calculated the avg, just get the latest value
        try:
            latest_value = float(values[-1][1])
            latest_latency = round(latest_value)
            logger.info(
                f"Latency for {target_chain} (service: {service}): {latest_latency}ms"
            )
            return latest_latency
        except (ValueError, TypeError, IndexError) as e:
            logger.warning(
                f"Failed to parse latest latency value for chain: {target_chain}, error: {e}"
            )
            continue

    logger.warning(f"No latency data found for chain: {target_chain}")
    return 0


@validate_prometheus_data
def calculate_provider_latency_ms(
    latency_data: dict[str, Any], target_provider: str
) -> int:
    """
    Get the latest latency value for a specific provider.

    The input data is pre-aggregated by Prometheus using:
    avg(avg_over_time(lava_provider_end_to_end_latency_milliseconds[time_window])) by (service)

    Prometheus already calculates the average across all time points,
    so we just return the latest value from the time series.
    """
    results = latency_data["data"]["result"]

    for result in results:
        metric = result.get("metric", {})
        service = metric.get("service")

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
        if not values:
            continue

        # Prometheus already calculated the avg, just get the latest value
        try:
            latest_value = float(values[-1][1])
            latest_latency = round(latest_value)
            logger.info(
                f"Latency for provider {target_provider} (service: {service}): {latest_latency}ms"
            )
            return latest_latency
        except (ValueError, TypeError, IndexError) as e:
            logger.warning(
                f"Failed to parse latest latency value for provider: {target_provider}, error: {e}"
            )
            continue

    logger.warning(f"No latency data found for provider: {target_provider}")
    return 0


@validate_prometheus_data
def calculate_requests_in_time_window(
    traffic_data: dict[str, Any], target_chain: str
) -> int:
    """
    Calculate total requests within the time window for a specific chain.

    The input data uses Prometheus increase() function which automatically
    handles counter resets, so we just get the latest value.
    """
    results = traffic_data["data"]["result"]
    total_relays = 0

    for result in results:
        service = result.get("metric", {}).get("service")

        # Filter by target chain (consumer query needs service field)
        # The service field contains the chain name with "-consumer" suffix
        if not service or not service.endswith("-consumer"):
            continue

        # Extract chain name by removing "-consumer" suffix
        chain_name = service.replace("-consumer", "")
        if not chain_name or chain_name.lower() != target_chain.lower():
            continue

        values = result.get("values", [])
        if not values:
            continue

        # Prometheus increase() already calculated the total, get the latest value
        try:
            latest_value = float(values[-1][1])
            total_relays += int(latest_value)
        except (ValueError, TypeError, IndexError) as e:
            logger.warning(
                f"Failed to parse traffic value for chain: {target_chain}, error: {e}"
            )
            continue

    if total_relays > 0:
        logger.info(f"Total requests for {target_chain}: {total_relays}")

    return total_relays


@validate_prometheus_data
def calculate_chain_latest_block_number(
    block_data: dict[str, Any], target_chain: str
) -> int:
    """
    Get the maximum block number for a specific chain across all consumers.
    
    The input data is pre-aggregated by Prometheus using:
    max(lava_consumer_latest_provider_block) by (spec)
    
    Prometheus already calculates the maximum across all consumers for each spec,
    so we filter by spec (chain_id converted to uppercase) and return the value.
    """
    results = block_data["data"]["result"]
    
    # Convert chain_id to uppercase to match spec label (e.g., "solana" -> "SOLANA")
    target_spec = target_chain.upper()

    # Find the result matching the target spec
    # The query returns one result per spec, so we search for the matching one
    for result in results:
        spec = result.get("metric", {}).get("spec", "").upper()
        if spec == target_spec:
            value = result.get("value")
            if value:
                try:
                    return int(float(value[1]))
                except (ValueError, TypeError, IndexError):
                    pass

    return 0


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

    # Track services we've seen to log duplicates
    seen_services = set()

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

        # Log duplicate services for the same provider
        if service in seen_services:
            logger.warning(
                f"Duplicate service found for provider {target_provider}: {service}. "
                "Continuing with calculation (will aggregate values)."
            )
        seen_services.add(service)

        values = result.get("values", [])

        for timestamp, value in values:
            try:
                health_value = float(value)
                # lava_provider_overall_health is 0-1, so multiply by 100 for percentage
                uptime_percentage = health_value * 100
                total_time += 1
                total_healthy_time += uptime_percentage
            except (ValueError, TypeError):
                continue

    return (total_healthy_time / total_time) if total_time > 0 else 0.0


@validate_prometheus_data
def calculate_provider_requests_in_time_window(
    provider_traffic_data: dict[str, Any], target_provider: str
) -> int:
    """
    Calculate total requests within the time window for a specific provider.

    The input data uses Prometheus increase() function which automatically
    handles counter resets, so we just get the latest value.
    """
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
        if not values:
            continue

        # Prometheus increase() already calculated the total, get the latest value
        try:
            latest_value = float(values[-1][1])
            total_relays += int(latest_value)
        except (ValueError, TypeError, IndexError) as e:
            logger.warning(
                f"Failed to parse traffic value for provider: {target_provider}, error: {e}"
            )
            continue

    if total_relays > 0:
        logger.info(f"Total requests for provider {target_provider}: {total_relays}")

    return total_relays
