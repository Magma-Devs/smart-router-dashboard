"""
Pure functions for metrics upload functionality.
"""

import json
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Dict, Protocol


class S3Client(Protocol):
    """Protocol for S3 client interface."""

    def put_object(
        self, Bucket: str, Key: str, Body: str, ContentType: str
    ) -> Dict[str, Any]:
        """Put object to S3 bucket."""
        ...


class HTTPSession(Protocol):
    """Protocol for HTTP session interface."""

    def get(self, url: str) -> Any:
        """Make HTTP GET request."""
        ...


def build_metrics_url(base_url: str, query: str, minutes: int, step: str = "1s") -> str:
    """
    Build metrics API URL with encoded query parameters.

    Args:
        base_url: Base API URL (e.g., "http://localhost:8000")
        query: Prometheus query string
        minutes: Number of minutes of data to fetch
        step: Step size for range queries

    Returns:
        Complete URL with encoded parameters
    """
    encoded_query = urllib.parse.quote_plus(query)
    return f"{base_url}/api/metrics/last_minutes?query={encoded_query}&minutes={minutes}&step={step}"


def generate_s3_key(tenant_id: str, timestamp: datetime) -> str:
    """
    Generate S3 key for metrics data.

    Args:
        tenant_id: Tenant identifier
        timestamp: Timestamp for the data

    Returns:
        S3 key path
    """
    formatted_time = timestamp.strftime("%Y-%m-%dT%H-%M-%SZ")
    return f"metrics/{tenant_id}/relays_served_{formatted_time}.json"


def upload_metrics_to_s3(
    s3_client: S3Client,
    http_session: HTTPSession,
    url: str,
    bucket: str,
    tenant_id: str,
    timestamp: datetime = None,
) -> str:
    """
    Upload metrics data to S3 bucket.

    Args:
        s3_client: S3 client instance
        http_session: HTTP session for making requests
        url: Metrics API URL
        bucket: S3 bucket name
        tenant_id: Tenant identifier
        timestamp: Optional timestamp (defaults to now)

    Returns:
        S3 key where data was uploaded

    Raises:
        Exception: If HTTP request or S3 upload fails
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc).replace(tzinfo=None)

    # Fetch metrics data
    response = http_session.get(url)
    response.raise_for_status()
    data = response.json()

    # Generate S3 key and upload
    key = generate_s3_key(tenant_id, timestamp)
    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data),
        ContentType="application/json",
    )

    return key
