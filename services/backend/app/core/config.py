import os
import logging
from pydantic_settings import BaseSettings
from typing import Optional, Dict, Any, List

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class Settings(BaseSettings):
    API_V1_STR: str = "/api"
    PROJECT_NAME: str = "Lava Dashboard"
    
    # Prometheus settings
    PROMETHEUS_URL: str = os.getenv("PROMETHEUS_URL", "http://prometheus.lava.infra")
    
    # Kubernetes settings
    KUBERNETES_API_URL: Optional[str] = os.getenv("KUBERNETES_API_URL")
    KUBECONFIG_PATH: Optional[str] = os.getenv("KUBECONFIG_PATH")
    
    # Helm settings
    HELM_CHARTS_DIR: str = os.getenv("HELM_CHARTS_DIR", "/app/helm-charts")
    HELM_VALUES_DIR: str = os.getenv("HELM_VALUES_DIR", "/app/helm-values")
    
    # Available Helm charts and their namespaces
    HELM_DEPLOYMENTS: Dict[str, Dict[str, Any]] = {
        "consumer": {
            "namespace": "lava",
            "release_name": "lava-consumer",
            "chart": "lava/consumer",
            "values_file": "consumer.values.yml"
        },
        "provider": {
            "namespace": "lava",
            "release_name": "lava-provider",
            "chart": "lava/provider",
            "values_file": "provider.values.yml"
        },
        "prometheus": {
            "namespace": "observability",
            "release_name": "prometheus",
            "chart": "prometheus-community/prometheus",
            "values_file": "prometheus.values.yml"
        },
        "grafana": {
            "namespace": "observability",
            "release_name": "grafana",
            "chart": "grafana/grafana",
            "values_file": "grafana.values.yml"
        }
    }
    
    # Common Prometheus metrics to expose
    DEFAULT_METRICS: List[Dict[str, str]] = [
        {
            "name": "CPU Usage",
            "query": "sum(rate(container_cpu_usage_seconds_total{namespace=~\"lava|observability\"}[5m])) by (namespace, pod)",
            "type": "line"
        },
        {
            "name": "Memory Usage",
            "query": "sum(container_memory_usage_bytes{namespace=~\"lava|observability\"}) by (namespace, pod)",
            "type": "line"
        },
        {
            "name": "Network Traffic",
            "query": "sum(rate(container_network_receive_bytes_total{namespace=~\"lava|observability\"}[5m])) by (namespace, pod)",
            "type": "line"
        },
        {
            "name": "Disk Usage",
            "query": "sum(container_fs_usage_bytes{namespace=~\"lava|observability\"}) by (namespace, pod)",
            "type": "line"
        },
        {
            "name": "Request Duration",
            "query": "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{namespace=~\"lava|observability\"}[5m])) by (le, service))",
            "type": "line"
        }
    ]

    # Add debug mode setting
    DEBUG: bool = os.getenv("DEBUG", "False").lower() == "true"
    
    # Add logging level setting
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    
    # Add Prometheus connection settings
    PROMETHEUS_RETRIES: int = int(os.getenv("PROMETHEUS_RETRIES", "3"))
    PROMETHEUS_RETRY_DELAY: float = float(os.getenv("PROMETHEUS_RETRY_DELAY", "0.5"))
    PROMETHEUS_TIMEOUT: int = int(os.getenv("PROMETHEUS_TIMEOUT", "10"))
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Set logging level from environment
        logging.getLogger().setLevel(self.LOG_LEVEL)
        if self.DEBUG:
            logging.getLogger().setLevel(logging.DEBUG)
            logger.debug("Debug mode enabled")
            logger.debug(f"Prometheus URL: {self.PROMETHEUS_URL}")
        
        # Validate Prometheus connection on startup
        if not self.validate_prometheus_connection():
            raise ConnectionError(f"Could not connect to Prometheus at {self.PROMETHEUS_URL}")

    # Add connection validation method
    def validate_prometheus_connection(self) -> bool:
        logger.debug(f"Validating Prometheus connection to {self.PROMETHEUS_URL}")
        import requests
        from requests.exceptions import RequestException
        
        try:
            response = requests.get(f"{self.PROMETHEUS_URL}/-/healthy", timeout=self.PROMETHEUS_TIMEOUT)
            return response.status_code == 200
        except RequestException as e:
            logger.error(f"Failed to connect to Prometheus: {str(e)}")
            return False

    class Config:
        case_sensitive = True

settings = Settings() 