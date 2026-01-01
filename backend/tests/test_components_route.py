from fastapi.testclient import TestClient

from app.api.routes.components import get_configuration_service
from app.main import app
from app.services.configuration import ConfigurationService

client = TestClient(app)


class FakeConfigService(ConfigurationService):
    def __init__(self):
        pass

    def read_smart_router_values(self):
        return {
            "chains": [
                {
                    "id": "hyperliquid-lava",
                    "network": "hyperliquid",
                    "providers": [
                        {
                            "name": "Lava",
                            "endpoints": [
                                {
                                    "url": "https://rpc",
                                    "interface": "jsonrpc",
                                    "addons": ["debug"],
                                },
                                {"url": "https://rest", "interface": "rest"},
                            ],
                        }
                    ],
                }
            ]
        }


def test_components_success():
    app.dependency_overrides[get_configuration_service] = lambda: FakeConfigService()
    r = client.get(
        "/api/components/", headers={"Authorization": "Basic YWRtaW46cGFzc3dvcmQ="}
    )
    assert r.status_code == 200
    data = r.json()
    assert "consumers" in data
    assert "hyperliquid-lava" in data["consumers"]
    assert sorted(data["consumers"]["hyperliquid-lava"]["interfaces"]) == [
        "jsonrpc",
        "rest",
    ]

    # Verify URL is NOT present in the response
    provider = data["consumers"]["hyperliquid-lava"]["providers"][0]
    endpoint = provider["endpoints"][0]
    assert "url" not in endpoint
    assert "interface" in endpoint
    assert "addons" in endpoint

    app.dependency_overrides.pop(get_configuration_service, None)


def test_components_error():
    class BoomConfig(ConfigurationService):
        def __init__(self):
            pass

        def read_smart_router_values(self):
            raise RuntimeError("boom")

    app.dependency_overrides[get_configuration_service] = lambda: BoomConfig()
    r = client.get(
        "/api/components/", headers={"Authorization": "Basic YWRtaW46cGFzc3dvcmQ="}
    )
    assert r.status_code == 500
    app.dependency_overrides.pop(get_configuration_service, None)
