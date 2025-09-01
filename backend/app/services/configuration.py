"""
Configuration service for managing Helm values and configuration files.
"""

import os
from typing import Dict, List, Optional, Any

import yaml

from app.core.config import settings
from app.core.utils import (
    convert_memory_to_gb,
    convert_cpu_to_cores,
    extract_provider_name_from_url,
    remove_duplicate_addons,
)


class ConfigurationService:
    """Service for managing configuration files and Helm values."""

    def __init__(self, values_dir: Optional[str] = None):
        """
        Initialize configuration service.

        Args:
            values_dir: Directory containing Helm values files
        """
        self.values_dir = values_dir or settings.helm_values_dir

    def read_yaml_file(self, file_path: str) -> Optional[Dict[str, Any]]:
        """
        Read and parse a YAML file.

        Args:
            file_path: Path to the YAML file

        Returns:
            Parsed YAML data or None if file doesn't exist
        """
        if not os.path.exists(file_path):
            return None

        try:
            with open(file_path, "r") as f:
                return yaml.safe_load(f)
        except (yaml.YAMLError, IOError) as e:
            raise ValueError(f"Error reading YAML file {file_path}: {str(e)}")

    def write_yaml_file(self, file_path: str, data: Dict[str, Any]) -> None:
        """
        Write data to a YAML file.

        Args:
            file_path: Path to the YAML file
            data: Data to write
        """
        try:
            # Ensure directory exists
            os.makedirs(os.path.dirname(file_path), exist_ok=True)

            with open(file_path, "w") as f:
                yaml.dump(data, f, default_flow_style=False)
        except IOError as e:
            raise ValueError(f"Error writing YAML file {file_path}: {str(e)}")

    def get_consumer_resources(self, consumer_data: Dict[str, Any]) -> Dict[str, float]:
        """
        Extract resource limits from consumer data.

        Args:
            consumer_data: Consumer configuration data

        Returns:
            Dictionary with CPU and memory limits
        """
        resources = {"cpu": 0.0, "memory": 0.0}

        if "resources" in consumer_data and "requests" in consumer_data["resources"]:
            requests = consumer_data["resources"]["requests"]
            if "cpu" in requests:
                resources["cpu"] = convert_cpu_to_cores(requests["cpu"])
            if "memory" in requests:
                resources["memory"] = convert_memory_to_gb(requests["memory"])

        return resources

    def build_consumer_config(
        self, chain_id: str, chain_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Build consumer configuration from chain data.

        Args:
            chain_id: Chain identifier
            chain_data: Chain configuration data

        Returns:
            Consumer configuration dictionary
        """
        consumer = {"interfaces": []}

        for interface in chain_data.get("interfaces", []):
            interface_config = {
                "name": interface["interface"],
                "port": interface["port"],
                "addons": interface.get("addons", []),
                "providers": [],
            }

            for provider in interface.get("staticProviders", []):
                provider_config = self._build_provider_config(provider)
                interface_config["providers"].append(provider_config)

            consumer["interfaces"].append(interface_config)

        return consumer

    def _build_provider_config(self, provider: Dict[str, Any]) -> Dict[str, Any]:
        """
        Build provider configuration from provider data.

        Args:
            provider: Provider configuration data

        Returns:
            Provider configuration dictionary
        """
        provider_url = provider["url"]
        provider_name = extract_provider_name_from_url(provider_url)

        # Get provider nodes from provider values
        provider_path = os.path.join(self.values_dir, "core", "provider.values.yml")
        provider_nodes = []
        provider_addons = []

        provider_data = self.read_yaml_file(provider_path)
        if provider_data and "chains" in provider_data:
            for chain in provider_data["chains"]:
                if chain["name"] == provider_name:
                    for iface in chain.get("interfaces", []):
                        for node in iface.get("nodes", []):
                            node_config = {
                                "endpoint": node["endpoint"],
                                "type": node.get("type", "full"),
                                "addons": node.get("addons", []),
                            }
                            provider_nodes.append(node_config)

                            # Collect addons from nodes
                            if "addons" in node:
                                provider_addons.extend(node["addons"])

        return {
            "name": provider_name,
            "url": provider_url,
            "addons": remove_duplicate_addons(provider_addons),
            "nodes": provider_nodes,
        }

    def update_provider_values(self, config: Dict[str, Any]) -> None:
        """
        Update provider values file with new configuration.

        Args:
            config: New configuration data
        """
        provider_path = os.path.join(self.values_dir, "core", "provider.values.yml")
        provider_data = self.read_yaml_file(provider_path) or {}

        # Update chains in provider data
        provider_data["chains"] = []
        for chain_id, consumer in config["consumers"].items():
            for interface in consumer["interfaces"]:
                for provider in interface["providers"]:
                    chain_config = {
                        "name": provider["name"],
                        "id": chain_id,
                        "interfaces": [
                            {
                                "interface": interface["name"],
                                "nodes": [
                                    {
                                        "endpoint": node["endpoint"],
                                        "type": node["type"],
                                        "addons": consumer["addons"],
                                    }
                                    for node in provider["nodes"]
                                ],
                            }
                        ],
                    }
                    provider_data["chains"].append(chain_config)

        self.write_yaml_file(provider_path, provider_data)

    def update_consumer_values(self, config: Dict[str, Any]) -> None:
        """
        Update consumer values file with new configuration.

        Args:
            config: New configuration data
        """
        consumer_path = os.path.join(self.values_dir, "core", "consumer.values.yml")
        consumer_data = self.read_yaml_file(consumer_path) or {}

        # Update chains in consumer data
        consumer_data["chains"] = {}
        for chain_id, consumer in config["consumers"].items():
            chain_config = {"interfaces": []}

            for interface in consumer["interfaces"]:
                interface_config = {
                    "interface": interface["name"],
                    "port": interface["port"],
                    "addons": consumer["addons"],
                    "staticProviders": [],
                }

                for provider in interface["providers"]:
                    provider_config = {"url": provider["url"]}
                    interface_config["staticProviders"].append(provider_config)

                chain_config["interfaces"].append(interface_config)

            consumer_data["chains"][chain_id] = chain_config

        self.write_yaml_file(consumer_path, consumer_data)


# Global instance for dependency injection
configuration_service = ConfigurationService()
