import base64
import types
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient
from app.main import app
from app.api.routes.metrics import get_prometheus_service
from app.services.configuration import ConfigurationService, configuration_service
from app.core.dataclasses import RouterConfig, NodeConfig, EndpointConfig

client = TestClient(app)


def _basic_header(u: str, p: str) -> dict:
    token = base64.b64encode(f"{u}:{p}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


class FakePrometheus:
    async def query_range(self, q: str, start, end, step: str):
        return {"status": "success", "data": {"result": []}}

    async def query(self, q: str):
        return {"status": "success", "data": {"resultType": "vector", "result": []}}


class FakeConfigService(ConfigurationService):
    def __init__(self):
        pass

    @property
    def get_chains_providers_configuration(self):
        return [
            RouterConfig(
                id="ethereum",
                network="ethereum",
                nodes=[
                    NodeConfig(
                        name="lava",
                        endpoints=[
                            EndpointConfig(
                                url="https://secret-url.com",
                                interface="jsonrpc",
                                addons=["archive"],
                            )
                        ],
                    )
                ],
            )
        ]


def test_chains_to_providers_safe_model():
    # Mock dependencies
    app.dependency_overrides[get_prometheus_service] = lambda: FakePrometheus()

    # Since metrics.py imports configuration_service directly, we need to mock it there
    mock_config = types.SimpleNamespace(
        get_chains_providers_configuration=FakeConfigService().get_chains_providers_configuration
    )
    with patch("app.api.routes.metrics.configuration_service", mock_config):
        r = client.get(
            "/api/metrics/chains-to-providers",
            headers=_basic_header("admin", "password"),
        )

        assert r.status_code == 200
        data = r.json()

        assert "chains" in data
        assert len(data["chains"]) == 1
        chain = data["chains"][0]
        assert chain["id"] == "ethereum"

        # Verify node data
        assert len(chain["nodes"]) == 1
        node = chain["nodes"][0]
        assert node["name"] == "lava"

        # CRITICAL: Verify URL is NOT present and addons ARE NOT present
        assert len(node["endpoints"]) == 1
        endpoint = node["endpoints"][0]
        assert "interface" in endpoint
        assert endpoint["interface"] == "jsonrpc"
        assert "url" not in endpoint
        assert "addons" not in endpoint
