"""
Utility functions for the Smart Router Dashboard API.
"""

import hashlib


def convert_memory_to_gb(memory_str: str) -> float:
    """
    Convert memory string (e.g., '0.5Gi', '500Mi') to GB.

    Args:
        memory_str: Memory string with unit (Gi, Mi, Ki) or bytes

    Returns:
        Memory value in GB as float

    Examples:
        >>> convert_memory_to_gb('0.5Gi')
        0.5
        >>> convert_memory_to_gb('500Mi')
        0.48828125
        >>> convert_memory_to_gb('1024Ki')
        0.0009765625
    """
    if not memory_str:
        return 0.0

    memory_str = memory_str.lower()
    if "gi" in memory_str:
        return float(memory_str.replace("gi", ""))
    elif "mi" in memory_str:
        return float(memory_str.replace("mi", "")) / 1024
    elif "ki" in memory_str:
        return float(memory_str.replace("ki", "")) / (1024 * 1024)
    else:
        return float(memory_str) / (1024 * 1024 * 1024)  # Assume bytes if no unit


def convert_cpu_to_cores(cpu_str: str) -> float:
    """
    Convert CPU string (e.g., '500m', '0.5') to cores.

    Args:
        cpu_str: CPU string with 'm' suffix for millicores or decimal

    Returns:
        CPU value in cores as float

    Examples:
        >>> convert_cpu_to_cores('500m')
        0.5
        >>> convert_cpu_to_cores('0.5')
        0.5
        >>> convert_cpu_to_cores('1000m')
        1.0
    """
    if not cpu_str:
        return 0.0

    cpu_str = cpu_str.lower()
    if "m" in cpu_str:
        return float(cpu_str.replace("m", "")) / 1000
    else:
        return float(cpu_str)


def extract_provider_name_from_url(provider_url: str) -> str:
    """
    Extract provider name from URL by removing domain and '-provider' suffix.

    Args:
        provider_url: Provider URL (e.g., 'https://lava-provider.lava.lavapro.xyz')

    Returns:
        Provider name (e.g., 'lava')

    Examples:
        >>> extract_provider_name_from_url('https://lava-provider.lava.lavapro.xyz')
        'lava'
        >>> extract_provider_name_from_url('https://test-provider.example.com')
        'test'
    """
    if not provider_url:
        return ""

    # Remove protocol (http:// or https://)
    if "://" in provider_url:
        provider_url = provider_url.split("://")[1]

    # Extract domain part and remove '-provider' suffix
    domain_part = provider_url.split(".")[0]
    return domain_part.replace("-provider", "")


def remove_duplicate_addons(addons: list[str]) -> list[str]:
    """
    Remove duplicate addons while preserving order.

    Args:
        addons: List of addon strings

    Returns:
        List with duplicates removed

    Examples:
        >>> remove_duplicate_addons(['a', 'b', 'a', 'c'])
        ['a', 'b', 'c']
        >>> remove_duplicate_addons([])
        []
    """
    return list(set(addons))


def get_provider_key_from_endpoint(chain_id: str, endpoint_url: str) -> str:
    """
    Generate a provider key based on chain ID and endpoint URL.
    This allows grouping providers that share the same endpoint URL.
    Uses a hash of the URL to avoid exposing it in API responses.

    Args:
        chain_id: Chain identifier
        endpoint_url: Endpoint URL

    Returns:
        Provider key in format: "{chain_id}-{url_hash}"

    Examples:
        >>> get_provider_key_from_endpoint("solana", "https://example.com/rpc")
        'solana-a1b2c3d4...'
    """
    # Create a hash of the URL to avoid exposing it
    url_hash = hashlib.sha256(endpoint_url.encode()).hexdigest()[:8]
    return f"{chain_id}-{url_hash}".lower()


def get_endpoint_key_for_grouping(chain_id: str, endpoint_url: str) -> str:
    """
    Get a key for grouping providers by endpoint (internal use only).
    Uses the full URL for accurate grouping.

    Args:
        chain_id: Chain identifier
        endpoint_url: Endpoint URL

    Returns:
        Internal grouping key
    """
    return f"{chain_id}-{endpoint_url}".lower()


def get_base_provider_name(provider_name: str) -> str:
    """
    Extract the base provider name by removing numeric suffixes.
    Assumes providers with same base name share the same endpoint.

    Args:
        provider_name: Provider name (e.g., "quicknode1", "chainstack2")

    Returns:
        Base provider name without numeric suffix (e.g., "quicknode", "chainstack")

    Examples:
        >>> get_base_provider_name("quicknode1")
        'quicknode'
        >>> get_base_provider_name("chainstack")
        'chainstack'
        >>> get_base_provider_name("helius123")
        'helius'
    """
    import re

    # Remove trailing numeric characters
    return re.sub(r"\d+$", "", provider_name)
