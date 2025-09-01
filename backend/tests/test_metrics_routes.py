import base64
import sys
import types

# Stub kubernetes service to avoid helm/kubectl during tests
fake_k8s = types.ModuleType("app.services.kubernetes")


class _Dummy:
    pass


fake_k8s.KubernetesService = lambda *args, **kwargs: _Dummy()
fake_k8s.kubernetes_service = _Dummy()
sys.modules["app.services.kubernetes"] = fake_k8s

from fastapi.testclient import TestClient

from app.main import app
from app.api.routes.metrics import get_prometheus_service


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
