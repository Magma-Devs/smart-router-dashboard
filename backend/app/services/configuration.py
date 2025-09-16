"""
Configuration service for managing Helm values and configuration files.
"""

import os
from typing import Any

import yaml

from app.core.config import settings
from app.core.utils import (
    convert_memory_to_gb,
    convert_cpu_to_cores,
    extract_provider_name_from_url,
    remove_duplicate_addons,
)


class ConfigurationService:
    """
    Service for managing configuration files and Helm values.

    This service provides functionality to read, write, and manipulate
    YAML configuration files, particularly Helm values files for
    consumer and provider configurations. It handles resource parsing,
    configuration building, and file operations with proper error handling.

    Attributes:
        values_dir (str): Directory path containing Helm values files
    """

    def __init__(self, values_dir: str | None = None):
        """
        Initialize configuration service.

        Args:
            values_dir: Directory containing Helm values files
        """
        self.values_dir = values_dir or settings.helm_values_dir

    def read_yaml_file(self, file_path: str) -> dict[str, Any] | None:
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

    def write_yaml_file(self, file_path: str, data: dict[str, Any]) -> None:
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

    def get_consumer_resources(self, consumer_data: dict[str, Any]) -> dict[str, float]:
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
        self, chain_id: str, chain_data: dict[str, Any]
    ) -> dict[str, Any]:
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

    def _build_provider_config(self, provider: dict[str, Any]) -> dict[str, Any]:
        """
        Build provider configuration from provider data.

        Args:
            provider: Provider configuration data

        Returns:
            Provider configuration dictionary
        """
        provider_url = provider["url"]
        provider_name = extract_provider_name_from_url(provider_url)

        # Get provider nodes from smart-router values
        smart_router_data = self.read_smart_router_values()
        provider_nodes = []
        provider_addons = []

        if smart_router_data and "chains" in smart_router_data:
            # Find providers across all chains in smart-router format
            for chain in smart_router_data["chains"]:
                for chain_provider in chain.get("providers", []):
                    if chain_provider.get("name") == provider_name:
                        for iface in chain_provider.get("interfaces", []):
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


    def read_smart_router_values(self) -> dict[str, Any] | None:
        """
        Read the unified smart-router values.yml file.

        Returns:
            Parsed smart-router configuration or None if file doesn't exist
        """
        values_path = os.path.join(self.values_dir, "core", "values.yml")
        return self.read_yaml_file(values_path)

    def update_smart_router_values(self, updates: dict[str, Any]) -> None:
        """
        Update the smart-router values.yml file.
        
        Args:
            updates: Dictionary containing updates to merge with existing config
        """
        values_path = os.path.join(self.values_dir, "core", "values.yml")
        
        # Read existing values
        existing_values = self.read_yaml_file(values_path) or {}
        
        # Merge updates
        existing_values.update(updates)
        
        # Write back to file
        self.write_yaml_file(values_path, existing_values)



# Global instance for dependency injection
configuration_service = ConfigurationService()
