"""
Tests for the /chains-to-providers router health lookup, covering the metrics-rework change:
  - lava_rpc_endpoint_info is removed; router health now comes from
    lava_rpcsmartrouter_overall_health_breakdown keyed directly by spec.
"""

import base64
import types
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.api.routes.metrics import get_prometheus_service
from app.services.configuration import configuration_service
from app.core.dataclasses import RouterConfig, NodeConfig, EndpointConfig

client = TestClient(app)

AUTH = {"Authorization": "Basic " + base64.b64encode(b"admin:password").decode()}

PARAMS = {"time_window_minutes": 5, "step_size": 1}


def _mock_config(network: str = "ETH", chain_id: str = "ethereum"):
    return types.SimpleNamespace(
        get_chains_providers_configuration=[
            RouterConfig(
                id=chain_id,
                network=network,
                nodes=[
                    NodeConfig(
                        name="node1",
                        endpoints=[
                            EndpointConfig(
                                url="https://rpc.example.com", interface="jsonrpc"
                            )
                        ],
                    )
                ],
            )
        ]
    )


class RecordingPrometheus:
    """Records all query strings; returns configurable results."""

    def __init__(
        self, health_breakdown: dict | None = None, endpoint_health: dict | None = None
    ):
        self.queries: list[str] = []
        self._health_breakdown = health_breakdown or {
            "status": "success",
            "data": {"resultType": "vector", "result": []},
        }
        self._endpoint_health = endpoint_health or {
            "status": "success",
            "data": {"result": []},
        }

    async def query(self, q: str):
        self.queries.append(q)
        return self._health_breakdown

    async def query_range(self, q: str, start, end, step: str):
        self.queries.append(q)
        return self._endpoint_health


# ---------------------------------------------------------------------------
# Query correctness
# ---------------------------------------------------------------------------


def test_router_health_uses_breakdown_metric():
    """The instant query must use overall_health_breakdown, not endpoint_info."""
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    with patch("app.api.routes.metrics.configuration_service", _mock_config()):
        client.get("/api/metrics/chains-to-providers", params=PARAMS, headers=AUTH)
    app.dependency_overrides.pop(get_prometheus_service, None)

    instant_queries = [q for q in prom.queries if "query_range" not in q]
    # The only instant query should reference the breakdown metric
    assert any(
        "overall_health_breakdown" in q for q in prom.queries
    ), f"Expected overall_health_breakdown query, got: {prom.queries}"


def test_endpoint_info_is_not_queried():
    """lava_rpc_endpoint_info must NOT be queried (metric was removed in metrics-cleanup PR)."""
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    with patch("app.api.routes.metrics.configuration_service", _mock_config()):
        client.get("/api/metrics/chains-to-providers", params=PARAMS, headers=AUTH)
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert not any(
        "endpoint_info" in q for q in prom.queries
    ), f"endpoint_info was queried but should not be: {prom.queries}"


# ---------------------------------------------------------------------------
# Health resolution
# ---------------------------------------------------------------------------


def test_router_healthy_when_breakdown_returns_1():
    """Router health_status is HEALTHY when overall_health_breakdown returns 1 for the spec."""
    breakdown = {
        "status": "success",
        "data": {
            "resultType": "vector",
            "result": [
                {
                    "metric": {"spec": "ETH", "apiInterface": "jsonrpc"},
                    "value": ["t", "1"],
                },
            ],
        },
    }
    prom = RecordingPrometheus(health_breakdown=breakdown)
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    with patch(
        "app.api.routes.metrics.configuration_service", _mock_config(network="ETH")
    ):
        r = client.get("/api/metrics/chains-to-providers", params=PARAMS, headers=AUTH)
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    chain = r.json()["chains"][0]
    assert chain["health_status"] == "healthy"


def test_router_unhealthy_when_breakdown_returns_0():
    """Router health_status is UNHEALTHY when overall_health_breakdown returns 0."""
    breakdown = {
        "status": "success",
        "data": {
            "resultType": "vector",
            "result": [
                {
                    "metric": {"spec": "ETH", "apiInterface": "jsonrpc"},
                    "value": ["t", "0"],
                },
            ],
        },
    }
    prom = RecordingPrometheus(health_breakdown=breakdown)
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    with patch(
        "app.api.routes.metrics.configuration_service", _mock_config(network="ETH")
    ):
        r = client.get("/api/metrics/chains-to-providers", params=PARAMS, headers=AUTH)
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    chain = r.json()["chains"][0]
    assert chain["health_status"] == "unhealthy"


def test_router_unhealthy_when_no_breakdown_data():
    """Router health_status is UNHEALTHY when Prometheus returns no data for the spec."""
    prom = RecordingPrometheus()  # default: empty result
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    with patch(
        "app.api.routes.metrics.configuration_service", _mock_config(network="ETH")
    ):
        r = client.get("/api/metrics/chains-to-providers", params=PARAMS, headers=AUTH)
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    chain = r.json()["chains"][0]
    assert chain["health_status"] == "unhealthy"


def test_router_health_takes_max_across_api_interfaces():
    """When multiple apiInterface series exist for a spec, the max value wins (healthy if any is 1)."""
    breakdown = {
        "status": "success",
        "data": {
            "resultType": "vector",
            "result": [
                {
                    "metric": {"spec": "ETH", "apiInterface": "jsonrpc"},
                    "value": ["t", "0"],
                },
                {
                    "metric": {"spec": "ETH", "apiInterface": "rest"},
                    "value": ["t", "1"],
                },
            ],
        },
    }
    prom = RecordingPrometheus(health_breakdown=breakdown)
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    with patch(
        "app.api.routes.metrics.configuration_service", _mock_config(network="ETH")
    ):
        r = client.get("/api/metrics/chains-to-providers", params=PARAMS, headers=AUTH)
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    chain = r.json()["chains"][0]
    assert chain["health_status"] == "healthy"
