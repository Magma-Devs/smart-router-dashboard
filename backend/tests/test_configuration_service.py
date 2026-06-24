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

    def test_sr_config_local_port_from_listen_address(self):
        """The endpoints[] listen-address port is carried onto each router."""
        sr_config = {
            "endpoints": [
                {"chain-id": "ETH1", "listen-address": "0.0.0.0:3360"},
                {"chain-id": "ARBITRUM", "listen-address": "0.0.0.0:3361"},
            ],
            "direct-rpc": [
                {
                    "chain-id": "ETH1",
                    "api-interface": "jsonrpc",
                    "node-urls": [{"url": "https://eth.example"}],
                },
                {
                    "chain-id": "ARBITRUM",
                    "api-interface": "jsonrpc",
                    "node-urls": [{"url": "https://arb.example"}],
                },
            ],
        }

        with patch.object(self.service, "read_yaml_file", return_value=sr_config):
            data = self.service.read_smart_router_values()
            # Parsed RouterConfig objects carry it too (same patch context).
            rc = {r.id: r for r in self.service._read_smart_router_values()}

        by_id = {r["id"]: r for r in data["routers"]}
        assert by_id["ETH1"]["local_port"] == 3360
        assert by_id["ARBITRUM"]["local_port"] == 3361
        assert rc["ETH1"].local_port == 3360
        # These endpoints omit api-interface, so the port lands under the ""
        # bucket; the frontend's per-interface lookup misses and falls back to
        # the scalar local_port. (When endpoints DO declare api-interface — the
        # wizard-generated shape — the map is keyed by it; see
        # test_sr_config_local_ports_per_interface.)
        assert by_id["ETH1"]["local_ports"] == {"": 3360}
        assert by_id["ARBITRUM"]["local_ports"] == {"": 3361}

    def test_sr_config_local_ports_per_interface(self):
        """A chain exposing several interfaces on DIFFERENT ports keeps each
        port keyed by api-interface — rest:3360 + tendermintrpc:3361 must NOT
        collapse onto one port. (Regression: the dashboard showed both LAVA
        interfaces at localhost:3360 because local_port was chain-wide.)"""
        sr_config = {
            "endpoints": [
                {
                    "chain-id": "LAVA",
                    "api-interface": "rest",
                    "listen-address": "0.0.0.0:3360",
                },
                {
                    "chain-id": "LAVA",
                    "api-interface": "tendermintrpc",
                    "listen-address": "0.0.0.0:3361",
                },
            ],
            "direct-rpc": [
                {
                    "chain-id": "LAVA",
                    "api-interface": "rest",
                    "node-urls": [{"url": "https://lava.example"}],
                },
                {
                    "chain-id": "LAVA",
                    "api-interface": "tendermintrpc",
                    "node-urls": [{"url": "https://lava.tm.example"}],
                },
            ],
        }

        with patch.object(self.service, "read_yaml_file", return_value=sr_config):
            data = self.service.read_smart_router_values()
            rc = {r.id: r for r in self.service._read_smart_router_values()}

        lava = {r["id"]: r for r in data["routers"]}["LAVA"]
        # Per-interface map resolves each interface to its OWN port.
        assert lava["local_ports"] == {"rest": 3360, "tendermintrpc": 3361}
        # Back-compat scalar is the first interface's port (insertion order).
        assert lava["local_port"] == 3360
        # The parsed RouterConfig carries the map too.
        assert rc["LAVA"].local_ports == {"rest": 3360, "tendermintrpc": 3361}

    def test_sr_config_local_port_absent_when_no_endpoints(self):
        """No endpoints block -> local_port is None (helm/gateway deployments)."""
        sr_config = {
            "direct-rpc": [
                {
                    "chain-id": "ETH1",
                    "api-interface": "jsonrpc",
                    "node-urls": [{"url": "https://eth.example"}],
                }
            ],
        }
        with patch.object(self.service, "read_yaml_file", return_value=sr_config):
            result = self.service._read_smart_router_values()
        assert result[0].local_port is None

    def test_read_smart_router_sr_config_direct_rpc(self):
        """A raw smart-router SR_CONFIG (endpoints/direct-rpc) is normalized."""
        sr_config = {
            "metrics-listen-address": "0.0.0.0:7779",
            "endpoints": [
                {"chain-id": "ETH1", "api-interface": "jsonrpc"},
            ],
            "direct-rpc": [
                {
                    "name": "eth-lava-build",
                    "chain-id": "ETH1",
                    "api-interface": "jsonrpc",
                    "node-urls": [
                        {"url": "https://eth1.lava.build"},
                        {"url": "wss://eth1.lava.build/websocket"},
                    ],
                },
                {
                    "name": "eth-publicnode",
                    "chain-id": "ETH1",
                    "api-interface": "jsonrpc",
                    "node-urls": [{"url": "https://ethereum-rpc.publicnode.com"}],
                },
            ],
        }

        with patch.object(self.service, "read_yaml_file", return_value=sr_config):
            result = self.service._read_smart_router_values()

        # Both providers share chain-id ETH1 -> one router, two nodes.
        assert len(result) == 1
        router = result[0]
        assert router.id == "ETH1"
        # network lowercased so network.upper() == spec label "ETH1".
        assert router.network == "eth1"
        assert {n.name for n in router.nodes} == {"eth-lava-build", "eth-publicnode"}
        lava = next(n for n in router.nodes if n.name == "eth-lava-build")
        assert lava.get_endpoint_urls() == [
            "https://eth1.lava.build",
            "wss://eth1.lava.build/websocket",
        ]
        assert lava.endpoints[0].interface == "jsonrpc"

    def test_read_smart_router_sr_config_multichain(self):
        """direct-rpc providers group into one router per chain-id."""
        sr_config = {
            "direct-rpc": [
                {
                    "name": "eth",
                    "chain-id": "ETH1",
                    "api-interface": "jsonrpc",
                    "node-urls": [{"url": "https://eth1.lava.build"}],
                },
                {
                    "name": "arb",
                    "chain-id": "ARBITRUM",
                    "api-interface": "jsonrpc",
                    "node-urls": [{"url": "https://arbitrum.lava.build"}],
                },
            ],
        }

        with patch.object(self.service, "read_yaml_file", return_value=sr_config):
            data = self.service.read_smart_router_values()

        assert data is not None
        ids = {r["id"] for r in data["routers"]}
        assert ids == {"ETH1", "ARBITRUM"}

    def test_read_smart_router_sr_config_addons_preserved(self):
        """Per-node-url addons survive normalization onto the endpoint."""
        sr_config = {
            "direct-rpc": [
                {
                    "name": "eth-archive",
                    "chain-id": "ETH1",
                    "api-interface": "jsonrpc",
                    "node-urls": [
                        {"url": "https://eth1.lava.build", "addons": ["archive"]},
                    ],
                },
            ],
        }

        with patch.object(self.service, "read_yaml_file", return_value=sr_config):
            result = self.service._read_smart_router_values()

        assert result[0].get_addons() == ["archive"]

    def test_read_smart_router_unknown_shape_is_empty(self):
        """A dict with neither routers nor direct-rpc yields no routers."""
        with patch.object(
            self.service, "read_yaml_file", return_value={"something": "else"}
        ):
            assert self.service._read_smart_router_values() == []

    def test_production_helm_values_full_shape(self):
        """The full production helm values (multi-chain, mixed auth dialects,
        skip_verifications) parse cleanly."""
        helm = {
            "base_domain": "lava.magmadevs.com",
            "debug": {"enabled": True},
            "routers": [
                {
                    "id": "eth",
                    "network": "eth1",
                    "nodes": [
                        {
                            "name": "Google1",
                            "skip_verifications": "chain-id,pruning",
                            "endpoints": [
                                {
                                    "url": "https://node.example/jsonrpc",
                                    "interface": "jsonrpc",
                                    "addons": ["archive", "trace", "debug"],
                                },
                                {
                                    "url": "wss://node.example/ws",
                                    "interface": "jsonrpc",
                                },
                            ],
                        }
                    ],
                },
                {
                    "id": "lava-grpc",
                    "network": "lava",
                    "nodes": [
                        {
                            "name": "LavaGateway",
                            "endpoints": [
                                {
                                    "url": "grpcs://host:443",
                                    "interface": "grpc",
                                    # kebab-case auth-config / use-tls (was
                                    # silently dropped before alias support)
                                    "auth-config": {"use-tls": True},
                                }
                            ],
                        }
                    ],
                },
                {
                    "id": "solana",
                    "network": "solana",
                    "nodes": [
                        {
                            "name": "Tatum1",
                            "endpoints": [
                                {
                                    "url": "https://solana.example",
                                    "interface": "jsonrpc",
                                    # snake_case auth_config / auth_headers
                                    "auth_config": {
                                        "auth_headers": {"x-api-key": "secret"}
                                    },
                                }
                            ],
                        }
                    ],
                },
            ],
        }

        with patch.object(self.service, "read_yaml_file", return_value=helm):
            result = self.service._read_smart_router_values()

        by_id = {r.id: r for r in result}
        assert set(by_id) == {"eth", "lava-grpc", "solana"}

        # skip_verifications survives.
        eth = by_id["eth"]
        assert eth.nodes[0].skip_verifications == "chain-id,pruning"
        assert eth.get_addons() == ["archive", "trace", "debug"] or set(
            eth.get_addons()
        ) == {"archive", "trace", "debug"}

        # kebab-case auth-config / use-tls binds.
        grpc_ep = by_id["lava-grpc"].nodes[0].endpoints[0]
        assert grpc_ep.auth_config is not None
        assert grpc_ep.auth_config.use_tls is True

        # snake_case auth_config / auth_headers binds.
        sol_ep = by_id["solana"].nodes[0].endpoints[0]
        assert sol_ep.auth_config is not None
        assert sol_ep.auth_config.auth_headers == {"x-api-key": "secret"}

    def test_auth_config_both_dialects_equivalent(self):
        """auth-config (kebab) and auth_config (snake) produce the same model."""
        from app.core.dataclasses import EndpointConfig

        kebab = EndpointConfig.model_validate(
            {
                "url": "grpcs://h:443",
                "interface": "grpc",
                "auth-config": {"use-tls": True, "allow-insecure": True},
            }
        )
        snake = EndpointConfig.model_validate(
            {
                "url": "grpcs://h:443",
                "interface": "grpc",
                "auth_config": {"use_tls": True, "allow_insecure": True},
            }
        )
        assert kebab.auth_config == snake.auth_config
        assert kebab.auth_config.use_tls is True
        assert kebab.auth_config.allow_insecure is True

    def test_response_serialization_stays_snake_case(self):
        """Alias support is input-only; serialized output keeps snake_case."""
        from app.core.dataclasses import EndpointConfig

        ep = EndpointConfig.model_validate(
            {
                "url": "grpcs://h:443",
                "interface": "grpc",
                "auth-config": {"use-tls": True},
            }
        )
        dumped = ep.model_dump()
        assert "auth_config" in dumped
        assert dumped["auth_config"]["use_tls"] is True

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
        node = NodeConfig(name="test_node", endpoints=[endpoint1, endpoint2])

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
