"""
Configuration settings for the Smart Router Dashboard API.
"""

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings

from .constants import (
    DEFAULT_TENANT_ID,
    DEFAULT_AUTH_USERNAME,
    DEFAULT_AUTH_PASSWORD,
    DEFAULT_PROMETHEUS_URL,
    DEFAULT_HELM_VALUES_DIR,
    DEFAULT_PROMETHEUS_RETRIES,
    DEFAULT_PROMETHEUS_RETRY_DELAY,
    DEFAULT_PROMETHEUS_TIMEOUT,
    DEFAULT_METRICS,
)
from .exceptions import PrometheusConnectionError
from .logging_config import setup_logging, get_logger


class Settings(BaseSettings):
    """Application settings with validation and defaults."""

    # Basic application settings
    tenant_id: str = Field(default=DEFAULT_TENANT_ID, description="Tenant identifier")
    api_v1_str: str = Field(default="/api", description="API version string")
    project_name: str = Field(
        default="Smart Router Dashboard", description="Project name"
    )

    # Authentication settings
    auth_username: str = Field(
        default=DEFAULT_AUTH_USERNAME, description="Admin username"
    )
    auth_password: str = Field(
        default=DEFAULT_AUTH_PASSWORD, description="Admin password"
    )

    # Prometheus settings
    prometheus_url: str = Field(
        default=DEFAULT_PROMETHEUS_URL, description="Prometheus server URL"
    )
    prometheus_retries: int = Field(
        default=DEFAULT_PROMETHEUS_RETRIES, description="Prometheus connection retries"
    )
    prometheus_retry_delay: float = Field(
        default=DEFAULT_PROMETHEUS_RETRY_DELAY, description="Prometheus retry delay"
    )
    prometheus_timeout: int = Field(
        default=DEFAULT_PROMETHEUS_TIMEOUT, description="Prometheus connection timeout"
    )
    prometheus_verify_ssl: bool = Field(
        default=True, description="Verify SSL for Prometheus connections"
    )

    # Kubernetes settings
    kubernetes_api_url: str | None = Field(
        default=None, description="Kubernetes API URL"
    )
    kubeconfig_path: str | None = Field(
        default=None, description="Path to kubeconfig file"
    )

    # Helm settings
    helm_values_dir: str = Field(
        default=DEFAULT_HELM_VALUES_DIR, description="Directory for Helm values files"
    )

    # CORS settings
    cors_origins: list[str] = Field(
        default=[
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://0.0.0.0:3000",
        ],
        description="Allowed CORS origins",
    )

    # Auth Gateway settings (for API key management)
    auth_gateway_url: str | None = Field(
        default=None, description="Auth gateway internal URL, e.g. http://auth-gateway:8081"
    )
    auth_gateway_admin_token: str | None = Field(
        default=None, description="Admin token for auth gateway X-Admin-Token header"
    )

    # Feature flags
    debug: bool = Field(default=False, description="Enable debug mode")

    # Logging
    log_level: str = Field(default="INFO", description="Logging level")

    # Default metrics queries
    default_metrics: list[dict[str, str]] = Field(
        default=DEFAULT_METRICS, description="Default Prometheus metrics"
    )

    @field_validator("prometheus_url")
    @classmethod
    def validate_prometheus_url(cls, v: str) -> str:
        """Validate Prometheus URL format."""
        if not v.startswith(("http://", "https://")):
            raise ValueError("Prometheus URL must start with http:// or https://")
        return v.rstrip("/")

    @field_validator("prometheus_timeout")
    @classmethod
    def validate_prometheus_timeout(cls, v: int) -> int:
        """Validate Prometheus timeout value."""
        if v <= 0:
            raise ValueError("Prometheus timeout must be positive")
        return v

    @field_validator("prometheus_retries")
    @classmethod
    def validate_prometheus_retries(cls, v: int) -> int:
        """Validate Prometheus retries value."""
        if v < 0:
            raise ValueError("Prometheus retries must be non-negative")
        return v

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, v: str) -> str:
        """Validate logging level."""
        valid_levels = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if v.upper() not in valid_levels:
            raise ValueError(f'Log level must be one of: {", ".join(valid_levels)}')
        return v.upper()

    @field_validator("cors_origins")
    @classmethod
    def validate_cors_origins(cls, v: list[str]) -> list[str]:
        """Validate CORS origins format. Wildcard '*' is not allowed."""
        if not isinstance(v, list):
            raise ValueError("CORS origins must be a list")

        for origin in v:
            if not isinstance(origin, str):
                raise ValueError("Each CORS origin must be a string")
            if origin == "*":
                raise ValueError(
                    "Wildcard CORS origin '*' is not allowed. "
                    "Set CORS_ORIGINS to explicit origins, e.g.: "
                    '["https://dashboard.example.com"]'
                )
            if not (
                origin.startswith(("http://", "https://"))
                or origin.startswith(("localhost:", "127.0.0.1:", "0.0.0.0:"))
            ):
                raise ValueError(f"Invalid CORS origin format: {origin}")

        return v

    model_config = {
        "case_sensitive": False,
        "env_prefix": "",
        "env_file": ".env",
        "env_file_encoding": "utf-8",
    }

    def __init__(self, **kwargs):
        """Initialize settings with validation."""
        super().__init__(**kwargs)

        # Set up logging after validation
        setup_logging(level=self.log_level, debug_mode=self.debug)

        # Get logger for this instance
        self._logger = get_logger(__name__)

        if self.debug:
            self._logger.debug("Debug mode enabled")
            self._logger.debug(f"Prometheus URL: {self.prometheus_url}")
            self._logger.debug(
                f"Prometheus SSL verification: {self.prometheus_verify_ssl}"
            )
        else:
            self._logger.info("Production mode enabled")

    def validate_prometheus_connection(self) -> bool:
        """
        Validate Prometheus connection on startup.

        Returns:
            True if connection is successful, False otherwise

        Raises:
            PrometheusConnectionError: If connection fails and validation is required
        """
        self._logger.debug(f"Validating Prometheus connection to {self.prometheus_url}")

        try:
            import requests
            from requests.exceptions import RequestException

            response = requests.get(
                f"{self.prometheus_url}/-/healthy",
                timeout=self.prometheus_timeout,
                verify=self.prometheus_verify_ssl,
            )

            if response.status_code == 200:
                self._logger.info("Prometheus connection validated successfully")
                return True
            else:
                self._logger.warning(
                    f"Prometheus health check returned status {response.status_code}"
                )
                return False

        except ImportError:
            self._logger.warning(
                "Requests library not available, skipping Prometheus validation"
            )
            return True
        except RequestException as e:
            error_msg = f"Failed to connect to Prometheus: {str(e)}"
            self._logger.error(error_msg)

            # In production mode, raise an error
            if not self.debug:
                raise PrometheusConnectionError(error_msg)
            return False

    def get_prometheus_config(self) -> dict[str, str | int | float | bool]:
        """Get Prometheus configuration as a dictionary."""
        return {
            "url": self.prometheus_url,
            "retries": self.prometheus_retries,
            "retry_delay": self.prometheus_retry_delay,
            "timeout": self.prometheus_timeout,
            "verify_ssl": self.prometheus_verify_ssl,
        }

    # Backward-compatible attribute accessors
    @property
    def AUTH_USERNAME(self) -> str:
        return self.auth_username

    @property
    def AUTH_PASSWORD(self) -> str:
        return self.auth_password

    @property
    def DEBUG(self) -> bool:
        return self.debug

    @property
    def PROMETHEUS_URL(self) -> str:
        return self.prometheus_url

    @property
    def PROMETHEUS_VERIFY_SSL(self) -> bool:
        return self.prometheus_verify_ssl

    @property
    def PROMETHEUS_TIMEOUT(self) -> int:
        return self.prometheus_timeout

    @property
    def DEFAULT_METRICS(self):
        return self.default_metrics

    @property
    def TENANT_ID(self) -> str:
        return self.tenant_id


@lru_cache()
def get_settings() -> Settings:
    """
    Get cached settings instance.

    Returns:
        Application settings instance
    """
    return Settings()


# Create global settings instance
settings = get_settings()
