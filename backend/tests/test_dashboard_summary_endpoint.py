"""
Tests for the /dashboard-summary endpoint, covering the metrics-rework changes:
  - traffic uses lava_rpcsmartrouter_requests_total (not total_relays_serviced)
  - recovery uses lava_rpcsmartrouter_retries_* (not node_errors_received/recovered)
  - zero-division safety when retries_total is 0
"""

import base64

from fastapi.testclient import TestClient

from app.main import app
from app.api.routes.metrics import get_prometheus_service

client = TestClient(app)

AUTH = {"Authorization": "Basic " + base64.b64encode(b"admin:password").decode()}


class RecordingPrometheus:
    """Captures every query string and returns configurable scalar results."""

    def __init__(self, scalars: dict | None = None, raise_on: str | None = None):
        self.queries: list[str] = []
        self._scalars = scalars or {}
        self._raise_on = raise_on

    async def query(self, q: str):
        self.queries.append(q)
        if self._raise_on and self._raise_on in q:
            raise RuntimeError("Prometheus unavailable")
        for key, value in self._scalars.items():
            if key in q:
                return {
                    "status": "success",
                    "data": {
                        "resultType": "vector",
                        "result": [{"value": ["t", str(value)]}],
                    },
                }
        return {"status": "success", "data": {"resultType": "vector", "result": []}}

    async def query_range(self, q, start, end, step):
        return {"status": "success", "data": {"result": []}}


# ---------------------------------------------------------------------------
# Metric name correctness
# ---------------------------------------------------------------------------


def test_summary_uses_new_traffic_metric():
    """Total requests query must use requests_total, not total_relays_serviced."""
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    client.get(
        "/api/metrics/dashboard-summary",
        params={"time_window_minutes": 5},
        headers=AUTH,
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    all_queries = " ".join(prom.queries)
    assert "requests_total" in all_queries
    assert "total_relays_serviced" not in all_queries


def test_summary_uses_retries_metrics():
    """Recovery queries must use retries_total and retries_success_total."""
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    client.get(
        "/api/metrics/dashboard-summary",
        params={"time_window_minutes": 5},
        headers=AUTH,
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    all_queries = " ".join(prom.queries)
    assert "retries_total" in all_queries
    assert "retries_success_total" in all_queries
    assert "node_errors_received" not in all_queries
    assert "node_errors_recovered" not in all_queries


# ---------------------------------------------------------------------------
# Calculations
# ---------------------------------------------------------------------------


def test_summary_recovery_rate_calculation():
    """recovery_rate = (retries_success / retries_total) * 100."""
    prom = RecordingPrometheus(
        scalars={
            "requests_total": 1000,
            "retries_success_total": 30,
            "retries_total": 100,
        }
    )
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    r = client.get(
        "/api/metrics/dashboard-summary",
        params={"time_window_minutes": 5},
        headers=AUTH,
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    recovery = r.json()["error_recovery"]
    assert recovery["total_node_errors"] == 100
    assert recovery["recovered_requests"] == 30
    assert recovery["recovery_rate"] == 30.0


def test_summary_zero_division_safe():
    """recovery_rate must be 0.0 when retries_total is 0, not a crash."""
    prom = RecordingPrometheus(scalars={"requests_total": 500})
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    r = client.get(
        "/api/metrics/dashboard-summary",
        params={"time_window_minutes": 5},
        headers=AUTH,
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    recovery = r.json()["error_recovery"]
    assert recovery["total_node_errors"] == 0
    assert recovery["recovery_rate"] == 0.0


def test_summary_cache_hit_rate_calculation():
    """cache_hit_rate = (hits / (hits + misses)) * 100."""
    prom = RecordingPrometheus(
        scalars={
            "cache_total_hits": 80,
            "cache_total_misses": 20,
        }
    )
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    r = client.get(
        "/api/metrics/dashboard-summary",
        params={"time_window_minutes": 5},
        headers=AUTH,
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    data = r.json()
    assert data["cache_hits"] == 80
    assert data["cache_misses"] == 20
    assert data["cache_hit_rate"] == 80.0


def test_summary_no_cache_data_returns_zero():
    """When cache queries return nothing, hit rate must be 0, not a crash."""
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    r = client.get(
        "/api/metrics/dashboard-summary",
        params={"time_window_minutes": 5},
        headers=AUTH,
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 200
    data = r.json()
    assert data["cache_hit_rate"] == 0.0
    assert data["cache_hits"] == 0


def test_summary_filters_by_spec_when_network_provided():
    """When choosen_network is set, the traffic query must include a spec filter."""
    prom = RecordingPrometheus()
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    client.get(
        "/api/metrics/dashboard-summary",
        params={"time_window_minutes": 5, "choosen_network": "eth"},
        headers=AUTH,
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    traffic_queries = [
        q
        for q in prom.queries
        if "requests_total" in q
        and "latency" not in q
        and "retry" not in q
        and "retries" not in q
    ]
    assert traffic_queries, "No traffic query was issued"
    assert any(
        'spec="ETH"' in q for q in traffic_queries
    ), f"Expected spec filter in traffic query, queries were: {traffic_queries}"


def test_summary_prometheus_failure_returns_500():
    """A Prometheus error must propagate as HTTP 500."""
    prom = RecordingPrometheus(raise_on="requests_total")
    app.dependency_overrides[get_prometheus_service] = lambda: prom
    r = client.get(
        "/api/metrics/dashboard-summary",
        params={"time_window_minutes": 5},
        headers=AUTH,
    )
    app.dependency_overrides.pop(get_prometheus_service, None)

    assert r.status_code == 500
