from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.auth import get_current_user
from app.services.configuration import ConfigurationService, configuration_service
from app.services.kubernetes import KubernetesService, kubernetes_service

router = APIRouter()


class ProviderNode(BaseModel):
    endpoint: str
    type: str = "full"


class ConsumerProvider(BaseModel):
    name: str
    url: str
    nodes: list[ProviderNode]


class ConsumerInterface(BaseModel):
    name: str
    port: int
    providers: list[ConsumerProvider]


class ConsumerConfig(BaseModel):
    addons: list[str]
    interfaces: list[ConsumerInterface]


class ConfigurationUpdate(BaseModel):
    consumers: dict[str, ConsumerConfig]


# Utility functions moved to app.core.utils


def get_configuration_service() -> ConfigurationService:
    """Dependency accessor for ConfigurationService."""
    return configuration_service


def get_kubernetes_service() -> KubernetesService:
    """Dependency accessor for KubernetesService."""
    return kubernetes_service


@router.get("/")
async def get_configuration(
    current_user: str = Depends(get_current_user),
    config_service: ConfigurationService = Depends(get_configuration_service),
    k8s_service: KubernetesService = Depends(get_kubernetes_service),
):
    """Get the current configuration for consumers and providers"""
    try:
        config = {
            "consumers": {},
            "resource_limits": {
                "server": {"cpu": 0, "memory": 0},
                "per_consumer": {"cpu": 0, "memory": 0},
                "per_provider": {"cpu": 0, "memory": 0},
            },
        }

        # Read consumer values to get single consumer resources
        consumer_path = f"{config_service.values_dir}/core/consumer.values.yml"
        consumer_data = config_service.read_yaml_file(consumer_path)

        if consumer_data and "chains" in consumer_data:
            # Get resources for a single consumer (assuming all consumers have same resources)
            resources = config_service.get_consumer_resources(consumer_data)
            config["resource_limits"]["per_consumer"]["cpu"] = resources["cpu"]
            config["resource_limits"]["per_consumer"]["memory"] = resources["memory"]

            # Build consumer configurations
            for chain_id, chain_data in consumer_data["chains"].items():
                consumer_config = config_service.build_consumer_config(
                    chain_id, chain_data
                )
                config["consumers"][chain_id] = consumer_config

        # Get server resources from Kubernetes
        try:
            node_info = k8s_service.get_node_resources()
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
async def update_configuration(
    config: ConfigurationUpdate,
    config_service: ConfigurationService = Depends(get_configuration_service),
    k8s_service: KubernetesService = Depends(get_kubernetes_service),
):
    """Update the configuration for consumers and providers"""
    try:
        # Convert Pydantic model to dict for service
        config_dict = {
            "consumers": {
                chain_id: {
                    "addons": consumer.addons,
                    "interfaces": [
                        {
                            "name": interface.name,
                            "port": interface.port,
                            "providers": [
                                {
                                    "name": provider.name,
                                    "url": provider.url,
                                    "nodes": [
                                        {
                                            "endpoint": node.endpoint,
                                            "type": node.type,
                                        }
                                        for node in provider.nodes
                                    ],
                                }
                                for provider in interface.providers
                            ],
                        }
                        for interface in consumer.interfaces
                    ],
                }
                for chain_id, consumer in config.consumers.items()
            }
        }

        # Update configuration files using service
        config_service.update_provider_values(config_dict)
        config_service.update_consumer_values(config_dict)

        # Apply Helm releases using Kubernetes service
        try:
            # Apply consumer HelmRelease
            k8s_service.apply_helm_release(
                name="consumer",
                namespace="lava-infra",
                chart="lavanet/consumer",
                version="0.5.x",
                values_file=f"{config_service.values_dir}/core/consumer.values.yml",
            )

            # Apply provider HelmRelease
            k8s_service.apply_helm_release(
                name="provider",
                namespace="lava-infra",
                chart="lavanet/provider",
                version="0.5.x",
                values_file=f"{config_service.values_dir}/core/provider.values.yml",
            )

            # Label ServiceMonitors for Prometheus discovery
            k8s_service.label_servicemonitor(
                name="consumer",
                namespace="lava-infra",
                labels={"release": "kube-prom-stack"},
            )
            k8s_service.label_servicemonitor(
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
