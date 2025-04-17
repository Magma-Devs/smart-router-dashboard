from fastapi import APIRouter, HTTPException, Query
from typing import List, Dict, Any, Optional
from datetime import datetime, timedelta
from app.services.prometheus import prometheus_service

router = APIRouter()


@router.get("/")
async def get_default_metrics():
    """Get data for all default metrics"""
    try:
        metrics = await prometheus_service.get_default_metrics()
        return {"metrics": metrics}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error fetching metrics: {str(e)}")


@router.get("/query")
async def query_metrics(
    query: str,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    step: str = "15s"
):
    """Query Prometheus metrics"""
    try:
        if not start:
            start = datetime.now() - timedelta(hours=1)
        if not end:
            end = datetime.now()

        result = prometheus_service.get_metric_range(
            query=query,
            start=start.isoformat(),
            end=end.isoformat(),
            step=step
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/instant")
async def instant_query(
    query: str = Query(..., description="Prometheus query expression")
):
    """Execute an instant Prometheus query"""
    try:
        result = await prometheus_service.query(query)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error executing query: {str(e)}")


@router.get("/range")
async def range_query(
    query: str = Query(..., description="Prometheus query expression"),
    start: Optional[str] = Query(None, description="Start time (ISO format)"),
    end: Optional[str] = Query(None, description="End time (ISO format)"),
    step: str = Query("5s", description="Step size for range queries"),
):
    """Execute a range Prometheus query with custom time range"""
    try:
        start_time = (
            datetime.fromisoformat(start)
            if start
            else datetime.now() - timedelta(hours=1)
        )
        end_time = datetime.fromisoformat(end) if end else datetime.now()

        result = await prometheus_service.query_range(query, start_time, end_time, step)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error executing query: {str(e)}")


@router.get("/last_minutes")
async def last_n_minutes(
    query: str = Query(..., description="Prometheus query expression"),
    minutes: int = Query(15, description="Number of minutes of data to fetch"),
    step: str = Query("5s", description="Step size for range queries"),
):
    """Execute a range Prometheus query for the last n minutes"""
    try:
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=minutes)

        result = await prometheus_service.query_range(query, start_time, end_time, step)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error executing query: {str(e)}")


@router.get("/default")
async def get_default_metrics():
    """Get default metrics data"""
    try:
        return await prometheus_service.get_default_metrics()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
