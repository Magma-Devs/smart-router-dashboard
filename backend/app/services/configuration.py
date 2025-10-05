"""
Configuration service for managing Helm values and configuration files.
"""

import os
from typing import Any

from pydantic import BaseModel
import yaml

from app.core.config import settings
from app.core.dataclasses import ChainConfig


class ConfigurationService:
    """
    Service for managing configuration files and Helm values.

    This service provides functionality to read and write
    YAML configuration files, particularly Helm values files for
    chain and provider configurations. It handles resource parsing,
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
        self.smart_router_values: list[ChainConfig] = self._read_smart_router_values()

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

    def _read_smart_router_values(self) -> list[ChainConfig]:
        """
        Read the unified smart-router values.yml file.

        Returns:
            List of ChainConfig objects or empty list if file doesn't exist
        """
        values_path = os.path.join(self.values_dir, "core", "values.yml")
        yaml_data = self.read_yaml_file(values_path)

        if not yaml_data or "chains" not in yaml_data:
            return []

        return [ChainConfig(**chain) for chain in yaml_data["chains"]]

    def read_smart_router_values(self) -> dict[str, Any] | None:
        """
        Read the raw smart-router values.yml file data.

        Returns:
            Raw YAML data or None if file doesn't exist
        """
        values_path = os.path.join(self.values_dir, "core", "values.yml")
        return self.read_yaml_file(values_path)

    @property
    def get_chains_providers_configuration(self) -> list[ChainConfig]:
        """
        Get the chains and providers from the smart-router values.
        """
        return self.smart_router_values


# Global instance for dependency injection
configuration_service = ConfigurationService()
