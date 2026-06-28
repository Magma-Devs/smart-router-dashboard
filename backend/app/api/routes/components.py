from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import get_current_user
from app.services.configuration import ConfigurationService, configuration_service
from app.core.dataclasses import (
    ComponentsResponse,
    RouterInfo,
    ComponentNode,
    ComponentEndpoint,
    AllResourceLimits,
    ResourceLimits,
)

router = APIRouter()


def get_configuration_service() -> ConfigurationService:
    """Dependency accessor for ConfigurationService."""
    return configuration_service


@router.get("/", response_model=ComponentsResponse)
async def get_configuration(
    current_user: str = Depends(get_current_user),
    config_service: ConfigurationService = Depends(get_configuration_service),
):
    """Get the current configuration for routers and nodes"""
    try:
        routers_config: dict[str, RouterInfo] = {}
        resource_limits = AllResourceLimits(
            server=ResourceLimits(cpu=0, memory=0),
            per_consumer=ResourceLimits(cpu=0, memory=0),
            per_provider=ResourceLimits(cpu=0, memory=0),
        )

        smart_router_data = config_service.read_smart_router_values()

        if smart_router_data and "routers" in smart_router_data:
            for router_entry in smart_router_data["routers"]:
                router_id = router_entry.get("id")
                network = router_entry.get("network")
                if router_id and network:
                    interfaces: set[str] = set()
                    nodes: list[ComponentNode] = []

                    for node in router_entry.get("nodes", []):
                        node_name = node.get("name")
                        node_endpoints: list[ComponentEndpoint] = []

                        for endpoint in node.get("endpoints", []):
                            interface = endpoint.get("interface")
                            if interface:
                                interfaces.add(interface)
                            node_endpoints.append(
                                ComponentEndpoint(
                                    interface=interface,
                                    addons=endpoint.get("addons", []),
                                )
                            )

                        nodes.append(
                            ComponentNode(name=node_name, endpoints=node_endpoints)
                        )

                    routers_config[router_id] = RouterInfo(
                        network=network,
                        interfaces=list(interfaces),
                        nodes=nodes,
                        local_port=router_entry.get("local_port"),
                        local_ports=router_entry.get("local_ports") or {},
                        path_based=bool(router_entry.get("path_based", False)),
                        custom_url_prefix=router_entry.get("custom_url_prefix"),
                    )

        return ComponentsResponse(
            routers=routers_config, resource_limits=resource_limits
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error reading configuration: {str(e)}"
        )
