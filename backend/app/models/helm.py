from typing import Any, Dict, Optional

from pydantic import BaseModel


class HelmValues(BaseModel):
    """Model for Helm chart values"""

    values: Dict[str, Any]


class HelmRelease(BaseModel):
    """Model for a Helm release"""

    name: str
    namespace: str
    revision: str
    updated: str
    status: str
    chart: str
    app_version: Optional[str] = None


class HelmDeployment(BaseModel):
    """Model for a Helm deployment configuration"""

    namespace: str
    release_name: str
    chart: str
    values_file: str
