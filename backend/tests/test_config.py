"""
Tests for the configuration module.
"""

import os
import pytest
from unittest.mock import patch, MagicMock

from app.core.config import Settings, get_settings
from app.core.exceptions import PrometheusConnectionError


class TestSettings:
    """Test cases for the Settings class."""

    @patch.dict(os.environ, {}, clear=True)
    def test_default_values(self):
        """Test that default values are set correctly."""
        settings = Settings()

        assert settings.tenant_id == "default"
        assert settings.auth_username == "admin"
        assert settings.auth_password == "password"
        assert settings.prometheus_url == "http://prometheus.lava.lavapro.xyz"
        assert settings.debug is False
        assert settings.log_level == "INFO"

    def test_environment_variable_override(self):
        """Test that environment variables override defaults."""
        with patch.dict(
            os.environ,
            {
                "TENANT_ID": "test-tenant",
                "AUTH_USERNAME": "testuser",
                "DEBUG": "true",
                "CORS_ORIGINS": '["http://localhost:3000","http://127.0.0.1:3000"]',
            },
        ):
            settings = Settings()

            assert settings.tenant_id == "test-tenant"
            assert settings.auth_username == "testuser"
            assert settings.debug is True
            assert settings.cors_origins == [
                "http://localhost:3000",
                "http://127.0.0.1:3000",
            ]

    def test_prometheus_url_validation_valid(self):
        """Test valid Prometheus URL validation."""
        valid_urls = [
            "http://prometheus.example.com",
            "https://prometheus.example.com",
            "http://localhost:9090",
        ]

        for url in valid_urls:
            settings = Settings(prometheus_url=url)
            assert settings.prometheus_url == url

    def test_prometheus_url_validation_invalid(self):
        """Test invalid Prometheus URL validation."""
        invalid_urls = [
            "prometheus.example.com",
            "ftp://prometheus.example.com",
            "invalid-url",
        ]

        for url in invalid_urls:
            with pytest.raises(ValueError, match="must start with http:// or https://"):
                Settings(prometheus_url=url)

    def test_prometheus_timeout_validation(self):
        """Test Prometheus timeout validation."""
        # Valid timeout
        settings = Settings(prometheus_timeout=30)
        assert settings.prometheus_timeout == 30

        # Invalid timeout
        with pytest.raises(ValueError, match="must be positive"):
            Settings(prometheus_timeout=0)

        with pytest.raises(ValueError, match="must be positive"):
            Settings(prometheus_timeout=-1)

    def test_prometheus_retries_validation(self):
        """Test Prometheus retries validation."""
        # Valid retries
        settings = Settings(prometheus_retries=5)
        assert settings.prometheus_retries == 5

        # Invalid retries
        with pytest.raises(ValueError, match="must be non-negative"):
            Settings(prometheus_retries=-1)

    def test_log_level_validation(self):
        """Test log level validation."""
        valid_levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]

        for level in valid_levels:
            settings = Settings(log_level=level)
            assert settings.log_level == level

        # Invalid level
        with pytest.raises(ValueError, match="must be one of"):
            Settings(log_level="INVALID")

    def test_cors_origins_validation_valid(self):
        """Test valid CORS origins validation."""
        valid_origins = [
            ["http://localhost:3000"],
            ["https://example.com"],
            ["http://localhost:3000", "https://example.com"],
            ["http://127.0.0.1:3000", "http://0.0.0.0:3000"],
        ]

        for origins in valid_origins:
            settings = Settings(cors_origins=origins)
            assert settings.cors_origins == origins

    def test_cors_origins_validation_invalid(self):
        """Test invalid CORS origins validation."""
        from pydantic import ValidationError

        # Not a list - Pydantic validates this before our custom validator
        with pytest.raises(ValidationError, match="Input should be a valid list"):
            Settings(cors_origins="http://localhost:3000")

        # Non-string elements - Pydantic validates this before our custom validator
        with pytest.raises(ValidationError, match="Input should be a valid string"):
            Settings(cors_origins=[123, "http://localhost:3000"])

        # Invalid URL format - Our custom validator catches this
        with pytest.raises(ValueError, match="Invalid CORS origin format"):
            Settings(cors_origins=["invalid-url"])

        # Invalid protocol - Our custom validator catches this
        with pytest.raises(ValueError, match="Invalid CORS origin format"):
            Settings(cors_origins=["ftp://example.com"])

    def test_cors_origins_environment_variable(self):
        """Test CORS origins from environment variable."""
        with patch.dict(
            os.environ,
            {"CORS_ORIGINS": '["http://localhost:3000","https://example.com"]'},
        ):
            settings = Settings()
            assert settings.cors_origins == [
                "http://localhost:3000",
                "https://example.com",
            ]

    def test_prometheus_connection_success(self):
        """Test successful Prometheus connection validation."""
        with patch("requests.get") as mock_get:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_get.return_value = mock_response

            settings = Settings()
            result = settings.validate_prometheus_connection()

            assert result is True
            mock_get.assert_called_once()

    def test_prometheus_connection_failure(self):
        """Test failed Prometheus connection validation."""
        with patch("requests.get") as mock_get:
            from requests.exceptions import RequestException

            mock_get.side_effect = RequestException("Connection failed")

            settings = Settings(debug=True)
            result = settings.validate_prometheus_connection()

            assert result is False
            mock_get.assert_called_once()

    def test_prometheus_connection_failure_production(self):
        """Test that Prometheus connection failure raises error in production."""
        with patch("requests.get") as mock_get:
            from requests.exceptions import RequestException

            mock_get.side_effect = RequestException("Connection failed")

            settings = Settings(debug=False)

            with pytest.raises(PrometheusConnectionError):
                settings.validate_prometheus_connection()

    def test_get_prometheus_config(self):
        """Test getting Prometheus configuration as dictionary."""
        settings = Settings(
            prometheus_url="http://test.com",
            prometheus_timeout=15,
            prometheus_retries=2,
        )

        config = settings.get_prometheus_config()

        assert config["url"] == "http://test.com"
        assert config["timeout"] == 15
        assert config["retries"] == 2
        assert config["verify_ssl"] is True


class TestGetSettings:
    """Test cases for the get_settings function."""

    def test_get_settings_cached(self):
        """Test that get_settings returns cached instance."""
        settings1 = get_settings()
        settings2 = get_settings()

        assert settings1 is settings2

    def test_get_settings_singleton(self):
        """Test that get_settings returns singleton instance."""
        settings1 = get_settings()
        settings2 = get_settings()

        # Modify one instance
        settings1.tenant_id = "modified"

        # Both should reference the same object
        assert settings2.tenant_id == "modified"


class TestSettingsIntegration:
    """Integration tests for settings with environment variables."""

    @patch.dict(os.environ, {}, clear=True)
    def test_no_environment_variables(self):
        """Test settings with no environment variables."""
        settings = Settings()

        assert settings.tenant_id == "default"
        assert settings.auth_username == "admin"
        assert settings.debug is False

    @patch.dict(
        os.environ,
        {
            "DEBUG": "true",
            "LOG_LEVEL": "DEBUG",
            "PROMETHEUS_URL": "https://custom-prometheus.com",
        },
    )
    def test_mixed_environment_variables(self):
        """Test settings with mixed environment variables."""
        settings = Settings()

        assert settings.debug is True
        assert settings.log_level == "DEBUG"
        assert settings.prometheus_url == "https://custom-prometheus.com"
        assert settings.tenant_id == "default"  # Not set in env

    def test_environment_variable_type_conversion(self):
        """Test that environment variables are properly converted to types."""
        with patch.dict(
            os.environ,
            {"PROMETHEUS_TIMEOUT": "25", "PROMETHEUS_RETRIES": "5", "DEBUG": "false"},
        ):
            settings = Settings()

            assert isinstance(settings.prometheus_timeout, int)
            assert settings.prometheus_timeout == 25
            assert isinstance(settings.prometheus_retries, int)
            assert settings.prometheus_retries == 5
            assert isinstance(settings.debug, bool)
            assert settings.debug is False

    @patch.dict(
        os.environ,
        {
            "CORS_ORIGINS": '["http://localhost:3000","http://127.0.0.1:3000","https://app.example.com"]',
            "DEBUG": "true",
        },
    )
    def test_cors_origins_integration(self):
        """Test CORS origins integration with environment variables."""
        settings = Settings()

        assert isinstance(settings.cors_origins, list)
        assert len(settings.cors_origins) == 3
        assert "http://localhost:3000" in settings.cors_origins
        assert "http://127.0.0.1:3000" in settings.cors_origins
        assert "https://app.example.com" in settings.cors_origins

    def test_cors_origins_validation_not_list(self):
        """Test CORS origins validation with non-list input."""
        with pytest.raises(ValueError, match="CORS origins must be a list"):
            Settings.validate_cors_origins("not_a_list")

    def test_cors_origins_validation_non_string_item(self):
        """Test CORS origins validation with non-string items."""
        with pytest.raises(ValueError, match="Each CORS origin must be a string"):
            Settings.validate_cors_origins(
                ["http://valid.com", 123, "https://another.com"]
            )
