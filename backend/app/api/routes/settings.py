"""
Settings API routes for runtime configuration management.

This module provides endpoints for retrieving and updating runtime settings,
allowing the frontend to override default configuration values.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.core.auth import get_current_user
from app.core.config import settings as app_settings

router = APIRouter()


class SettingsResponse(BaseModel):
    """Response model for settings endpoint."""

    prometheus_url: str = Field(description="Prometheus server URL")
    api_url: str = Field(description="Backend API URL (for reference)")


class SettingsUpdate(BaseModel):
    """Request model for updating settings."""

    prometheus_url: str | None = Field(
        default=None, description="New Prometheus server URL"
    )

    @field_validator("prometheus_url")
    @classmethod
    def validate_prometheus_url(cls, v: str | None) -> str | None:
        """Validate Prometheus URL format."""
        if v is None:
            return v
        if not v.startswith(("http://", "https://")):
            raise ValueError("Prometheus URL must start with http:// or https://")
        return v.rstrip("/")


# Runtime settings override storage
# This allows the frontend to override the default settings
_runtime_overrides: dict[str, str] = {}


def get_effective_prometheus_url() -> str:
    """Get the effective Prometheus URL, considering runtime overrides."""
    return _runtime_overrides.get("prometheus_url", app_settings.prometheus_url)


@router.get("/", response_model=SettingsResponse)
async def get_settings(
    current_user: str = Depends(get_current_user),
):
    """
    Get current application settings.

    Returns the current settings including any runtime overrides applied by the frontend.
    """
    return SettingsResponse(
        prometheus_url=get_effective_prometheus_url(),
        api_url=f"http://localhost:8000",  # This is informational
    )


@router.put("/", response_model=SettingsResponse)
async def update_settings(
    settings_update: SettingsUpdate,
    current_user: str = Depends(get_current_user),
):
    """
    Update application settings.

    Allows the frontend to override default settings at runtime.
    These overrides persist until the server is restarted.
    """
    if settings_update.prometheus_url is not None:
        _runtime_overrides["prometheus_url"] = settings_update.prometheus_url

    return SettingsResponse(
        prometheus_url=get_effective_prometheus_url(),
        api_url=f"http://localhost:8000",
    )


@router.post("/reset", response_model=SettingsResponse)
async def reset_settings(
    current_user: str = Depends(get_current_user),
):
    """
    Reset all settings to their default values.

    Clears any runtime overrides and restores the original configuration.
    """
    _runtime_overrides.clear()

    return SettingsResponse(
        prometheus_url=get_effective_prometheus_url(),
        api_url=f"http://localhost:8000",
    )

