from fastapi import APIRouter, HTTPException, Body, Path, Query, UploadFile, File
from typing import Dict, List, Any, Optional
import yaml
from app.services.kubernetes import kubernetes_service, helm_service
from app.models.helm import HelmValues

router = APIRouter()

@router.get("/deployments")
async def list_deployments():
    """List all available deployments"""
    deployments = helm_service.get_all_deployments()
    return {"deployments": deployments}

@router.get("/releases")
async def list_releases(
    namespace: Optional[str] = Query(None, description="Filter by namespace")
):
    """List all Helm releases"""
    releases = helm_service.list_releases(namespace)
    return {"releases": releases}

@router.get("/values/{deployment_id}")
async def get_deployment_values(
    deployment_id: str = Path(..., description="Deployment ID")
):
    """Get the current values for a deployment"""
    deployment_info = helm_service.get_deployment_info(deployment_id)
    
    if not deployment_info:
        raise HTTPException(status_code=404, detail=f"Deployment {deployment_id} not found")
    
    values = helm_service.get_values(
        deployment_info["release_name"], 
        deployment_info["namespace"]
    )
    
    return {
        "deployment_id": deployment_id,
        "deployment_info": deployment_info,
        "values": values
    }

@router.put("/values/{deployment_id}")
async def update_deployment_values(
    deployment_id: str = Path(..., description="Deployment ID"),
    values: Dict[str, Any] = Body(..., description="New values for the deployment")
):
    """Update the values for a deployment and trigger a Helm upgrade"""
    deployment_info = helm_service.get_deployment_info(deployment_id)
    
    if not deployment_info:
        raise HTTPException(status_code=404, detail=f"Deployment {deployment_id} not found")
    
    result = helm_service.update_release(
        deployment_info["release_name"],
        deployment_info["namespace"],
        deployment_info["chart"],
        values
    )
    
    if not result.get("success", False):
        raise HTTPException(
            status_code=500, 
            detail=f"Failed to update deployment: {result.get('error', 'Unknown error')}"
        )
    
    return {
        "message": f"Deployment {deployment_id} updated successfully",
        "deployment_id": deployment_id,
        "result": result
    }

@router.post("/values/{deployment_id}/upload")
async def upload_values_file(
    deployment_id: str = Path(..., description="Deployment ID"),
    values_file: UploadFile = File(..., description="YAML values file")
):
    """Upload a values file for a deployment and trigger a Helm upgrade"""
    deployment_info = helm_service.get_deployment_info(deployment_id)
    
    if not deployment_info:
        raise HTTPException(status_code=404, detail=f"Deployment {deployment_id} not found")
    
    # Read and parse the uploaded YAML file
    try:
        contents = await values_file.read()
        values = yaml.safe_load(contents)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML file: {str(e)}")
    
    # Update the deployment
    result = helm_service.update_release(
        deployment_info["release_name"],
        deployment_info["namespace"],
        deployment_info["chart"],
        values
    )
    
    if not result.get("success", False):
        raise HTTPException(
            status_code=500, 
            detail=f"Failed to update deployment: {result.get('error', 'Unknown error')}"
        )
    
    return {
        "message": f"Deployment {deployment_id} updated successfully with uploaded values",
        "deployment_id": deployment_id,
        "filename": values_file.filename,
        "result": result
    }

@router.get("/kubernetes/namespaces")
async def list_namespaces():
    """List all Kubernetes namespaces"""
    namespaces = kubernetes_service.get_namespaces()
    return {"namespaces": namespaces}

@router.get("/kubernetes/pods")
async def list_pods(
    namespace: Optional[str] = Query(None, description="Filter by namespace")
):
    """List all Kubernetes pods"""
    pods = kubernetes_service.get_pods(namespace)
    return {"pods": pods}

@router.get("/kubernetes/services")
async def list_services(
    namespace: Optional[str] = Query(None, description="Filter by namespace")
):
    """List all Kubernetes services"""
    services = kubernetes_service.get_services(namespace)
    return {"services": services} 