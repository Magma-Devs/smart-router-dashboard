"""
Tests for the /usage endpoint, covering the metrics-rework label changes:
  - requests and errors use the `method` label (new)
  - latency histogram still uses the `function` label (unchanged)
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


def _seed(network: str = "eth", chain_id: str = "ethereum"):
    configuration_service.smart_router_values = [
        RouterConfig(
            id=chain_id,
            network=network,
            nodes=[
                NodeConfig(
                    name="n1", endpoints=[EndpointConfig(url="u", interface="jsonrpc")]
                )
            ],
        )
    ]


class RecordingPrometheus:
    """Captures every query string and returns configurable results."""

    def __init__(
        self, query_results: dict | None = None, range_result: dict | None = None
    ):
        self.queries: list[str] = []
        self._query_results = query_results or {}
        self._range_result = range_result or {
            "status": "success",
            "data": {"result": []},
        }

    async def query(self, q: str):
        self.queries.append(q)
        for key, result in self._query_results.items():
            if key in q:
                return result
        return {"status": "success", "data": {"resultType": "vector", "result": []}}

    async def query_range(self, q: str, start, end, step: str):
        self.queries.append(q)
        return self._range_result


# ---------------------------------------------------------------------------
# Label correctness
# ---------------------------------------------------------------------------


def test_usage_requests_query_uses_method_label():
    """Per-method request count instant query must group by `method`, not `function`.

    Note: the graph range query also uses requests_total but groups only by (spec) —
    we target the instant query by requiring the `method` grouping key to be present.
    """
    _seed()
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    client.get("/api/metrics/usage", params={"time_window_minutes": 5}, headers=AUTH)
    app.dependency_overrides.pop(get_prometheus_service, None)

    # The per-method instant query groups by (spec, method); the graph range query groups by (spec).
    per_method_queries = [
        q
        for q in prom.queries
        if "requests_total" in q and "latency" not in q and "method" in q
    ]
    assert per_method_queries, (
        "No per-method request query (grouping by `method`) was issued. "
        f"All queries: {prom.queries}"
    )
    for q in per_method_queries:
        assert "function" not in q, f"Unexpected 'function' label in request query: {q}"


def test_usage_errors_query_uses_method_label():
    """Error count query must group by `method`, not `function`."""
    _seed()
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    client.get("/api/metrics/usage", params={"time_window_minutes": 5}, headers=AUTH)
    app.dependency_overrides.pop(get_prometheus_service, None)

    error_queries = [q for q in prom.queries if "requests_failed_total" in q]
    assert (
        error_queries
    ), f"No error count query was issued. All queries: {prom.queries}"
    for q in error_queries:
        assert "method" in q, f"Expected 'method' label in error query, got: {q}"
        assert "function" not in q, f"Unexpected 'function' label in error query: {q}"


def test_usage_latency_query_uses_function_label():
    """Latency histogram query must still group by `function` (label unchanged in lava)."""
    _seed()
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    client.get("/api/metrics/usage", params={"time_window_minutes": 5}, headers=AUTH)
    app.dependency_overrides.pop(get_prometheus_service, None)

    latency_queries = [q for q in prom.queries if "latency" in q and "rate(" in q]
    assert latency_queries, "No latency query was issued"
    for q in latency_queries:
        assert "function" in q, f"Expected 'function' label in latency query, got: {q}"


def test_usage_new_metric_names_used():
    """Queries must reference the new metric names, not the removed ones."""
    _seed()
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    client.get("/api/metrics/usage", params={"time_window_minutes": 5}, headers=AUTH)
    app.dependency_overrides.pop(get_prometheus_service, None)

    all_queries = " ".join(prom.queries)
    assert "requests_total" in all_queries
    assert "requests_failed_total" in all_queries
    assert "total_relays_serviced" not in all_queries
    assert "total_errored" not in all_queries


# ---------------------------------------------------------------------------
# Data processing
# ---------------------------------------------------------------------------


def test_usage_methods_populated_from_method_label():
    """When Prometheus returns data with a `method` label, the methods table is non-empty."""
    _seed(network="eth", chain_id="ethereum")

    requests_result = {
        "status": "success",
        "data": {
            "resultType": "vector",
            "result": [
                {
                    "metric": {"spec": "eth", "method": "eth_call"},
                    "value": ["t", "100"],
                },
                {
                    "metric": {"spec": "eth", "method": "eth_blockNumber"},
                    "value": ["t", "50"],
                },
            ],
        },
    }
    errors_result = {
        "status": "success",
        "data": {
            "resultType": "vector",
            "result": [
                {"metric": {"spec": "eth", "method": "eth_call"}, "value": ["t", "10"]},
            ],
        },
    }

    prom = RecordingPrometheus(
        query_results={
            "requests_total": requests_result,
            "requests_failed_total": errors_result,
        }
    )
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    r = client.get(
        "/api/metrics/usage", params={"time_window_minutes": 5}, headers=AUTH
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    data = r.json()
    assert "ethereum" in data["chains"]
    methods = data["chains"]["ethereum"]["single"]["methods"]
    method_names = [m["method"] for m in methods]
    assert "eth_call" in method_names
    assert "eth_blockNumber" in method_names


def test_usage_error_rate_calculation():
    """Error rate is computed correctly from method-labelled data."""
    _seed(network="eth", chain_id="ethereum")

    prom = RecordingPrometheus(
        query_results={
            "requests_total": {
                "status": "success",
                "data": {
                    "resultType": "vector",
                    "result": [
                        {
                            "metric": {"spec": "eth", "method": "eth_call"},
                            "value": ["t", "100"],
                        },
                    ],
                },
            },
            "requests_failed_total": {
                "status": "success",
                "data": {
                    "resultType": "vector",
                    "result": [
                        {
                            "metric": {"spec": "eth", "method": "eth_call"},
                            "value": ["t", "10"],
                        },
                    ],
                },
            },
        }
    )
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    r = client.get(
        "/api/metrics/usage", params={"time_window_minutes": 5}, headers=AUTH
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    single = r.json()["chains"]["ethereum"]["single"]
    assert single["total_requests"] == 100
    assert single["total_errors"] == 10
    assert single["error_rate"] == 10.0


def test_usage_empty_on_no_prometheus_data():
    """All-empty Prometheus responses produce zero totals and empty method lists."""
    _seed(network="eth", chain_id="ethereum")
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    r = client.get(
        "/api/metrics/usage", params={"time_window_minutes": 5}, headers=AUTH
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    single = r.json()["chains"]["ethereum"]["single"]
    assert single["total_requests"] == 0
    assert single["methods"] == []
