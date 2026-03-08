"""
Constants used throughout the Smart Router Dashboard API.
"""

# API Configuration
API_V1_STR = "/api"
PROJECT_NAME = "Smart Router Dashboard"

# Default Values
DEFAULT_TENANT_ID = "default"
DEFAULT_AUTH_USERNAME = "admin"
DEFAULT_AUTH_PASSWORD = "password"
DEFAULT_PROMETHEUS_URL = "http://prometheus.lava.lavapro.xyz"
DEFAULT_HELM_VALUES_DIR = "/app/helm-values"
# Prometheus Configuration
DEFAULT_PROMETHEUS_RETRIES = 3
DEFAULT_PROMETHEUS_RETRY_DELAY = 0.5
DEFAULT_PROMETHEUS_TIMEOUT = 10

# Logging Configuration
DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

# Default Metrics Queries
DEFAULT_METRICS: list[dict[str, str]] = [
    {
        "name": "CPU Usage",
        "query": 'sum(rate(container_cpu_usage_seconds_total{namespace=~"lava|observability"}[5m])) by (namespace, pod)',
        "type": "line",
    },
    {
        "name": "Memory Usage",
        "query": 'sum(container_memory_usage_bytes{namespace=~"lava|observability"}) by (namespace, pod)',
        "type": "line",
    },
    {
        "name": "Network Traffic",
        "query": 'sum(rate(container_network_receive_bytes_total{namespace=~"lava|observability"}[5m])) by (namespace, pod)',
        "type": "line",
    },
    {
        "name": "Disk Usage",
        "query": 'sum(container_fs_usage_bytes{namespace=~"lava|observability"}) by (namespace, pod)',
        "type": "line",
    },
    {
        "name": "Request Duration",
        "query": 'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{namespace=~"lava|observability"}[5m])) by (le, service))',
        "type": "line",
    },
]
