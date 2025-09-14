import base64
import sys
import types
from unittest.mock import patch

# Stub kubernetes service to avoid helm/kubectl during tests
fake_k8s = types.ModuleType("app.services.kubernetes")


class _Dummy:
    pass


fake_k8s.KubernetesService = lambda *args, **kwargs: _Dummy()
fake_k8s.kubernetes_service = _Dummy()
sys.modules["app.services.kubernetes"] = fake_k8s

from fastapi.testclient import TestClient

from app.main import app
from app.api.routes.metrics import ChainsToProvidersResponse
from app.api.routes.metrics import (
    get_prometheus_service,
    calculate_uptime_percentage,
    calculate_latency_ms,
    calculate_requests_per_day,
    calculate_provider_uptime_percentage,
)


def _basic_header(u: str, p: str) -> dict:
    token = base64.b64encode(f"{u}:{p}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


class FakePrometheus:
    async def get_default_metrics(self):
        return [{"name": "cpu", "type": "line", "data": {}}]

    async def query(self, q: str):
        return {"status": "success", "data": {"resultType": "vector", "result": []}}

    async def query_range(self, q: str, start, end, step: str):
        return {"ok": True, "q": q, "step": step}

    async def get_metric_range(self, query: str, start: str, end: str, step: str):
        return {"ok": True, "query": query, "start": start, "end": end, "step": step}


class BoomPrometheus(FakePrometheus):
    def __init__(self, exc: Exception):
        self.exc = exc

    async def get_default_metrics(self):
        raise self.exc

    async def query(self, q: str):
        raise self.exc

    async def query_range(self, q: str, start, end, step: str):
        raise self.exc

    async def get_metric_range(self, query: str, start: str, end: str, step: str):
        raise self.exc


client = TestClient(app)


def test_get_default_metrics_success():
    app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()
    r = client.get("/api/metrics/", headers=_basic_header("admin", "password"))
    assert r.status_code == 200
    assert r.json()["metrics"][0]["name"] == "cpu"
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_get_default_metrics_error():
    app.dependency_overrides[get_prometheus_service] = lambda: BoomPrometheus(
        Exception("fail")
    )
    r = client.get("/api/metrics/", headers=_basic_header("admin", "password"))
    assert r.status_code == 500
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_instant_query_success():
    app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()
    r = client.get(
        "/api/metrics/instant",
        params={"query": "up"},
        headers=_basic_header("admin", "password"),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "success"
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_instant_query_error():
    app.dependency_overrides[get_prometheus_service] = lambda: BoomPrometheus(
        Exception("boom")
    )
    r = client.get(
        "/api/metrics/instant",
        params={"query": "up"},
        headers=_basic_header("admin", "password"),
    )
    assert r.status_code == 500
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_range_query_success():
    app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()
    r = client.get(
        "/api/metrics/range",
        params={
            "query": "up",
            "start": "2024-01-01T00:00:00",
            "end": "2024-01-01T01:00:00",
            "step": "5s",
        },
        headers=_basic_header("admin", "password"),
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_range_query_error():
    app.dependency_overrides[get_prometheus_service] = lambda: BoomPrometheus(
        Exception("boom")
    )
    r = client.get(
        "/api/metrics/range",
        params={
            "query": "up",
            "start": "2024-01-01T00:00:00",
            "end": "2024-01-01T01:00:00",
            "step": "5s",
        },
        headers=_basic_header("admin", "password"),
    )
    assert r.status_code == 500
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_query_metrics_success_default_times():
    app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()
    r = client.get(
        "/api/metrics/query",
        params={"query": "up"},
        headers=_basic_header("admin", "password"),
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_query_metrics_error():
    app.dependency_overrides[get_prometheus_service] = lambda: BoomPrometheus(
        Exception("boom")
    )
    r = client.get(
        "/api/metrics/query",
        params={"query": "up"},
        headers=_basic_header("admin", "password"),
    )
    assert r.status_code == 500
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_last_minutes_success():
    app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()
    r = client.get(
        "/api/metrics/last_minutes",
        params={"query": "up", "minutes": 5, "step": "1s"},
        headers=_basic_header("admin", "password"),
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_last_minutes_error():
    app.dependency_overrides[get_prometheus_service] = lambda: BoomPrometheus(
        Exception("boom")
    )
    r = client.get(
        "/api/metrics/last_minutes",
        params={"query": "up", "minutes": 5, "step": "1s"},
        headers=_basic_header("admin", "password"),
    )
    assert r.status_code == 500
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_default_alias_success():
    app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()
    r = client.get(
        "/api/metrics/default",
    )
    assert r.status_code == 200
    assert isinstance(r.json(), list)
    app.dependency_overrides.pop(get_prometheus_service, None)


# Test calculation functions
class TestCalculationFunctions:
    """Test the calculation utility functions."""

    def test_calculate_uptime_percentage_success(self):
        """Test uptime calculation with valid data."""
        health_data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"spec": "ethereum"},
                        "values": [
                            ["1640995200", "1"],
                            ["1640995260", "1"],
                            ["1640995320", "0"],
                        ],
                    }
                ]
            },
        }
        result = calculate_uptime_percentage(health_data, "ethereum")
        assert result == 66.66666666666666  # 2 out of 3 samples healthy

    def test_calculate_uptime_percentage_invalid_data(self):
        """Test uptime calculation with invalid data."""
        assert calculate_uptime_percentage(None, "ethereum") == 0.0
        assert calculate_uptime_percentage({}, "ethereum") == 0.0
        assert calculate_uptime_percentage({"status": "error"}, "ethereum") == 0.0

    def test_calculate_latency_ms_success(self):
        """Test latency calculation with valid data."""
        latency_data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"spec": "ethereum"},
                        "values": [
                            ["1640995200", "150"],
                            ["1640995260", "200"],
                            ["1640995320", "100"],
                        ],
                    }
                ]
            },
        }
        result = calculate_latency_ms(latency_data, "ethereum")
        assert result == 150  # (150 + 200 + 100) / 3

    def test_calculate_requests_per_day_success(self):
        """Test requests calculation with valid data."""
        traffic_data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"spec": "ethereum"},
                        "values": [["1640995200", "1000"], ["1640995260", "1200"]],
                    }
                ]
            },
        }
        result = calculate_requests_per_day(traffic_data, "ethereum")
        assert result == 1200  # Latest value

    def test_calculate_provider_uptime_percentage_success(self):
        """Test provider uptime calculation with valid data."""
        provider_data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"service": "ethereum-provider"},
                        "values": [["1640995200", "0.95"], ["1640995260", "0.98"]],
                    }
                ]
            },
        }
        result = calculate_provider_uptime_percentage(provider_data, "ethereum")
        assert result == 96.5  # (0.95 + 0.98) / 2 * 100


# Test new endpoints
class TestNewEndpoints:
    """Test the new chains and providers endpoints."""

    @patch("app.api.routes.metrics.get_available_chains")
    @patch("app.api.routes.metrics.fetch_chain_metrics_data")
    def test_get_chains_metrics_success(self, mock_fetch_data, mock_get_chains):
        """Test successful chains metrics retrieval."""
        # Mock data
        mock_get_chains.return_value = ["ethereum", "bitcoin"]
        mock_fetch_data.return_value = (
            {"status": "success", "data": {"result": []}},  # consumers_data
            {"status": "success", "data": {"result": []}},  # latency_data
            {"status": "success", "data": {"result": []}},  # chain_traffic_data
            {"status": "success", "data": {"result": []}},  # provider_health_data
        )

        app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()

        r = client.get(
            "/api/metrics/chains", headers=_basic_header("admin", "password")
        )
        assert r.status_code == 200
        data = r.json()
        assert "chains" in data
        assert "avg" in data
        assert "p90" in data
        assert "ethereum" in data["chains"]
        assert "bitcoin" in data["chains"]
        assert "uptime" in data["chains"]["ethereum"]
        assert "latency_in_ms" in data["chains"]["ethereum"]
        assert "requests_per_day" in data["chains"]["ethereum"]

        app.dependency_overrides.pop(get_prometheus_service, None)


class TestChainsToProvidersEndpoint:
    """Test cases for the /chains-to-providers endpoint."""

    @patch("app.api.routes.metrics.get_available_chains")
    @patch("app.api.routes.metrics.get_available_providers")
    @patch("app.api.routes.metrics.fetch_chain_metrics_data")
    def test_get_chains_to_providers_success(
        self, mock_fetch_data, mock_get_providers, mock_get_chains
    ):
        """Test successful chains-to-providers retrieval."""
        # Mock data
        mock_get_chains.return_value = ["eth1", "cosmoshub"]
        mock_get_providers.return_value = ["eth-lava", "cosmoshub-lava"]
        mock_fetch_data.return_value = (
            {"status": "success", "data": {"result": []}},  # consumers_data
            {"status": "success", "data": {"result": []}},  # latency_data
            {"status": "success", "data": {"result": []}},  # chain_traffic_data
            {"status": "success", "data": {"result": []}},  # provider_health_data
        )

        app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()

        r = client.get(
            "/api/metrics/chains-to-providers",
            headers=_basic_header("admin", "password"),
        )
        assert r.status_code == 200
        data = r.json()

        # Validate response structure by converting to dataclass
        response = ChainsToProvidersResponse(**data)

        # Verify we have the expected chains
        assert len(response.chains) == 2
        chain_ids = [chain.chain_id for chain in response.chains]
        assert "eth1" in chain_ids
        assert "cosmoshub" in chain_ids

        app.dependency_overrides.pop(get_prometheus_service, None)

    @patch("app.api.routes.metrics.get_available_chains")
    def test_get_chains_to_providers_no_chains(self, mock_get_chains):
        """Test chains-to-providers when no chains are available."""
        mock_get_chains.return_value = []

        app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()

        r = client.get(
            "/api/metrics/chains-to-providers",
            headers=_basic_header("admin", "password"),
        )
        assert r.status_code == 200
        data = r.json()

        # Validate response structure by converting to dataclass
        response = ChainsToProvidersResponse(**data)

        # Verify we have no chains
        assert len(response.chains) == 0

        app.dependency_overrides.pop(get_prometheus_service, None)

    @patch("app.api.routes.metrics.get_available_chains")
    @patch("app.api.routes.metrics.get_available_providers")
    @patch("app.api.routes.metrics.fetch_chain_metrics_data")
    def test_get_chains_to_providers_with_provider_data(
        self, mock_fetch_data, mock_get_providers, mock_get_chains
    ):
        """Test chains-to-providers with actual provider configuration data."""
        # Mock data
        mock_get_chains.return_value = ["eth1"]
        mock_get_providers.return_value = ["eth-lava"]

        # Mock provider health data
        mock_provider_health_data = {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"service": "eth-lava"},
                        "values": [[1640995200, "1"]],  # Healthy provider
                    }
                ]
            },
        }

        mock_fetch_data.return_value = (
            {"status": "success", "data": {"result": []}},  # consumers_data
            {"status": "success", "data": {"result": []}},  # latency_data
            {"status": "success", "data": {"result": []}},  # chain_traffic_data
            mock_provider_health_data,  # provider_health_data
        )

        app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()

        r = client.get(
            "/api/metrics/chains-to-providers",
            headers=_basic_header("admin", "password"),
        )
        assert r.status_code == 200
        data = r.json()

        # Validate response structure by converting to dataclass
        response = ChainsToProvidersResponse(**data)

        # Check that we have the expected chain
        assert len(response.chains) == 1
        chain = response.chains[0]
        assert chain.chain_id == "eth1"

        app.dependency_overrides.pop(get_prometheus_service, None)

    def test_get_chains_to_providers_unauthorized(self):
        """Test chains-to-providers endpoint with invalid credentials."""
        r = client.get("/api/metrics/chains-to-providers")
        assert r.status_code == 401

    @patch("app.api.routes.metrics.get_available_chains")
    @patch("app.api.routes.metrics.fetch_chain_metrics_data")
    def test_get_chains_to_providers_prometheus_error(
        self, mock_fetch_data, mock_get_chains
    ):
        """Test chains-to-providers when Prometheus service fails."""
        mock_get_chains.return_value = ["eth1"]
        mock_fetch_data.side_effect = Exception("Prometheus connection failed")

        app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()

        r = client.get(
            "/api/metrics/chains-to-providers",
            headers=_basic_header("admin", "password"),
        )
        assert r.status_code == 500
        assert "Error fetching chains-to-providers mapping" in r.json()["detail"]

        app.dependency_overrides.pop(get_prometheus_service, None)

    @patch("app.api.routes.metrics.get_available_chains")
    @patch("app.api.routes.metrics.get_available_providers")
    @patch("app.api.routes.metrics.fetch_chain_metrics_data")
    def test_get_chains_to_providers_with_parameters(
        self, mock_fetch_data, mock_get_providers, mock_get_chains
    ):
        """Test chains-to-providers with custom time window and step size."""
        mock_get_chains.return_value = ["eth1"]
        mock_get_providers.return_value = ["eth-lava"]
        mock_fetch_data.return_value = (
            {"status": "success", "data": {"result": []}},  # consumers_data
            {"status": "success", "data": {"result": []}},  # latency_data
            {"status": "success", "data": {"result": []}},  # chain_traffic_data
            {"status": "success", "data": {"result": []}},  # provider_health_data
        )

        app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()

        # Test with custom parameters
        r = client.get(
            "/api/metrics/chains-to-providers?time_window_minutes=30&step_size=60",
            headers=_basic_header("admin", "password"),
        )
        assert r.status_code == 200

        # Verify that the fetch function was called (we can't easily verify parameters without more complex mocking)
        mock_fetch_data.assert_called_once()

        app.dependency_overrides.pop(get_prometheus_service, None)
