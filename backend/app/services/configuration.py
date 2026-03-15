"""
Configuration service for managing Helm values and configuration files.
"""

import os
from typing import Any

import yaml

from app.core.config import settings
from app.core.dataclasses import RouterConfig


class ConfigurationService:
    """
    Service for managing configuration files and Helm values.

    Reads the unified smart-router values.yml (routers/nodes structure) and
    exposes it as RouterConfig objects for use by metrics and components routes.

    Attributes:
        values_dir (str): Directory path containing Helm values files
    """

    def __init__(self, values_dir: str | None = None):
        self.values_dir = values_dir or settings.helm_values_dir
        self.smart_router_values: list[RouterConfig] = self._read_smart_router_values()

    def read_yaml_file(self, file_path: str) -> dict[str, Any] | None:
        if not os.path.exists(file_path):
            return None
        try:
            with open(file_path, "r") as f:
                return yaml.safe_load(f)
        except (yaml.YAMLError, IOError) as e:
            raise ValueError(f"Error reading YAML file {file_path}: {str(e)}")

    def write_yaml_file(self, file_path: str, data: dict[str, Any]) -> None:
        try:
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            with open(file_path, "w") as f:
                yaml.dump(data, f, default_flow_style=False)
        except IOError as e:
            raise ValueError(f"Error writing YAML file {file_path}: {str(e)}")

    def _read_smart_router_values(self) -> list[RouterConfig]:
        """Read core/values.yml and parse into RouterConfig objects (routers/nodes structure)."""
        values_path = os.path.join(self.values_dir, "core", "values.yml")
        yaml_data = self.read_yaml_file(values_path)

        if not yaml_data or "routers" not in yaml_data:
            return []

        return [RouterConfig(**router) for router in yaml_data["routers"]]

    def read_smart_router_values(self) -> dict[str, Any] | None:
        """Return the raw values.yml data (used by the components route)."""
        values_path = os.path.join(self.values_dir, "core", "values.yml")
        return self.read_yaml_file(values_path)

    @property
    def get_chains_providers_configuration(self) -> list[RouterConfig]:
        """Return the list of RouterConfig objects loaded at startup."""
        return self.smart_router_values


# Global instance for dependency injection
configuration_service = ConfigurationService()
