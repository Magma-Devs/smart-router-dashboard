from enum import Enum
from pydantic import BaseModel

from app.core.utils import (
    remove_duplicate_addons,
)


# Health state enums
class ProviderHealth(str, Enum):
    """Basic health states for providers"""

    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"


class ChainHealth(str, Enum):
    """Extended health states for chains (includes mixed state)"""

    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"
    MIXED = "mixed"


class EndpointConfig(BaseModel):
    url: str
    interface: str
    addons: list[str] = []


class ProviderConfig(BaseModel):
    name: str
    endpoints: list[EndpointConfig]


class Provider(ProviderConfig):
    health_status: ProviderHealth = ProviderHealth.UNHEALTHY


class ChainConfig(BaseModel):
    id: str  # chain name
    network: str  # basically chain ID, but there could be several different chains from the same network
    providers: list[ProviderConfig] | list[Provider]

    def get_interfaces(self) -> list[str]:
        """Get all unique interfaces from all providers' endpoints."""
        interfaces = set()
        for provider in self.providers:
            for endpoint in provider.endpoints:
                interfaces.add(endpoint.interface)
        return list(interfaces)

    def get_addons(self) -> list[str]:
        """Get all unique addons from all providers' endpoints."""
        addons = set()
        for provider in self.providers:
            for endpoint in provider.endpoints:
                addons.update(endpoint.addons)
        return remove_duplicate_addons(list(addons))


class Chain(ChainConfig):
    health_status: ChainHealth


class ChainsToProvidersResponse(BaseModel):
    chains: list[dict]


# Pydantic models for API responses
class ChainMetrics(BaseModel):
    network: str | None = None
    uptime: float
    latency_in_ms: int
    reachability: float  # Percentage of healthy providers for this chain
    requests_in_window: int
    latest_block: int


class ProviderMetrics(BaseModel):
    provider_name: str | None = None
    network: str | None = None
    uptime: float
    latency_in_ms: int | None  # Providers don't have latency metrics
    requests_in_window: int
    latest_block: int


class ChainsMetricsResponse(BaseModel):
    chains: dict[str, ChainMetrics]
    avg: ChainMetrics
    p90: ChainMetrics


class ProvidersMetricsResponse(BaseModel):
    providers: dict[str, ProviderMetrics]
    avg: ProviderMetrics
    p90: ProviderMetrics
