from datetime import datetime, timedelta
from typing import Any

import httpx

from app.core.config import settings


def _get_effective_prometheus_url() -> str:
    """Get the effective Prometheus URL, considering runtime overrides."""
    # Import here to avoid circular imports
    from app.api.routes.settings import get_effective_prometheus_url

    return get_effective_prometheus_url()


class PrometheusService:
    def __init__(self, base_url: str | None = None):
        # If base_url is provided, use it; otherwise use dynamic lookup
        self._fixed_url = base_url

    @property
    def base_url(self) -> str:
        """Get the current base URL, supporting runtime overrides."""
        if self._fixed_url:
            return self._fixed_url
        return _get_effective_prometheus_url()

    @property
    def query_url(self) -> str:
        return f"{self.base_url}/api/v1/query"

    @property
    def range_query_url(self) -> str:
        return f"{self.base_url}/api/v1/query_range"

    async def query(self, query_expr: str) -> dict[str, Any]:
        """Execute an instant query against Prometheus"""
        async with httpx.AsyncClient(
            verify=settings.PROMETHEUS_VERIFY_SSL,
            timeout=settings.PROMETHEUS_TIMEOUT,
        ) as client:
            response = await client.get(self.query_url, params={"query": query_expr})
            response.raise_for_status()
            return response.json()

    async def query_range(
        self,
        query_expr: str,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
        step: str = "15s",
    ) -> dict[str, Any]:
        """Execute a range query against Prometheus"""
        if not start_time:
            start_time = datetime.now() - timedelta(hours=1)
        if not end_time:
            end_time = datetime.now()

        params = {
            "query": query_expr,
            "start": start_time.timestamp(),
            "end": end_time.timestamp(),
            "step": step,
        }

        async with httpx.AsyncClient(
            verify=settings.PROMETHEUS_VERIFY_SSL,
            timeout=settings.PROMETHEUS_TIMEOUT,
        ) as client:
            response = await client.get(self.range_query_url, params=params)
            response.raise_for_status()
            return response.json()

    async def get_metric_range(
        self, query: str, start: str, end: str, step: str
    ) -> dict[str, Any]:
        """Compatibility wrapper matching route usage (ISO timestamps -> range query)."""
        start_dt = datetime.fromisoformat(start)
        end_dt = datetime.fromisoformat(end)
        return await self.query_range(query, start_dt, end_dt, step)

    async def get_metric_data_for_chart(
        self, query_expr: str, hours: int = 1, step: str = "15s"
    ) -> dict[str, Any]:
        """Get formatted metric data for charts"""
        end_time = datetime.now()
        start_time = end_time - timedelta(hours=hours)

        result = await self.query_range(query_expr, start_time, end_time, step)

        # Process the result for charting
        chart_data = process_result_for_chart(result)
        return chart_data


def process_result_for_chart(result: dict[str, Any]) -> dict[str, Any]:
    """Process Prometheus result for chart display (pure function)."""
    processed_data = {"datasets": [], "labels": []}

    if result.get("status") != "success" or "data" not in result:
        return processed_data

    result_data = result["data"]
    if "result" not in result_data or not result_data["result"]:
        return processed_data

    # Get all timestamps for x-axis
    all_timestamps = set()
    for series in result_data["result"]:
        for point in series.get("values", []):
            all_timestamps.add(point[0])

    # Sort timestamps
    timestamps = sorted(list(all_timestamps))
    processed_data["labels"] = [
        datetime.fromtimestamp(ts).strftime("%H:%M:%S") for ts in timestamps
    ]

    # Process each series
    for series in result_data["result"]:
        # Create a label from metric labels
        metric = series.get("metric", {})
        label = ""

        if "namespace" in metric and "pod" in metric:
            label = f"{metric['namespace']}/{metric['pod']}"
        elif "namespace" in metric:
            label = metric["namespace"]
        elif "pod" in metric:
            label = metric["pod"]
        elif "name" in metric:
            label = metric["name"]
        elif "job" in metric:
            label = metric["job"]
        else:
            # Use all available labels
            label_parts = []
            for k, v in metric.items():
                if k != "__name__":
                    label_parts.append(f"{k}={v}")
            label = ", ".join(label_parts)

        # Create a map of timestamp to value for this series
        ts_to_value = {point[0]: float(point[1]) for point in series.get("values", [])}

        # Create the data array with values for each timestamp
        data = []
        for ts in timestamps:
            if ts in ts_to_value:
                data.append(ts_to_value[ts])
            else:
                data.append(None)  # Use null for missing values

        # Add the dataset
        processed_data["datasets"].append(
            {"label": label, "data": data, "fill": False, "borderWidth": 2}
        )

    return processed_data


prometheus_service = PrometheusService()
