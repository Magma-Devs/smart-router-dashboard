from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import get_current_user
from app.core.dataclasses import (
    AllResourceLimits,
    ComponentEndpoint,
    ComponentProvider,
    ComponentsResponse,
    ConsumerConfig,
    ResourceLimits,
)
from app.services.configuration import ConfigurationService, configuration_service

router = APIRouter()


def get_configuration_service() -> ConfigurationService:
    """Dependency accessor for ConfigurationService."""
    return configuration_service


@router.get("/", response_model=ComponentsResponse)
async def get_configuration(
    current_user: str = Depends(get_current_user),
    config_service: ConfigurationService = Depends(get_configuration_service),
):
    """Get the current configuration for consumers and providers"""
    try:
        # Initialize response structure
        consumers_config = {}
        resource_limits = AllResourceLimits(
            server=ResourceLimits(cpu=0, memory=0),
            per_consumer=ResourceLimits(cpu=0, memory=0),
            per_provider=ResourceLimits(cpu=0, memory=0),
        )

        # Read smart-router values directly
        smart_router_data = config_service.read_smart_router_values()

        if smart_router_data and "chains" in smart_router_data:
            # Build consumer configurations from smart-router chains
            for chain in smart_router_data["chains"]:
                chain_id = chain.get("id")
                network = chain.get("network")
                if chain_id and network:
                    # Extract interfaces and providers from the new structure
                    interfaces = set()
                    providers = []

                    for provider in chain.get("providers", []):
                        provider_name = provider.get("name")
                        provider_endpoints = []

                        for endpoint in provider.get("endpoints", []):
                            interface = endpoint.get("interface")
                            if interface:
                                interfaces.add(interface)

                            provider_endpoints.append(
                                ComponentEndpoint(
                                    interface=interface,
                                    addons=endpoint.get("addons", []),
                                )
                            )

                        providers.append(
                            ComponentProvider(
                                name=provider_name, endpoints=provider_endpoints
                            )
                        )

                    consumers_config[chain_id] = ConsumerConfig(
                        network=network,
                        interfaces=list(interfaces),
                        providers=providers,
                    )

        return ComponentsResponse(
            consumers=consumers_config, resource_limits=resource_limits
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error reading configuration: {str(e)}"
        )
