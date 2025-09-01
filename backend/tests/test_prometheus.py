import asyncio
from datetime import datetime

import pytest

from app.services.prometheus import process_result_for_chart, PrometheusService


def test_process_result_for_chart_empty_and_missing():
    assert process_result_for_chart({}) == {"datasets": [], "labels": []}
    assert process_result_for_chart({"status": "error"}) == {
        "datasets": [],
        "labels": [],
    }
    assert process_result_for_chart({"status": "success", "data": {"result": []}}) == {
        "datasets": [],
        "labels": [],
    }


def test_process_result_for_chart_happy_path():
    result = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"namespace": "lava", "pod": "consumer-1"},
                    "values": [[1000, "1"], [1010, "2"], [1020, "3"]],
                },
                {
                    "metric": {"namespace": "lava", "pod": "consumer-2"},
                    "values": [[1000, "2"], [1020, "4"]],
                },
            ]
        },
    }

    processed = process_result_for_chart(result)
    assert processed["labels"] == [
        datetime.fromtimestamp(1000).strftime("%H:%M:%S"),
        datetime.fromtimestamp(1010).strftime("%H:%M:%S"),
        datetime.fromtimestamp(1020).strftime("%H:%M:%S"),
    ]
    assert len(processed["datasets"]) == 2
    # Ensure gaps are filled with None
    assert processed["datasets"][1]["data"] == [2.0, None, 4.0]


@pytest.mark.asyncio
async def test_get_metric_range_parses_iso_and_calls_range(monkeypatch):
    calls = {}

    async def fake_range(self, query_expr, start_time, end_time, step):
        calls["query_expr"] = query_expr
        calls["start"] = start_time
        calls["end"] = end_time
        calls["step"] = step
        return {"ok": True}

    monkeypatch.setattr(PrometheusService, "query_range", fake_range)

    svc = PrometheusService(base_url="http://prom")
    start = "2024-01-01T00:00:00"
    end = "2024-01-01T01:00:00"
    result = await svc.get_metric_range("up", start, end, "5s")

    assert result == {"ok": True}
    assert calls["query_expr"] == "up"
    assert calls["start"].isoformat() == start
    assert calls["end"].isoformat() == end
    assert calls["step"] == "5s"


import types
import httpx
from datetime import datetime, timedelta

import pytest

from app.services.prometheus import PrometheusService


class _FakeResponse:
    def __init__(self, json_data=None, raise_error: Exception | None = None):
        self._json_data = json_data or {}
        self._raise_error = raise_error

    def raise_for_status(self):
        if self._raise_error:
            raise self._raise_error

    def json(self):
        return self._json_data


class _FakeAsyncClient:
    def __init__(
        self, capture: list, json_data=None, raise_error: Exception | None = None
    ):
        self._capture = capture
        self._json_data = json_data or {}
        self._raise_error = raise_error

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url, params=None):
        self._capture.append({"url": url, "params": params})
        return _FakeResponse(self._json_data, self._raise_error)


@pytest.mark.asyncio
async def test_query_success_builds_url_and_params(monkeypatch):
    calls: list[dict] = []

    def fake_client_factory(*args, **kwargs):
        return _FakeAsyncClient(calls, json_data={"status": "ok"})

    monkeypatch.setattr(httpx, "AsyncClient", fake_client_factory)

    svc = PrometheusService(base_url="http://prom")
    data = await svc.query("up")

    assert data == {"status": "ok"}
    assert len(calls) == 1
    assert calls[0]["url"].endswith("/api/v1/query")
    assert calls[0]["params"] == {"query": "up"}


@pytest.mark.asyncio
async def test_query_range_success_with_explicit_times(monkeypatch):
    calls: list[dict] = []

    def fake_client_factory(*args, **kwargs):
        return _FakeAsyncClient(calls, json_data={"status": "ok"})

    monkeypatch.setattr(httpx, "AsyncClient", fake_client_factory)

    svc = PrometheusService(base_url="http://prom")
    start = datetime(2024, 1, 1, 0, 0, 0)
    end = start + timedelta(hours=1)

    data = await svc.query_range("up", start, end, "30s")

    assert data == {"status": "ok"}
    assert len(calls) == 1
    assert calls[0]["url"].endswith("/api/v1/query_range")
    params = calls[0]["params"]
    assert params["query"] == "up"
    assert params["step"] == "30s"
    assert abs(params["start"] - start.timestamp()) < 0.001
    assert abs(params["end"] - end.timestamp()) < 0.001


@pytest.mark.asyncio
async def test_query_error_bubbles(monkeypatch):
    calls: list[dict] = []

    class Boom(Exception):
        pass

    def fake_client_factory(*args, **kwargs):
        return _FakeAsyncClient(calls, json_data=None, raise_error=Boom("boom"))

    monkeypatch.setattr(httpx, "AsyncClient", fake_client_factory)

    svc = PrometheusService(base_url="http://prom")
    with pytest.raises(Boom):
        await svc.query("up")


@pytest.mark.asyncio
async def test_query_range_uses_default_times_when_none(monkeypatch):
    calls: list[dict] = []

    def fake_client_factory(*args, **kwargs):
        return _FakeAsyncClient(calls, json_data={"status": "ok"})

    # Freeze datetime.now() used inside module
    fixed_end = datetime(2024, 1, 1, 1, 0, 0)

    class FixedDatetime:
        @classmethod
        def now(cls):
            return fixed_end

    import app.services.prometheus as prom_mod

    monkeypatch.setattr(prom_mod, "datetime", FixedDatetime)
    monkeypatch.setattr(httpx, "AsyncClient", fake_client_factory)

    svc = PrometheusService(base_url="http://prom")
    data = await svc.query_range("up", None, None, "15s")

    assert data == {"status": "ok"}
    assert len(calls) == 1
    params = calls[0]["params"]
    assert params["step"] == "15s"
    # Start should be one hour before fixed_end
    assert abs(params["end"] - fixed_end.timestamp()) < 0.001
    assert abs(params["start"] - (fixed_end - timedelta(hours=1)).timestamp()) < 0.001


@pytest.mark.asyncio
async def test_get_metric_data_for_chart_delegates(monkeypatch):
    calls = {}

    async def fake_range(self, query_expr, start_time, end_time, step):
        calls["query_expr"] = query_expr
        calls["step"] = step
        # Return result that yields empty chart (still valid)
        return {"status": "success", "data": {"result": []}}

    monkeypatch.setattr(PrometheusService, "query_range", fake_range)

    svc = PrometheusService(base_url="http://prom")
    chart = await svc.get_metric_data_for_chart("up", hours=2, step="10s")

    assert chart == {"datasets": [], "labels": []}
    assert calls["query_expr"] == "up"
    assert calls["step"] == "10s"
