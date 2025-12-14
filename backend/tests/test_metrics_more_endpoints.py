from fastapi.testclient import TestClient

from app.main import app
from app.api.routes.metrics import get_prometheus_service
from app.core.dataclasses import ChainConfig, ProviderConfig, EndpointConfig
from app.services.configuration import configuration_service

client = TestClient(app)


class FakePromAgg:
    # Return synthetic but deterministic datasets for aggregates
    async def query_range(self, q, start, end, step):
        if "health" in q or "overall_health" in q:
            # health data: two chains, three samples 1/1/0 and 1/0/0
            return {
                "status": "success",
                "data": {
                    "result": [
                        {
                            "metric": {"service": "hyperliquid-lava-consumer"},
                            "values": [["t1", "1"], ["t2", "1"], ["t3", "0"]],
                        },
                        {
                            "metric": {"service": "hyperliquid-official-consumer"},
                            "values": [["t1", "1"], ["t2", "0"], ["t3", "0"]],
                        },
                    ]
                },
            }
        if "latency" in q:
            return {
                "status": "success",
                "data": {
                    "result": [
                        {
                            "metric": {"service": "hyperliquid-lava-consumer"},
                            "values": [["t1", "100"], ["t2", "200"]],
                        },
                        {
                            "metric": {"service": "hyperliquid-official-consumer"},
                            "values": [["t1", "300"], ["t2", "300"]],
                        },
                    ]
                },
            }
        if "traffic" in q:
            return {
                "status": "success",
                "data": {
                    "result": [
                        {
                            "metric": {"service": "hyperliquid-lava-consumer"},
                            "values": [["t1", "100"], ["t2", "150"]],
                        },
                        {
                            "metric": {"service": "hyperliquid-official-consumer"},
                            "values": [["t1", "200"], ["t2", "240"]],
                        },
                    ]
                },
            }
        if "latest_block" in q:
            return {
                "status": "success",
                "data": {
                    "result": [
                        {
                            "metric": {"service": "hyperliquid-lava-consumer"},
                            "values": [["t1", "1000"], ["t2", "1010"]],
                        },
                        {
                            "metric": {"service": "hyperliquid-official-consumer"},
                            "values": [["t1", "2000"], ["t2", "1999"]],
                        },
                    ]
                },
            }
        # provider breakdown
        return {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"service": "hyperliquid-lava-lava-provider"},
                        "values": [["t1", "1"], ["t2", "1"]],
                    },
                    {
                        "metric": {"service": "hyperliquid-official-ankr-provider"},
                        "values": [["t1", "0.5"], ["t2", "1"]],
                    },
                ]
            },
        }


def _seed_chains():
    c1 = ChainConfig(
        id="hyperliquid-lava",
        network="hyperliquid",
        providers=[
            ProviderConfig(
                name="lava", endpoints=[EndpointConfig(url="rpc", interface="jsonrpc")]
            )
        ],
    )
    c2 = ChainConfig(
        id="hyperliquid-official",
        network="hyperliquid",
        providers=[
            ProviderConfig(
                name="ankr", endpoints=[EndpointConfig(url="rpc", interface="jsonrpc")]
            )
        ],
    )
    configuration_service.smart_router_values = [c1, c2]


def test_providers_metrics_happy(monkeypatch):
    _seed_chains()
    app.dependency_overrides[get_prometheus_service] = lambda: FakePromAgg()
    r = client.get(
        "/api/metrics/providers-metrics",
        params={"time_window_minutes": 5},
        headers={"Authorization": "Basic YWRtaW46cGFzc3dvcmQ="},
    )
    assert r.status_code == 200
    data = r.json()
    assert "providers" in data and len(data["providers"]) == 2
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_chains_to_providers_happy(monkeypatch):
    _seed_chains()
    app.dependency_overrides[get_prometheus_service] = lambda: FakePromAgg()
    r = client.get(
        "/api/metrics/chains-to-providers",
        params={"time_window_minutes": 5, "step_size": 1},
        headers={"Authorization": "Basic YWRtaW46cGFzc3dvcmQ="},
    )
    assert r.status_code == 200
    chains = r.json()["chains"]
    assert any(c["id"] == "hyperliquid-lava" for c in chains)
    app.dependency_overrides.pop(get_prometheus_service, None)


def test_chains_metrics_aggregates(monkeypatch):
    _seed_chains()
    app.dependency_overrides[get_prometheus_service] = lambda: FakePromAgg()
    r = client.get(
        "/api/metrics/chains-metrics",
        params={"time_window_minutes": 5},
        headers={"Authorization": "Basic YWRtaW46cGFzc3dvcmQ="},
    )
    assert r.status_code == 200
    data = r.json()
    assert "avg" in data and "p90" in data
    app.dependency_overrides.pop(get_prometheus_service, None)


class BoomProm:
    async def query_range(self, *a, **k):
        raise RuntimeError("boom")


def test_chains_metrics_error(monkeypatch):
    _seed_chains()
    app.dependency_overrides[get_prometheus_service] = lambda: BoomProm()
    r = client.get(
        "/api/metrics/chains-metrics",
        params={"time_window_minutes": 5},
        headers={"Authorization": "Basic YWRtaW46cGFzc3dvcmQ="},
    )
    assert r.status_code == 500
    app.dependency_overrides.pop(get_prometheus_service, None)
