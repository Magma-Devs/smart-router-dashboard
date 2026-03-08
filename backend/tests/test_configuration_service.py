"""
Tests for ConfigurationService in app.services.configuration.
"""

import os
import tempfile
from unittest.mock import patch

import pytest
import yaml

from app.services.configuration import ConfigurationService
from app.core.dataclasses import RouterConfig


class TestConfigurationService:
    """Test ConfigurationService class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()
        self.service = ConfigurationService(values_dir=self.temp_dir)

    def teardown_method(self):
        """Clean up test fixtures."""
        import shutil

        shutil.rmtree(self.temp_dir)

    def test_init_with_custom_values_dir(self):
        """Test initialization with custom values directory."""
        custom_dir = "/custom/path"
        service = ConfigurationService(values_dir=custom_dir)
        assert service.values_dir == custom_dir

    def test_read_yaml_file_exists(self):
        """Test reading existing YAML file."""
        test_file = os.path.join(self.temp_dir, "test.yml")
        test_data = {"key": "value"}

        with open(test_file, "w") as f:
            yaml.dump(test_data, f)

        result = self.service.read_yaml_file(test_file)
        assert result == test_data

    def test_read_yaml_file_not_exists(self):
        """Test reading non-existent YAML file."""
        result = self.service.read_yaml_file("/nonexistent/file.yml")
        assert result is None

    def test_read_yaml_file_invalid_yaml(self):
        """Test reading invalid YAML file."""
        test_file = os.path.join(self.temp_dir, "invalid.yml")

        with open(test_file, "w") as f:
            f.write("invalid: yaml: content: [")

        with pytest.raises(ValueError, match="Error reading YAML file"):
            self.service.read_yaml_file(test_file)

    def test_write_yaml_file(self):
        """Test writing YAML file."""
        test_file = os.path.join(self.temp_dir, "subdir", "test.yml")
        test_data = {"key": "value", "nested": {"key2": "value2"}}

        self.service.write_yaml_file(test_file, test_data)

        # Verify file was written
        assert os.path.exists(test_file)

        # Verify content
        with open(test_file, "r") as f:
            result = yaml.safe_load(f)
        assert result == test_data

    def test_write_yaml_file_io_error(self):
        """Test write_yaml_file with IO error."""
        from unittest.mock import patch, mock_open

        # Mock makedirs and open to raise IOError
        with patch("os.makedirs"), patch("builtins.open", mock_open()) as mock_file:
            mock_file.side_effect = IOError("Permission denied")

            with pytest.raises(
                ValueError, match="Error writing YAML file.*Permission denied"
            ):
                self.service.write_yaml_file("/test/path/test.yml", {"test": "data"})

    def test_get_chains_providers_configuration(self):
        """Test getting chains and providers configuration."""
        # Mock the smart router values
        mock_chains = [
            RouterConfig(
                id="chain1",
                network="testnet",
                nodes=[],
            )
        ]

        with patch.object(self.service, "smart_router_values", mock_chains):
            result = self.service.get_chains_providers_configuration

        assert len(result) == 1
        assert result[0].id == "chain1"
        assert result[0].network == "testnet"

    def test_read_smart_router_values_empty(self):
        """Test reading smart router values when file doesn't exist."""
        result = self.service._read_smart_router_values()
        assert result == []

    def test_read_smart_router_values_with_data(self):
        """Test reading smart router values with valid data."""
        mock_data = {
            "routers": [
                {
                    "id": "chain1",
                    "network": "testnet",
                    "nodes": [],
                }
            ]
        }

        with patch.object(self.service, "read_yaml_file", return_value=mock_data):
            result = self.service._read_smart_router_values()

        assert len(result) == 1
        assert result[0].id == "chain1"
        assert result[0].network == "testnet"

    def test_chain_config_helper_methods(self):
        """Test RouterConfig helper methods for interfaces and addons."""
        from app.core.dataclasses import EndpointConfig, NodeConfig

        # Create test endpoints
        endpoint1 = EndpointConfig(
            url="https://example.com/jsonrpc", interface="jsonrpc", addons=["debug"]
        )
        endpoint2 = EndpointConfig(
            url="https://example.com/rest",
            interface="rest",
            addons=["archive", "debug"],
        )

        # Create test node
        node = NodeConfig(
            name="test_node", endpoints=[endpoint1, endpoint2]
        )

        # Create test router
        chain = RouterConfig(id="test_chain", network="testnet", nodes=[node])

        # Test get_interfaces method
        interfaces = chain.get_interfaces()
        assert "jsonrpc" in interfaces
        assert "rest" in interfaces
        assert len(interfaces) == 2

        # Test get_addons method
        addons = chain.get_addons()
        assert "debug" in addons
        assert "archive" in addons
        assert len(addons) == 2  # Should remove duplicates
