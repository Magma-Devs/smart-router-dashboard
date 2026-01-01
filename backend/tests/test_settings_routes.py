"""
Tests for the settings API routes.
"""

import base64

from fastapi.testclient import TestClient

from app.api.routes.settings import _runtime_overrides, get_effective_prometheus_url
from app.core.config import settings
from app.main import app

client = TestClient(app)


def _basic_header(u: str, p: str) -> dict:
    """Helper to create Basic auth header."""
    token = base64.b64encode(f"{u}:{p}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def _auth_headers() -> dict:
    """Get auth headers with default credentials."""
    return _basic_header(settings.AUTH_USERNAME, settings.AUTH_PASSWORD)


def _clear_overrides():
    """Clear runtime overrides between tests."""
    _runtime_overrides.clear()


class TestGetSettings:
    """Tests for GET /api/settings/ endpoint."""

    def test_get_settings_public(self):
        """Test that getting settings does not require authentication."""
        _clear_overrides()
        response = client.get("/api/settings/")
        assert response.status_code == 200
        data = response.json()
        assert "prometheus_url" in data
        assert "api_url" in data

    def test_get_settings_success(self):
        """Test successful settings retrieval."""
        _clear_overrides()
        response = client.get("/api/settings/")
        assert response.status_code == 200
        data = response.json()
        assert "prometheus_url" in data
        assert "api_url" in data
        # Should return the default prometheus URL from settings
        assert data["prometheus_url"] == settings.prometheus_url

    def test_get_settings_returns_override(self):
        """Test that GET returns overridden value."""
        _clear_overrides()
        # First set an override (requires auth)
        client.put(
            "/api/settings/",
            json={"prometheus_url": "http://custom-prometheus:9090"},
            headers=_auth_headers(),
        )

        # Now GET should return the override (no auth needed)
        response = client.get("/api/settings/")
        assert response.status_code == 200
        data = response.json()
        assert data["prometheus_url"] == "http://custom-prometheus:9090"

        _clear_overrides()


class TestUpdateSettings:
    """Tests for PUT /api/settings/ endpoint."""

    def test_update_settings_requires_auth(self):
        """Test that updating settings requires authentication."""
        response = client.put(
            "/api/settings/",
            json={"prometheus_url": "http://new-prometheus:9090"},
        )
        assert response.status_code == 401

    def test_update_settings_success(self):
        """Test successful settings update."""
        _clear_overrides()
        response = client.put(
            "/api/settings/",
            json={"prometheus_url": "http://updated-prometheus:9090"},
            headers=_auth_headers(),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["prometheus_url"] == "http://updated-prometheus:9090"

        # Verify the override was stored
        assert get_effective_prometheus_url() == "http://updated-prometheus:9090"

        _clear_overrides()

    def test_update_settings_validates_url_format(self):
        """Test that invalid URL format is rejected."""
        _clear_overrides()
        response = client.put(
            "/api/settings/",
            json={"prometheus_url": "not-a-valid-url"},
            headers=_auth_headers(),
        )
        assert response.status_code == 422  # Validation error

        _clear_overrides()

    def test_update_settings_strips_trailing_slash(self):
        """Test that trailing slashes are stripped from URL."""
        _clear_overrides()
        response = client.put(
            "/api/settings/",
            json={"prometheus_url": "http://prometheus:9090/"},
            headers=_auth_headers(),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["prometheus_url"] == "http://prometheus:9090"

        _clear_overrides()

    def test_update_settings_null_prometheus_url(self):
        """Test that null prometheus_url doesn't change existing value."""
        _clear_overrides()
        # First set an override
        client.put(
            "/api/settings/",
            json={"prometheus_url": "http://custom:9090"},
            headers=_auth_headers(),
        )

        # Now update with null
        response = client.put(
            "/api/settings/",
            json={"prometheus_url": None},
            headers=_auth_headers(),
        )
        assert response.status_code == 200
        # Should still have the previous override
        assert get_effective_prometheus_url() == "http://custom:9090"

        _clear_overrides()


class TestResetSettings:
    """Tests for POST /api/settings/reset endpoint."""

    def test_reset_settings_requires_auth(self):
        """Test that resetting settings requires authentication."""
        response = client.post("/api/settings/reset")
        assert response.status_code == 401

    def test_reset_settings_success(self):
        """Test successful settings reset."""
        _clear_overrides()
        # First set an override
        client.put(
            "/api/settings/",
            json={"prometheus_url": "http://custom:9090"},
            headers=_auth_headers(),
        )
        assert get_effective_prometheus_url() == "http://custom:9090"

        # Now reset
        response = client.post("/api/settings/reset", headers=_auth_headers())
        assert response.status_code == 200
        data = response.json()

        # Should return default value
        assert data["prometheus_url"] == settings.prometheus_url

        # Verify overrides were cleared
        assert get_effective_prometheus_url() == settings.prometheus_url

        _clear_overrides()


class TestGetEffectivePrometheusUrl:
    """Tests for the get_effective_prometheus_url helper function."""

    def test_returns_default_when_no_override(self):
        """Test that default URL is returned when no override exists."""
        _clear_overrides()
        assert get_effective_prometheus_url() == settings.prometheus_url

    def test_returns_override_when_set(self):
        """Test that override is returned when set."""
        _clear_overrides()
        _runtime_overrides["prometheus_url"] = "http://override:9090"
        assert get_effective_prometheus_url() == "http://override:9090"
        _clear_overrides()


class TestSettingsIntegration:
    """Integration tests for settings functionality."""

    def test_full_workflow(self):
        """Test complete settings workflow: get -> update -> verify -> reset."""
        _clear_overrides()

        # 1. Get initial settings (public, no auth needed)
        response = client.get("/api/settings/")
        assert response.status_code == 200
        initial_url = response.json()["prometheus_url"]
        assert initial_url == settings.prometheus_url

        # 2. Update settings (requires auth)
        new_url = "http://new-prometheus:9090"
        response = client.put(
            "/api/settings/",
            json={"prometheus_url": new_url},
            headers=_auth_headers(),
        )
        assert response.status_code == 200
        assert response.json()["prometheus_url"] == new_url

        # 3. Verify update persisted (public)
        response = client.get("/api/settings/")
        assert response.status_code == 200
        assert response.json()["prometheus_url"] == new_url

        # 4. Reset settings (requires auth)
        response = client.post("/api/settings/reset", headers=_auth_headers())
        assert response.status_code == 200

        # 5. Verify reset (public)
        response = client.get("/api/settings/")
        assert response.status_code == 200
        assert response.json()["prometheus_url"] == settings.prometheus_url

        _clear_overrides()

    def test_bad_credentials(self):
        """Test that bad credentials are rejected for protected endpoints."""
        bad_headers = _basic_header("bad", "credentials")

        # GET is public, should work
        response = client.get("/api/settings/")
        assert response.status_code == 200

        # PUT requires auth
        response = client.put(
            "/api/settings/",
            json={"prometheus_url": "http://test:9090"},
            headers=bad_headers,
        )
        assert response.status_code == 401

        # POST reset requires auth
        response = client.post("/api/settings/reset", headers=bad_headers)
        assert response.status_code == 401
