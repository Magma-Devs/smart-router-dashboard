"""
Custom exceptions for the Smart Router Dashboard API.
"""

from typing import Optional


class DashboardException(Exception):
    """Base exception for all dashboard-related errors."""

    def __init__(self, message: str, details: Optional[dict] = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


class ConfigurationError(DashboardException):
    """Raised when there's a configuration error."""

    pass


class PrometheusConnectionError(DashboardException):
    """Raised when unable to connect to Prometheus."""

    pass


class AuthenticationError(DashboardException):
    """Raised when authentication fails."""

    pass


class ValidationError(DashboardException):
    """Raised when data validation fails."""

    pass
