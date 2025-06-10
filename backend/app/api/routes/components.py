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
    type: str = "full"


class ConsumerProvider(BaseModel):
    name: str
    url: str
    nodes: List[ProviderNode]


class ConsumerInterface(BaseModel):
    name: str
    port: int
    providers: List[ConsumerProvider]


class ConsumerConfig(BaseModel):
    addons: List[str]
    interfaces: List[ConsumerInterface]


class ConfigurationUpdate(BaseModel):
    consumers: Dict[str, ConsumerConfig]


def convert_memory_to_gb(memory_str: str) -> float:
    """Convert memory string (e.g., '0.5Gi', '500Mi') to GB"""
    if not memory_str:
        return 0.0
    
    memory_str = memory_str.lower()
    if 'gi' in memory_str:
        return float(memory_str.replace('gi', ''))
    elif 'mi' in memory_str:
        return float(memory_str.replace('mi', '')) / 1024
    elif 'ki' in memory_str:
        return float(memory_str.replace('ki', '')) / (1024 * 1024)
    else:
        return float(memory_str) / (1024 * 1024 * 1024)  # Assume bytes if no unit


def convert_cpu_to_cores(cpu_str: str) -> float:
    """Convert CPU string (e.g., '500m', '0.5') to cores"""
    if not cpu_str:
        return 0.0
    
    cpu_str = cpu_str.lower()
    if 'm' in cpu_str:
        return float(cpu_str.replace('m', '')) / 1000
    else:
        return float(cpu_str)


@router.get("/")
async def get_configuration():
    """Get the current configuration for consumers and providers"""
    try:
        values_dir = settings.HELM_VALUES_DIR
        config = {
            "consumers": {},
            "resource_limits": {
                "server": {"cpu": 0, "memory": 0},
                "per_consumer": {"cpu": 0, "memory": 0},
                "per_provider": {"cpu": 0, "memory": 0}
            }
        }

        # Read consumer values to get single consumer resources
        consumer_path = os.path.join(values_dir, "core", "consumer.values.yml")
        if os.path.exists(consumer_path):
            with open(consumer_path, "r") as f:
                consumer_data = yaml.safe_load(f)
                if "chains" in consumer_data:
                    # Get resources for a single consumer (assuming all consumers have same resources)
                    if "resources" in consumer_data and "requests" in consumer_data["resources"]:
                        resources = consumer_data["resources"]["requests"]
                        if "cpu" in resources:
                            config["resource_limits"]["per_consumer"]["cpu"] = convert_cpu_to_cores(resources["cpu"])
                        if "memory" in resources:
                            config["resource_limits"]["per_consumer"]["memory"] = convert_memory_to_gb(resources["memory"])

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

                                # Get provider nodes from provider values
                                provider_path = os.path.join(values_dir, "core", "provider.values.yml")
                                provider_nodes = []
                                provider_addons = []
                                if os.path.exists(provider_path):
                                    with open(provider_path, "r") as pf:
                                        provider_data = yaml.safe_load(pf)
                                        if "chains" in provider_data:
                                            for chain in provider_data["chains"]:
                                                if chain["name"] == provider_name:
                                                    for iface in chain.get("interfaces", []):
                                                        for node in iface.get("nodes", []):
                                                            provider_nodes.append({
                                                                "endpoint": node["endpoint"],
                                                                "type": node.get("type", "full"),
                                                                "addons": node.get("addons", [])
                                                            })
                                                            # Collect addons from nodes
                                                            if "addons" in node:
                                                                provider_addons.extend(node["addons"])

                                interface_config["providers"].append({
                                    "name": provider_name,
                                    "url": provider_url,
                                    "addons": list(set(provider_addons)),  # Remove duplicates
                                    "nodes": provider_nodes
                                })

                            consumer["interfaces"].append(interface_config)

                        config["consumers"][chain_id] = consumer

        # Get server resources from Kubernetes
        try:
            node_info = kubernetes_service.get_node_resources()
            config["resource_limits"]["server"]["cpu"] = node_info["cpu"]
            config["resource_limits"]["server"]["memory"] = node_info["memory"]
        except Exception as e:
            print(f"Warning: Could not get server resources: {str(e)}")

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
            for chain_id, consumer in config.consumers.items():
                for interface in consumer.interfaces:
                    for provider in interface.providers:
                        chain_config = {
                            "name": provider.name,
                            "id": chain_id,
                            "interfaces": [{
                                "interface": interface.name,
                                "nodes": [
                                    {
                                        "endpoint": node.endpoint,
                                        "type": node.type,
                                        "addons": consumer.addons  # Propagate consumer addons to provider nodes
                                    } for node in provider.nodes
                                ]
                            }]
                        }
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
                chain_config = {
                    "interfaces": []
                }

                for interface in consumer.interfaces:
                    interface_config = {
                        "interface": interface.name,
                        "port": interface.port,
                        "addons": consumer.addons,  # Propagate consumer addons to interface
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
