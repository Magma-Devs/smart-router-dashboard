from fastapi.testclient import TestClient
from unittest.mock import patch

from app.main import app
from app.api.routes.metrics import get_prometheus_service
from app.core.dataclasses import ChainConfig, ProviderConfig, EndpointConfig
from app.services.configuration import configuration_service

client = TestClient(app)


class FakeProm:
    async def query_range(self, *a, **k):
        return {"status": "success", "data": {"result": []}}


def make_chains():
    # two chains on hyperliquid and one lava
    c1 = ChainConfig(
        id="hyperliquid-lava",
        network="hyperliquid",
        providers=[
            ProviderConfig(
                name="Lava",
                endpoints=[EndpointConfig(url="https://rpc", interface="jsonrpc")],
            )
        ],
    )
    c2 = ChainConfig(
        id="hyperliquid-official",
        network="hyperliquid",
        providers=[
            ProviderConfig(
                name="Alchemy",
                endpoints=[EndpointConfig(url="https://rpc", interface="jsonrpc")],
            )
        ],
    )
    c3 = ChainConfig(
        id="lava-official",
        network="lava",
        providers=[
            ProviderConfig(
                name="Lava",
                endpoints=[EndpointConfig(url="https://rest", interface="rest")],
            )
        ],
    )
    return [c1, c2, c3]


def test_chains_metrics_filter_by_network(monkeypatch):
    # Override prometheus
    app.dependency_overrides[get_prometheus_service] = lambda: FakeProm()

    # Override configuration service stored list
    monkeypatch.setattr(configuration_service, "smart_router_values", make_chains())

    r = client.get(
        "/api/metrics/chains-metrics",
        params={"time_window_minutes": 5, "choosen_network": "hyperliquid"},
        headers={"Authorization": "Basic YWRtaW46cGFzc3dvcmQ="},
    )
    assert r.status_code == 200
    data = r.json()
    # Should only include chains on hyperliquid
    assert set(data["chains"].keys()) == {"hyperliquid-lava", "hyperliquid-official"}

    app.dependency_overrides.pop(get_prometheus_service, None)


def test_chains_metrics_filter_empty(monkeypatch):
    app.dependency_overrides[get_prometheus_service] = lambda: FakeProm()
    monkeypatch.setattr(configuration_service, "smart_router_values", make_chains())

    r = client.get(
        "/api/metrics/chains-metrics",
        params={"time_window_minutes": 5, "choosen_network": "unknown"},
        headers={"Authorization": "Basic YWRtaW46cGFzc3dvcmQ="},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["chains"] == {}

    app.dependency_overrides.pop(get_prometheus_service, None)
