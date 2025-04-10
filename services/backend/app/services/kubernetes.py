import os
import yaml
import tempfile
import subprocess
from typing import Dict, List, Any, Optional
from kubernetes import client, config
from app.core.config import settings

class KubernetesService:
    def __init__(self):
        # Try to load config from various sources
        try:
            if settings.KUBECONFIG_PATH:
                config.load_kube_config(settings.KUBECONFIG_PATH)
            else:
                # Try loading from default locations
                try:
                    config.load_kube_config()
                except:
                    # If running inside a pod, use service account
                    config.load_incluster_config()
            
            self.api_client = client.ApiClient()
            self.core_v1 = client.CoreV1Api(self.api_client)
            self.apps_v1 = client.AppsV1Api(self.api_client)
            self.custom_objects = client.CustomObjectsApi(self.api_client)
        except Exception as e:
            print(f"Warning: Could not initialize Kubernetes client: {e}")
            self.api_client = None
            self.core_v1 = None
            self.apps_v1 = None
            self.custom_objects = None
    
    def get_namespaces(self) -> List[str]:
        """Get all namespaces in the cluster"""
        if not self.core_v1:
            return []
            
        namespaces = self.core_v1.list_namespace()
        return [ns.metadata.name for ns in namespaces.items]
    
    def get_pods(self, namespace: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get all pods in the specified namespace or all namespaces"""
        if not self.core_v1:
            return []
            
        if namespace:
            pods = self.core_v1.list_namespaced_pod(namespace)
        else:
            pods = self.core_v1.list_pod_for_all_namespaces()
            
        return [{
            "name": pod.metadata.name,
            "namespace": pod.metadata.namespace,
            "status": pod.status.phase,
            "ip": pod.status.pod_ip,
            "node": pod.spec.node_name,
            "created": pod.metadata.creation_timestamp.isoformat() if pod.metadata.creation_timestamp else None
        } for pod in pods.items]
    
    def get_services(self, namespace: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get all services in the specified namespace or all namespaces"""
        if not self.core_v1:
            return []
            
        if namespace:
            services = self.core_v1.list_namespaced_service(namespace)
        else:
            services = self.core_v1.list_service_for_all_namespaces()
            
        return [{
            "name": svc.metadata.name,
            "namespace": svc.metadata.namespace,
            "type": svc.spec.type,
            "cluster_ip": svc.spec.cluster_ip,
            "ports": [{"port": port.port, "target_port": port.target_port, "protocol": port.protocol} 
                     for port in svc.spec.ports] if svc.spec.ports else []
        } for svc in services.items]

class HelmService:
    def __init__(self):
        # Ensure helm is installed and available
        try:
            subprocess.run(["helm", "version"], check=True, capture_output=True)
            self.helm_available = True
        except (subprocess.SubprocessError, FileNotFoundError):
            print("Warning: Helm is not available")
            self.helm_available = False
    
    def list_releases(self, namespace: Optional[str] = None) -> List[Dict[str, Any]]:
        """List all Helm releases in the specified namespace or all namespaces"""
        if not self.helm_available:
            return []
            
        cmd = ["helm", "list", "--output", "json"]
        if namespace:
            cmd.extend(["--namespace", namespace])
        else:
            cmd.append("--all-namespaces")
            
        try:
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            releases = yaml.safe_load(result.stdout)
            return releases
        except subprocess.SubprocessError as e:
            print(f"Error listing Helm releases: {e}")
            return []
    
    def get_values(self, release_name: str, namespace: str) -> Dict[str, Any]:
        """Get the values for a Helm release"""
        if not self.helm_available:
            return {}
            
        cmd = ["helm", "get", "values", release_name, "--namespace", namespace, "--output", "json"]
        
        try:
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            values = yaml.safe_load(result.stdout)
            return values
        except subprocess.SubprocessError as e:
            print(f"Error getting Helm values: {e}")
            return {}
    
    def update_release(
        self, 
        release_name: str, 
        namespace: str, 
        chart: str, 
        values: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Update a Helm release with new values"""
        if not self.helm_available:
            return {"success": False, "error": "Helm is not available"}
            
        # Write values to a temporary file
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as temp:
            yaml.dump(values, temp)
            values_file = temp.name
        
        try:
            cmd = [
                "helm", "upgrade", release_name, chart,
                "--namespace", namespace,
                "--values", values_file,
                "--output", "json"
            ]
            
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            upgrade_result = yaml.safe_load(result.stdout)
            
            return {
                "success": True,
                "release": release_name,
                "namespace": namespace,
                "result": upgrade_result
            }
        except subprocess.SubprocessError as e:
            return {
                "success": False,
                "release": release_name,
                "namespace": namespace,
                "error": str(e),
                "stderr": e.stderr if hasattr(e, 'stderr') else None
            }
        finally:
            # Clean up the temporary file
            if os.path.exists(values_file):
                os.unlink(values_file)
    
    def get_deployment_info(self, deployment_id: str) -> Dict[str, Any]:
        """Get information about a deployment from settings"""
        if deployment_id not in settings.HELM_DEPLOYMENTS:
            return {}
        
        return settings.HELM_DEPLOYMENTS[deployment_id]
    
    def get_all_deployments(self) -> Dict[str, Dict[str, Any]]:
        """Get all available deployments from settings"""
        return settings.HELM_DEPLOYMENTS

kubernetes_service = KubernetesService()
helm_service = HelmService() 