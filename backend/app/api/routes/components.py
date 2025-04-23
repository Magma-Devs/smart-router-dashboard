from fastapi import APIRouter, HTTPException, Body
from typing import Dict, List, Any, Optional
import yaml
import os
from app.core.config import settings
from app.services.kubernetes import kubernetes_service
from pydantic import BaseModel

router = APIRouter()


class ProviderNode(BaseModel):
    endpoint: str
    type: str
    addons: List[str]


class ProviderInterface(BaseModel):
    name: str
    nodes: List[ProviderNode]


class ProviderConfig(BaseModel):
    name: str
    interfaces: List[ProviderInterface]


class ConsumerProvider(BaseModel):
    name: str
    url: str


class ConsumerInterface(BaseModel):
    name: str
    port: int
    addons: List[str]
    providers: List[ConsumerProvider]


class ConsumerConfig(BaseModel):
    name: Optional[str] = None
    interfaces: List[ConsumerInterface]


class ConfigurationUpdate(BaseModel):
    consumers: Dict[str, ConsumerConfig]
    providers: Dict[str, List[ProviderConfig]]


@router.get("/")
async def get_configuration():
    """Get the current configuration for consumers and providers"""
    try:
        values_dir = settings.HELM_VALUES_DIR
        config = {"consumers": {}, "providers": {}}

        # First read provider values to build provider map
        provider_path = os.path.join(values_dir, "core", "provider.values.yml")
        if os.path.exists(provider_path):
            with open(provider_path, "r") as f:
                provider_data = yaml.safe_load(f)
                if "chains" in provider_data:
                    for chain in provider_data["chains"]:
                        chain_id = chain["id"]
                        if chain_id not in config["providers"]:
                            config["providers"][chain_id] = []

                        provider = {"name": chain["name"], "interfaces": []}

                        for interface in chain.get("interfaces", []):
                            provider_interface = {
                                "name": interface["interface"],
                                "nodes": [],
                            }

                            for node in interface.get("nodes", []):
                                provider_interface["nodes"].append(
                                    {
                                        "endpoint": node["endpoint"],
                                        "type": node["type"],
                                        "addons": node.get("addons", []),
                                    }
                                )

                            provider["interfaces"].append(provider_interface)

                        config["providers"][chain_id].append(provider)

        # Read consumer values
        consumer_path = os.path.join(values_dir, "core", "consumer.values.yml")
        if os.path.exists(consumer_path):
            with open(consumer_path, "r") as f:
                consumer_data = yaml.safe_load(f)
                if "chains" in consumer_data:
                    for chain_id, chain_data in consumer_data["chains"].items():
                        consumer = {"interfaces": []}

                        for interface in chain_data.get("interfaces", []):
                            interface_config = {
                                "name": interface["interface"],
                                "port": interface["port"],
                                "addons": interface.get("addons", []),
                                "providers": [],
                            }

                            for provider in interface.get("staticProviders", []):
                                # Extract provider name from URL
                                provider_url = provider["url"]
                                provider_name = provider_url.split(".")[0].replace(
                                    "-provider", ""
                                )

                                interface_config["providers"].append(
                                    {"name": provider_name, "url": provider_url}
                                )

                            consumer["interfaces"].append(interface_config)

                        config["consumers"][chain_id] = consumer

        return config
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error reading configuration: {str(e)}"
        )


@router.post("/")
async def update_configuration(config: ConfigurationUpdate):
    """Update the configuration for consumers and providers"""
    try:
        values_dir = settings.HELM_VALUES_DIR

        # Update provider values
        provider_path = os.path.join(values_dir, "core", "provider.values.yml")
        if os.path.exists(provider_path):
            with open(provider_path, "r") as f:
                provider_data = yaml.safe_load(f)

            # Update chains in provider data
            provider_data["chains"] = []
            for chain_id, providers in config.providers.items():
                for provider in providers:
                    chain_config = {
                        "name": provider.name,
                        "id": chain_id,
                        "interfaces": [],
                    }

                    for interface in provider.interfaces:
                        interface_config = {"interface": interface.name, "nodes": []}

                        for node in interface.nodes:
                            node_config = {
                                "endpoint": node.endpoint,
                                "type": node.type,
                                "addons": node.addons,
                            }
                            interface_config["nodes"].append(node_config)

                        chain_config["interfaces"].append(interface_config)

                    provider_data["chains"].append(chain_config)

            # Write updated provider values
            with open(provider_path, "w") as f:
                yaml.dump(provider_data, f, default_flow_style=False)

        # Update consumer values
        consumer_path = os.path.join(values_dir, "core", "consumer.values.yml")
        if os.path.exists(consumer_path):
            with open(consumer_path, "r") as f:
                consumer_data = yaml.safe_load(f)

            # Update chains in consumer data
            consumer_data["chains"] = {}
            for chain_id, consumer in config.consumers.items():
                chain_config = {"name": consumer.name, "interfaces": []}

                for interface in consumer.interfaces:
                    interface_config = {
                        "interface": interface.name,
                        "port": interface.port,
                        "addons": interface.addons,
                        "staticProviders": [],
                    }

                    for provider in interface.providers:
                        provider_config = {"url": provider.url}
                        interface_config["staticProviders"].append(provider_config)

                    chain_config["interfaces"].append(interface_config)

                consumer_data["chains"][chain_id] = chain_config

            # Write updated consumer values
            with open(consumer_path, "w") as f:
                yaml.dump(consumer_data, f, default_flow_style=False)

        # Apply Helm releases using Kubernetes service
        try:
            # Apply consumer HelmRelease
            kubernetes_service.apply_helm_release(
                name="consumer",
                namespace="lava-infra",
                chart="lavanet/consumer",
                version="0.5.x",
                values_file=consumer_path,
            )

            # Apply provider HelmRelease
            kubernetes_service.apply_helm_release(
                name="provider",
                namespace="lava-infra",
                chart="lavanet/provider",
                version="0.5.x",
                values_file=provider_path,
            )

            # Label ServiceMonitors for Prometheus discovery
            kubernetes_service.label_servicemonitor(
                name="consumer",
                namespace="lava-infra",
                labels={"release": "kube-prom-stack"},
            )
            kubernetes_service.label_servicemonitor(
                name="provider",
                namespace="lava-infra",
                labels={"release": "kube-prom-stack"},
            )

        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error applying helm templates: {str(e)}"
            )

        return {
            "message": "Configuration updated and helm templates applied successfully"
        }
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error updating configuration: {str(e)}"
        )
