"""
Configuration service for managing Helm values and configuration files.
"""

import os
from typing import Any

import yaml

from app.core.config import settings
from app.core.dataclasses import RouterConfig


def _normalize_smart_router_config(raw: dict[str, Any]) -> dict[str, Any]:
    """Coerce a router config dict into the unified ``routers``/``nodes`` shape.

    Two on-disk formats are accepted:

    1. **Dashboard helm values** — already the target shape::

           routers:
             - id: Ethereum
               network: eth1
               nodes:
                 - name: lava
                   endpoints:
                     - {url, interface, addons}

       Returned unchanged.

    2. **Smart-router ``SR_CONFIG``** — the YAML the router itself runs::

           endpoints:
             - chain-id: ETH1
               api-interface: jsonrpc
           direct-rpc:
             - name: eth-lava-build
               chain-id: ETH1
               api-interface: jsonrpc
               node-urls:
                 - {url, addons}

       Each ``direct-rpc`` provider becomes one node; providers are grouped
       by ``chain-id`` into one router per chain. ``chain-id`` (already the
       uppercase Prometheus ``spec`` label, e.g. ``ETH1``) is lowercased into
       ``network`` so it matches the dashboard's ``network.upper() == spec``
       correlation, and reused as the router ``id``. The ``endpoints`` block's
       ``listen-address`` port is carried onto each router as ``local_port``
       for the dashboard's local mode (localhost:<port>).

    Detection is by key: ``routers`` → format 1; ``direct-rpc`` → format 2.
    Anything else yields an empty topology.
    """
    if not isinstance(raw, dict):
        return {"routers": []}

    if "routers" in raw:
        return raw

    if "direct-rpc" not in raw:
        return {"routers": []}

    # Map chain-id -> local listen port from the `endpoints` block. In a local
    # docker-compose run there's no gateway: each chain is reached directly at
    # localhost:<port> (e.g. listen-address "0.0.0.0:3360" -> ETH1 on 3360),
    # so the dashboard's local mode builds http://localhost:<port> from this.
    local_ports: dict[str, int] = {}
    for endpoint in raw.get("endpoints") or []:
        chain_id = endpoint.get("chain-id")
        listen = endpoint.get("listen-address") or endpoint.get("network-address")
        if not chain_id or not listen:
            continue
        port = _port_from_listen_address(listen)
        if port is not None:
            local_ports.setdefault(chain_id, port)

    # Group direct-rpc providers by chain-id into one router each.
    routers_by_chain: dict[str, dict[str, Any]] = {}
    for provider in raw.get("direct-rpc") or []:
        chain_id = provider.get("chain-id")
        if not chain_id:
            continue

        interface = provider.get("api-interface", "")
        endpoints = [
            {
                "url": node_url.get("url", ""),
                "interface": interface,
                "addons": node_url.get("addons", []) or [],
            }
            for node_url in (provider.get("node-urls") or [])
            if node_url.get("url")
        ]

        node = {
            "name": provider.get("name") or chain_id,
            "endpoints": endpoints,
        }

        router = routers_by_chain.setdefault(
            chain_id,
            {
                "id": chain_id,
                "network": chain_id.lower(),
                "nodes": [],
                "local_port": local_ports.get(chain_id),
            },
        )
        router["nodes"].append(node)

    return {"routers": list(routers_by_chain.values())}


def _port_from_listen_address(listen: str) -> int | None:
    """Extract the port from a ``host:port`` listen-address string.

    Accepts ``0.0.0.0:3360``, ``:3360``, ``127.0.0.1:3360``. Returns None if no
    parseable port is present.
    """
    if ":" not in listen:
        return None
    port_str = listen.rsplit(":", 1)[1].strip()
    try:
        return int(port_str)
    except ValueError:
        return None


class ConfigurationService:
    """
    Service for managing configuration files and Helm values.

    Reads either the unified smart-router values.yml (routers/nodes structure)
    or a raw smart-router ``SR_CONFIG`` (endpoints/direct-rpc structure) and
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
        """Read core/values.yml and parse into RouterConfig objects.

        Accepts both the helm ``routers``/``nodes`` shape and a raw
        smart-router ``SR_CONFIG`` (``endpoints``/``direct-rpc``); the latter
        is normalized on read (see ``_normalize_smart_router_config``).
        """
        yaml_data = self.read_smart_router_values()

        if not yaml_data or "routers" not in yaml_data:
            return []

        return [RouterConfig(**router) for router in yaml_data["routers"]]

    def read_smart_router_values(self) -> dict[str, Any] | None:
        """Return the values.yml data normalized to the routers/nodes shape.

        Used by the components route, which iterates the raw ``routers`` list.
        A raw smart-router ``SR_CONFIG`` is transparently normalized here so
        callers only ever see the unified shape.
        """
        values_path = os.path.join(self.values_dir, "core", "values.yml")
        raw = self.read_yaml_file(values_path)
        if raw is None:
            return None
        return _normalize_smart_router_config(raw)

    @property
    def get_chains_providers_configuration(self) -> list[RouterConfig]:
        """Return the list of RouterConfig objects loaded at startup."""
        return self.smart_router_values


# Global instance for dependency injection
configuration_service = ConfigurationService()
