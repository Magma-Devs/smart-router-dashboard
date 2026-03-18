from enum import Enum
from typing import Any

from pydantic import BaseModel

from app.core.utils import (
    remove_duplicate_addons,
)


# Health state enums
class ProviderHealth(str, Enum):
    """Basic health states for nodes/endpoints"""

    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"


class ChainHealth(str, Enum):
    """Extended health states for routers (includes mixed state)"""

    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"
    MIXED = "mixed"


class AuthConfig(BaseModel):
    auth_headers: dict[str, str] = {}
    auth_query: str | None = None
    use_tls: bool = False
    key_pem: str | None = None
    cert_pem: str | None = None
    ca_cert: str | None = None
    allow_insecure: bool = False


class EndpointConfig(BaseModel):
    url: str
    interface: str
    addons: list[str] = []
    auth_config: AuthConfig | None = None
    timeout: str | None = None
    ip_forwarding: bool = False


class NodeConfig(BaseModel):
    name: str
    endpoints: list[EndpointConfig]
    is_backup: bool = False
    stake: int | None = None
    skip_verifications: str | None = None

    def get_endpoint_urls(self) -> list[str]:
        """Return all endpoint URLs for this node."""
        return [ep.url for ep in self.endpoints]


class RouterConfig(BaseModel):
    id: str  # router name (user-defined)
    network: (
        str  # chain spec (e.g. eth1, base) - used as Prometheus spec label (uppercase)
    )
    nodes: list[NodeConfig]
    custom_url_prefix: str | None = None

    def get_interfaces(self) -> list[str]:
        """Get all unique interfaces from all nodes' endpoints."""
        interfaces = set()
        for node in self.nodes:
            for endpoint in node.endpoints:
                interfaces.add(endpoint.interface)
        return list(interfaces)

    def get_addons(self) -> list[str]:
        """Get all unique addons from all nodes' endpoints."""
        addons = set()
        for node in self.nodes:
            for endpoint in node.endpoints:
                addons.update(endpoint.addons)
        return remove_duplicate_addons(list(addons))

    def get_all_endpoint_urls(self) -> list[str]:
        """Return all endpoint URLs across all nodes in this router."""
        urls = []
        for node in self.nodes:
            urls.extend(node.get_endpoint_urls())
        return urls


class Router(RouterConfig):
    health_status: ChainHealth


# Node with health status
class Node(NodeConfig):
    health_status: ProviderHealth = ProviderHealth.UNHEALTHY


# ---------------------------------------------------------------------------
# Safe / sanitized models (exclude raw URLs from API responses)
# ---------------------------------------------------------------------------


class SafeEndpoint(BaseModel):
    interface: str


class SafeNode(BaseModel):
    name: str
    endpoints: list[SafeEndpoint]
    health_status: ProviderHealth
    is_backup: bool = False


class SafeRouter(BaseModel):
    id: str
    network: str
    nodes: list[SafeNode]
    health_status: ChainHealth


class ChainsToProvidersResponse(BaseModel):
    chains: list[SafeRouter]


# ---------------------------------------------------------------------------
# Components API models
# ---------------------------------------------------------------------------


class ResourceLimits(BaseModel):
    cpu: int
    memory: int


class AllResourceLimits(BaseModel):
    server: ResourceLimits
    per_consumer: ResourceLimits
    per_provider: ResourceLimits


class ComponentEndpoint(BaseModel):
    interface: str
    addons: list[str] = []


class ComponentNode(BaseModel):
    name: str
    endpoints: list[ComponentEndpoint]


class RouterInfo(BaseModel):
    network: str
    interfaces: list[str]
    nodes: list[ComponentNode]


class ComponentsResponse(BaseModel):
    routers: dict[str, RouterInfo]
    resource_limits: AllResourceLimits


# ---------------------------------------------------------------------------
# Pydantic models for metrics API responses
# ---------------------------------------------------------------------------


class ChainMetrics(BaseModel):
    network: str | None = None
    uptime: float
    latency_in_ms: int
    reachability: float  # Percentage of healthy endpoints for this router
    requests_in_window: int
    latest_block: int


class ProviderMetrics(BaseModel):
    provider_name: str | None = None
    network: str | None = None
    uptime: float
    latency_in_ms: int | None  # May be None if no latency data
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


# ---------------------------------------------------------------------------
# Usage metrics models
# ---------------------------------------------------------------------------


class MethodUsage(BaseModel):
    """Usage metrics for a specific RPC method"""

    method: str
    requests: int
    errors: int
    error_rate: float  # Percentage of errors (0-100)
    avg_latency_ms: float | None  # None if no latency data
    percentage: float  # Percentage of total requests


class TimeSeriesDataPoint(BaseModel):
    """A single data point over time"""

    timestamp: str
    value: float


class RequestTypeUsage(BaseModel):
    """Usage metrics for single or batch requests"""

    total_requests: int
    total_errors: int
    error_rate: float  # Percentage of errors (0-100)
    avg_latency_ms: float | None  # None if no latency data available
    methods: list[MethodUsage]
    requests_over_time: list[TimeSeriesDataPoint]


class BatchRequestUsage(BaseModel):
    """Usage metrics for batch requests"""

    total_requests: int
    total_errors: int
    error_rate: float  # Percentage of errors (0-100)
    avg_latency_ms: float | None  # None if no latency data available
    avg_batch_size: float
    methods: list[MethodUsage]
    requests_over_time: list[TimeSeriesDataPoint]


class ChainUsageMetrics(BaseModel):
    """Complete usage metrics for a router/chain"""

    chain_id: str
    network: str
    single: RequestTypeUsage
    batch: BatchRequestUsage


class UsageMetricsResponse(BaseModel):
    """Response model for usage metrics endpoint"""

    chains: dict[str, ChainUsageMetrics]


# ---------------------------------------------------------------------------
# Dashboard summary metrics models
# ---------------------------------------------------------------------------


class ErrorRecoveryMetrics(BaseModel):
    """Metrics for node error recovery from lava_consumer_total_node_errors_* metrics."""

    total_node_errors: float = 0.0
    recovered_requests: float = 0.0
    recovery_rate: float = 0.0
    recovery_by_attempt: dict[str, float] = {}
    errors_by_chain: dict[str, float] = {}


class DashboardSummaryMetrics(BaseModel):
    """Summary metrics for the dashboard overview"""

    total_requests: float
    cache_hit_rate: float = 0.0  # From Lava cache sidecar (cache_total_hits/misses)
    cache_hits: float = 0.0  # From Lava cache sidecar
    cache_misses: float = 0.0  # From Lava cache sidecar
    error_recovery: ErrorRecoveryMetrics = ErrorRecoveryMetrics()


# ---------------------------------------------------------------------------
# Backward-compatible type aliases
# (keep old names importable so existing imports don't hard-break)
# ---------------------------------------------------------------------------

ProviderConfig = NodeConfig
Provider = Node
ChainConfig = RouterConfig
Chain = Router
SafeProvider = SafeNode
SafeChain = SafeRouter
