import httpx

from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
from app.core.config import settings


class PrometheusService:
    def __init__(self, base_url: str = settings.PROMETHEUS_URL):
        self.base_url = base_url
        self.query_url = f"{base_url}/api/v1/query"
        self.range_query_url = f"{base_url}/api/v1/query_range"

    async def query(self, query_expr: str) -> Dict[str, Any]:
        """Execute an instant query against Prometheus"""
        async with httpx.AsyncClient(verify=settings.PROMETHEUS_VERIFY_SSL) as client:
            response = await client.get(self.query_url, params={"query": query_expr})
            response.raise_for_status()
            return response.json()

    async def query_range(
        self,
        query_expr: str,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        step: str = "15s",
    ) -> Dict[str, Any]:
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

        async with httpx.AsyncClient(verify=settings.PROMETHEUS_VERIFY_SSL) as client:
            response = await client.get(self.range_query_url, params=params)
            response.raise_for_status()
            return response.json()

    async def get_metric_data_for_chart(
        self, query_expr: str, hours: int = 1, step: str = "15s"
    ) -> Dict[str, Any]:
        """Get formatted metric data for charts"""
        end_time = datetime.now()
        start_time = end_time - timedelta(hours=hours)

        result = await self.query_range(query_expr, start_time, end_time, step)

        # Process the result for charting
        chart_data = self._process_result_for_chart(result)
        return chart_data

    def _process_result_for_chart(self, result: Dict[str, Any]) -> Dict[str, Any]:
        """Process Prometheus result for chart display"""
        processed_data = {"datasets": [], "labels": []}

        if result["status"] != "success" or "data" not in result:
            return processed_data

        result_data = result["data"]
        if "result" not in result_data or not result_data["result"]:
            return processed_data

        # Get all timestamps for x-axis
        all_timestamps = set()
        for series in result_data["result"]:
            for point in series["values"]:
                all_timestamps.add(point[0])

        # Sort timestamps
        timestamps = sorted(list(all_timestamps))
        processed_data["labels"] = [
            datetime.fromtimestamp(ts).strftime("%H:%M:%S") for ts in timestamps
        ]

        # Process each series
        for series in result_data["result"]:
            # Create a label from metric labels
            metric = series["metric"]
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
            ts_to_value = {point[0]: float(point[1]) for point in series["values"]}

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

    async def get_default_metrics(self) -> List[Dict[str, Any]]:
        """Get data for all default metrics"""
        metrics_data = []

        for metric in settings.DEFAULT_METRICS:
            try:
                data = await self.get_metric_data_for_chart(metric["query"])
                metrics_data.append(
                    {
                        "name": metric["name"],
                        "type": metric["type"],
                        "query": metric["query"],
                        "data": data,
                    }
                )
            except Exception as e:
                metrics_data.append(
                    {
                        "name": metric["name"],
                        "type": metric["type"],
                        "query": metric["query"],
                        "error": str(e),
                        "data": {"datasets": [], "labels": []},
                    }
                )

        return metrics_data


prometheus_service = PrometheusService()
