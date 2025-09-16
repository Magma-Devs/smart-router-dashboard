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

        # Read smart-router values directly
        smart_router_data = config_service.read_smart_router_values()

        if smart_router_data and "chains" in smart_router_data:
            # Get resources from smart-router miscellaneous config
            miscellaneous = smart_router_data.get("miscellaneous", {})
            consumers_config = miscellaneous.get("consumers", {})
            resources = consumers_config.get("resources", {}).get("requests", {})
            
            config["resource_limits"]["per_consumer"]["cpu"] = resources.get("cpu", "500m")
            config["resource_limits"]["per_consumer"]["memory"] = resources.get("memory", "1Gi")

            # Build consumer configurations from smart-router chains
            for chain in smart_router_data["chains"]:
                chain_id = chain.get("id")
                if chain_id:
                    consumer_config = {
                        "id": chain_id,
                        "interfaces": chain.get("interfaces", []),
                        "providers": chain.get("providers", [])
                    }
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
        # Convert to smart-router format
        chains = []
        for chain_id, consumer in config.consumers.items():
            # Get all interfaces for this chain
            interfaces = []
            providers = []
            
            for interface in consumer.interfaces:
                interfaces.append(interface.name)
                # Collect unique providers (they're shared across interfaces in smart-router format)
                for provider in interface.providers:
                    provider_data = {
                        "name": provider.name,
                        "endpoint": provider.url
                    }
                    # Add provider if not already added
                    if not any(p["name"] == provider.name for p in providers):
                        providers.append(provider_data)
            
            chain_data = {
                "id": chain_id,
                "interfaces": interfaces,
                "default_interface": interfaces[0] if interfaces else "jsonrpc",
                "providers": providers
            }
            chains.append(chain_data)

        # Update smart-router values.yml
        config_service.update_smart_router_values({"chains": chains})

        # Apply Smart Router Helm release
        try:
            # Apply smart-router HelmRelease
            k8s_service.apply_helm_release(
                name="smart-router",
                namespace="lava-infra",
                chart="./modules/smart-router-helm-chart/charts/smart-router",
                version="latest",
                values_file=f"{config_service.values_dir}/core/values.yml",
            )

            # Label ServiceMonitors for Prometheus discovery
            k8s_service.label_servicemonitor(
                name="smart-router",
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
