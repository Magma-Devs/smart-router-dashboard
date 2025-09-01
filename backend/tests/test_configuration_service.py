"""
Tests for ConfigurationService in app.services.configuration.
"""

import os
import tempfile
from unittest.mock import MagicMock, patch, mock_open

import pytest
import yaml

from app.services.configuration import ConfigurationService


class TestConfigurationService:
    """Test ConfigurationService class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()
        self.service = ConfigurationService(values_dir=self.temp_dir)

        # Sample test data
        self.sample_consumer_data = {
            "resources": {"requests": {"cpu": "500m", "memory": "1Gi"}},
            "chains": {
                "chain1": {
                    "interfaces": [
                        {
                            "interface": "interface1",
                            "port": 8080,
                            "addons": ["addon1", "addon2"],
                            "staticProviders": [
                                {"url": "https://lava-provider.lava.infra"}
                            ],
                        }
                    ]
                }
            },
        }

        self.sample_provider_data = {
            "chains": [
                {
                    "name": "lava",
                    "interfaces": [
                        {
                            "nodes": [
                                {
                                    "endpoint": "https://node1.lava.infra",
                                    "type": "full",
                                    "addons": ["addon1", "addon3"],
                                },
                                {
                                    "endpoint": "https://node2.lava.infra",
                                    "type": "archive",
                                    "addons": ["addon2"],
                                },
                            ]
                        }
                    ],
                }
            ]
        }

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

    def test_get_consumer_resources(self):
        """Test extracting consumer resources."""
        resources = self.service.get_consumer_resources(self.sample_consumer_data)

        assert resources["cpu"] == 0.5  # 500m = 0.5 cores
        assert resources["memory"] == 1.0  # 1Gi = 1.0 GB

    def test_get_consumer_resources_no_resources(self):
        """Test extracting resources when none are defined."""
        data_without_resources = {"chains": {}}
        resources = self.service.get_consumer_resources(data_without_resources)

        assert resources["cpu"] == 0.0
        assert resources["memory"] == 0.0

    def test_get_consumer_resources_partial_resources(self):
        """Test extracting resources when only some are defined."""
        data_partial = {"resources": {"requests": {"cpu": "1000m"}}}  # Only CPU defined
        resources = self.service.get_consumer_resources(data_partial)

        assert resources["cpu"] == 1.0
        assert resources["memory"] == 0.0

    def test_build_consumer_config(self):
        """Test building consumer configuration."""
        chain_id = "chain1"
        chain_data = self.sample_consumer_data["chains"]["chain1"]

        result = self.service.build_consumer_config(chain_id, chain_data)

        assert "interfaces" in result
        assert len(result["interfaces"]) == 1

        interface = result["interfaces"][0]
        assert interface["name"] == "interface1"
        assert interface["port"] == 8080
        assert interface["addons"] == ["addon1", "addon2"]
        assert len(interface["providers"]) == 1

    def test_build_provider_config(self):
        """Test building provider configuration."""
        provider = {"url": "https://lava-provider.lava.infra"}

        # Mock the provider data reading
        with patch.object(
            self.service, "read_yaml_file", return_value=self.sample_provider_data
        ):
            result = self.service._build_provider_config(provider)

        assert result["name"] == "lava"
        assert result["url"] == "https://lava-provider.lava.infra"
        assert len(result["nodes"]) == 2
        # Check that all addons are present (order may vary due to set operations)
        assert set(result["addons"]) == {"addon1", "addon3", "addon2"}
        assert len(result["addons"]) == 3  # No duplicates

    def test_build_provider_config_no_provider_data(self):
        """Test building provider config when no provider data exists."""
        provider = {"url": "https://unknown-provider.example.com"}

        with patch.object(self.service, "read_yaml_file", return_value=None):
            result = self.service._build_provider_config(provider)

        assert result["name"] == "unknown"
        assert result["url"] == "https://unknown-provider.example.com"
        assert result["nodes"] == []
        assert result["addons"] == []

    def test_update_provider_values(self):
        """Test updating provider values file."""
        config = {
            "consumers": {
                "chain1": {
                    "addons": ["addon1", "addon2"],
                    "interfaces": [
                        {
                            "name": "interface1",
                            "providers": [
                                {
                                    "name": "provider1",
                                    "nodes": [
                                        {
                                            "endpoint": "https://node1.example.com",
                                            "type": "full",
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                }
            }
        }

        # Mock the file operations
        with patch.object(
            self.service, "read_yaml_file", return_value={}
        ), patch.object(self.service, "write_yaml_file") as mock_write:

            self.service.update_provider_values(config)

            # Verify write was called
            mock_write.assert_called_once()

            # Get the data that was written
            call_args = mock_write.call_args
            written_data = call_args[0][1]  # Second argument is the data

            assert "chains" in written_data
            assert len(written_data["chains"]) == 1

            chain = written_data["chains"][0]
            assert chain["name"] == "provider1"
            assert chain["id"] == "chain1"

    def test_update_consumer_values(self):
        """Test updating consumer values file."""
        config = {
            "consumers": {
                "chain1": {
                    "addons": ["addon1", "addon2"],
                    "interfaces": [
                        {
                            "name": "interface1",
                            "port": 8080,
                            "providers": [{"url": "https://provider1.example.com"}],
                        }
                    ],
                }
            }
        }

        # Mock the file operations
        with patch.object(
            self.service, "read_yaml_file", return_value={}
        ), patch.object(self.service, "write_yaml_file") as mock_write:

            self.service.update_consumer_values(config)

            # Verify write was called
            mock_write.assert_called_once()

            # Get the data that was written
            call_args = mock_write.call_args
            written_data = call_args[0][1]  # Second argument is the data

            assert "chains" in written_data
            assert "chain1" in written_data["chains"]

            chain = written_data["chains"]["chain1"]
            assert len(chain["interfaces"]) == 1

            interface = chain["interfaces"][0]
            assert interface["interface"] == "interface1"
            assert interface["port"] == 8080
            assert interface["addons"] == ["addon1", "addon2"]
            assert len(interface["staticProviders"]) == 1
