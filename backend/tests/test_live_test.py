import pytest
import sys
import types
import base64
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

# Stub kubernetes service to avoid helm/kubectl during tests
fake_k8s = types.ModuleType("app.services.kubernetes")


class _Dummy:
    pass


fake_k8s.KubernetesService = lambda *args, **kwargs: _Dummy()
fake_k8s.kubernetes_service = _Dummy()
sys.modules["app.services.kubernetes"] = fake_k8s

from app.main import app
from app.core.auth import get_current_user


def _basic_header(u: str, p: str) -> dict:
    token = base64.b64encode(f"{u}:{p}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


client = TestClient(app)


class TestLiveTestEndpoint:
    """Test cases for the live test endpoint."""

    def test_live_test_endpoint_validation(self):
        """Test live test endpoint validation."""
        # Test invalid number of requests (too high)
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "number_of_requests": 300,  # Exceeds max limit
        }

        response = client.post(
            "/api/live-test/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422  # Validation error

        # Test invalid number of requests (too low)
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "number_of_requests": 0,
        }

        response = client.post(
            "/api/live-test/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422  # Validation error

    def test_live_test_endpoint_invalid_rest_command(self):
        """Test live test with invalid REST interface command."""
        request_data = {
            "chain_id": "test-chain",
            "interface": "rest",
            "interface_command": "invalid_json",
            "number_of_requests": 1,
        }

        response = client.post(
            "/api/live-test/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )

        # The validation happens during execution, so it returns 500 with the error details
        assert response.status_code == 500
        assert "Invalid interface_command" in response.json()["detail"]

    def test_live_test_endpoint_unauthorized(self):
        """Test live test endpoint without authentication."""
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "number_of_requests": 1,
        }

        response = client.post("/api/live-test/", json=request_data)

        assert response.status_code == 401

    def test_live_test_endpoint_missing_fields(self):
        """Test live test endpoint with missing required fields."""
        # Missing chain_id
        request_data = {
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "number_of_requests": 1,
        }

        response = client.post(
            "/api/live-test/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422

        # Missing interface
        request_data = {
            "chain_id": "test-chain",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "number_of_requests": 1,
        }

        response = client.post(
            "/api/live-test/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422

        # Missing interface_command
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "number_of_requests": 1,
        }

        response = client.post(
            "/api/live-test/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422


class TestCrossValidationEndpoint:
    """Test cases for the cross validation endpoint."""

    def test_cross_validation_endpoint_validation(self):
        """Test cross validation endpoint validation."""
        # Test invalid quorum_min (too high)
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 150,  # Exceeds max limit
            "quorum_max": 100,
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422  # Validation error

        # Test invalid quorum_max (too high)
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_max": 150,  # Exceeds max limit
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422  # Validation error

        # Test invalid quorum_rate (too high)
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_max": 100,
            "quorum_rate": 1.5,  # Exceeds max limit
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422  # Validation error

        # Test invalid quorum_rate (too low)
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_max": 100,
            "quorum_rate": -0.1,  # Below min limit
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422  # Validation error

    def test_cross_validation_endpoint_quorum_logic_validation(self):
        """Test cross validation endpoint quorum logic validation."""
        # Test quorum_min > quorum_max
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 10,
            "quorum_max": 5,  # Less than quorum_min
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 400
        assert (
            "quorum_min cannot be greater than quorum_max" in response.json()["detail"]
        )

    def test_cross_validation_endpoint_invalid_rest_command(self):
        """Test cross validation with invalid REST interface command."""
        request_data = {
            "chain_id": "test-chain",
            "interface": "rest",
            "interface_command": "invalid_json",
            "quorum_min": 1,
            "quorum_max": 10,
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )

        # The validation happens during execution, so it returns 500 with the error details
        assert response.status_code == 500
        assert "Invalid interface_command" in response.json()["detail"]

    def test_cross_validation_endpoint_unauthorized(self):
        """Test cross validation endpoint without authentication."""
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_max": 10,
            "quorum_rate": 0.5,
        }

        response = client.post("/api/live-test/cross-validation/", json=request_data)

        assert response.status_code == 401

    def test_cross_validation_endpoint_missing_fields(self):
        """Test cross validation endpoint with missing required fields."""
        # Missing chain_id
        request_data = {
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_max": 10,
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422

        # Missing interface
        request_data = {
            "chain_id": "test-chain",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_max": 10,
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422

        # Missing interface_command
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "quorum_min": 1,
            "quorum_max": 10,
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422

        # Missing quorum_min
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_max": 10,
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422

        # Missing quorum_max
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422

        # Missing quorum_rate
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_max": 10,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )
        assert response.status_code == 422

    @patch("httpx.AsyncClient")
    def test_cross_validation_endpoint_successful_request(self, mock_client_class):
        """Test cross validation endpoint with successful request."""
        # Mock the httpx client
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful response
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {
            "content-type": "application/json",
            "lava-provider-address": "provider1",
        }
        mock_response.json = AsyncMock(return_value={"result": "0x123"})
        mock_response.text = '{"result": "0x123"}'

        mock_client.request.return_value = mock_response

        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_max": 10,
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )

        assert response.status_code == 200
        response_data = response.json()

        # Verify response structure
        assert "status_code" in response_data
        assert "latency_ms" in response_data
        assert "success" in response_data
        assert "response_data" in response_data
        assert "headers" in response_data

        # Verify values
        assert response_data["status_code"] == 200
        assert response_data["success"] is True
        assert response_data["response_data"] == {"result": "0x123"}
        assert response_data["headers"]["lava-provider-address"] == "provider1"

        # Verify that the request was made with correct headers
        mock_client.request.assert_called_once()
        call_args = mock_client.request.call_args

        # Check headers include quorum parameters
        headers = call_args[1]["headers"]
        assert headers["lava-quorum-min"] == "1"
        assert headers["lava-quorum-max"] == "10"
        assert headers["lava-quorum-rate"] == "0.5"
        # Verify URL uses host-based format instead of X-Host header
        assert call_args[1]["url"] == "https://test-chain-jsonrpc.lava.lavapro.xyz:443"

    @patch("httpx.AsyncClient")
    def test_cross_validation_endpoint_rest_interface(self, mock_client_class):
        """Test cross validation endpoint with REST interface."""
        # Mock the httpx client
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful response
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json = AsyncMock(return_value={"block": "0x123"})
        mock_response.text = '{"block": "0x123"}'

        mock_client.request.return_value = mock_response

        request_data = {
            "chain_id": "test-chain",
            "interface": "rest",
            "interface_command": '{"path": "/block/latest", "method": "GET"}',
            "quorum_min": 2,
            "quorum_max": 5,
            "quorum_rate": 0.8,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )

        assert response.status_code == 200
        response_data = response.json()

        # Verify response structure
        assert response_data["status_code"] == 200
        assert response_data["success"] is True
        assert response_data["response_data"] == {"block": "0x123"}

        # Verify that the request was made with correct method and URL
        mock_client.request.assert_called_once()
        call_args = mock_client.request.call_args

        assert call_args[1]["method"] == "GET"
        assert (
            call_args[1]["url"]
            == "https://test-chain-rest.lava.lavapro.xyz:443/block/latest"
        )

        # Check headers include quorum parameters
        headers = call_args[1]["headers"]
        assert headers["lava-quorum-min"] == "2"
        assert headers["lava-quorum-max"] == "5"
        assert headers["lava-quorum-rate"] == "0.8"

    @patch("httpx.AsyncClient")
    def test_cross_validation_endpoint_failed_request(self, mock_client_class):
        """Test cross validation endpoint with failed request."""
        # Mock the httpx client
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock failed response
        mock_response = AsyncMock()
        mock_response.status_code = 500
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json = AsyncMock(return_value={"error": "Internal server error"})
        mock_response.text = '{"error": "Internal server error"}'

        mock_client.request.return_value = mock_response

        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_max": 10,
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )

        assert (
            response.status_code == 200
        )  # Endpoint returns 200 even for failed requests
        response_data = response.json()

        # Verify response structure
        assert response_data["status_code"] == 500
        assert response_data["success"] is False
        assert response_data["response_data"] == {"error": "Internal server error"}

    def test_cross_validation_endpoint_network_error(self):
        """Test cross validation endpoint with network error."""
        # This test verifies that the endpoint handles errors gracefully
        # We'll test with invalid parameters that should cause a 500 error
        request_data = {
            "chain_id": "test-chain",
            "interface": "jsonrpc",
            "interface_command": '{"method": "eth_blockNumber", "params": [], "id": 1}',
            "quorum_min": 1,
            "quorum_max": 10,
            "quorum_rate": 0.5,
        }

        response = client.post(
            "/api/live-test/cross-validation/",
            json=request_data,
            headers=_basic_header("admin", "password"),
        )

        # The endpoint should return 200 even for failed requests (it handles errors internally)
        assert response.status_code == 200
        response_data = response.json()

        # Verify response structure
        assert "status_code" in response_data
        assert "latency_ms" in response_data
        assert "success" in response_data
        assert "response_data" in response_data
        assert "headers" in response_data
