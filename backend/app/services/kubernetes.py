import subprocess


class KubernetesService:
    def __init__(self):
        self._initialize_helm()

    def _initialize_helm(self) -> None:
        """Initialize Helm by adding required repos"""
        try:
            # Add lavanet repo if not already added
            subprocess.run(
                [
                    "helm",
                    "repo",
                    "add",
                    "lavanet",
                    "https://lavanet.github.io/helm-charts",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            # Update all repos
            subprocess.run(
                ["helm", "repo", "update"],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as e:
            # If repo already exists, that's fine
            if "already exists" not in str(e.stderr):
                raise Exception(f"Failed to initialize Helm repos: {str(e)}")

    def apply_helm_release(
        self, name: str, namespace: str, chart: str, version: str, values_file: str
    ) -> None:
        """Apply a Helm chart using Helm CLI"""
        try:
            cmd = [
                "helm",
                "upgrade",
                "--install",
                name,
                chart,
                "--version",
                version,
                "--values",
                values_file,
                "--namespace",
                namespace,
                "--create-namespace",
                "--recreate-pods",
            ]

            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            if result.returncode != 0:
                raise Exception(f"Helm command failed: {result.stderr}")

        except subprocess.CalledProcessError as e:
            raise Exception(f"Failed to apply Helm chart {name}: {str(e)}")
        except Exception as e:
            raise Exception(f"Error applying Helm chart {name}: {str(e)}")

    def label_servicemonitor(
        self,
        name: str,
        namespace: str = "lava-infra",
        labels: dict[str, str] | None = None,
    ) -> None:
        """Label a ServiceMonitor for Prometheus discovery"""
        if labels is None:
            labels = {"release": "kube-prom-stack"}

        try:
            # Convert labels dict to kubectl format
            label_args = []
            for key, value in labels.items():
                label_args.extend([f"{key}={value}"])

            # Build and execute kubectl command
            cmd = [
                "kubectl",
                "label",
                "servicemonitor",
                name,
                "-n",
                namespace,
            ] + label_args
            subprocess.run(cmd, check=True, capture_output=True, text=True)

        except subprocess.CalledProcessError as e:
            raise Exception(f"Failed to label ServiceMonitor {name}: {str(e)}")


# Create a singleton instance
kubernetes_service = KubernetesService()
