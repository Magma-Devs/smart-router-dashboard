import asyncio
import json
import statistics
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.auth import get_current_user
from app.core.config import settings


router = APIRouter()


class LiveTestRequest(BaseModel):
    """Request model for live test endpoint."""

    chain_id: str = Field(..., description="Chain ID to test")
    interface: str = Field(
        ..., description="Interface type (jsonrpc, rest, tendermintrpc, grpc)"
    )
    interface_command: str = Field(
        ..., description="Interface command/path for the request"
    )
    number_of_requests: int = Field(
        default=1, ge=1, le=200, description="Number of requests to send (1-200)"
    )
    skip_cache: bool = Field(
        default=False,
        description="Skip cache by adding lava-force-cache-refresh header",
    )


class CrossValidationRequest(BaseModel):
    """Request model for cross validation endpoint."""

    chain_id: str = Field(..., description="Chain ID to test")
    interface: str = Field(
        ..., description="Interface type (jsonrpc, rest, tendermintrpc, grpc)"
    )
    interface_command: str = Field(
        ..., description="Interface command/path for the request"
    )
    quorum_min: int = Field(..., ge=1, le=100, description="Minimum quorum (1-100)")
    quorum_max: int = Field(..., ge=1, le=100, description="Maximum quorum (1-100)")
    quorum_rate: float = Field(..., ge=0.0, le=1.0, description="Quorum rate (0.0-1.0)")
    skip_cache: bool = Field(
        default=False,
        description="Skip cache by adding lava-force-cache-refresh header",
    )


class CrossValidationResponse(BaseModel):
    """Response model for cross validation results."""

    status_code: int = Field(..., description="HTTP status code")
    latency_ms: float = Field(..., description="Response latency in milliseconds")
    success: bool = Field(..., description="Whether the request was successful")
    response_data: Any = Field(..., description="Response data")
    headers: Dict[str, str] = Field(
        default_factory=dict, description="Response headers"
    )
    error: Optional[str] = Field(None, description="Error message if request failed")


class LiveTestResponse(BaseModel):
    """Response model for live test results."""

    success_rate: float = Field(..., description="Success rate percentage (0-100)")
    total_requests: int = Field(..., description="Total number of requests sent")
    successful_requests: int = Field(
        ..., description="Number of successful requests (2xx status)"
    )
    failed_requests: int = Field(..., description="Number of failed requests")
    latency_stats: Dict[str, float] = Field(
        ..., description="Latency statistics (min, max, avg, p50, p90)"
    )
    cached_count: int = Field(..., description="Number of responses served from cache")
    non_cached_count: int = Field(
        ..., description="Number of responses not served from cache"
    )
    responses: List[Dict[str, Any]] = Field(
        default_factory=list, description="Sample responses"
    )


async def make_test_request(
    chain_id: str,
    interface: str,
    interface_command: str,
    domain: str,
    port: str,
    skip_cache: bool = False,
) -> Dict[str, Any]:
    """Make a single test request and return timing and response data."""
    start_time = time.time()

    try:
        curl_host = f"{chain_id}-{interface}.{domain}"
        url = f"https://{curl_host}:{port}"

        if interface == "rest":
            # For REST, append the path from interface_command
            import json

            path = json.loads(interface_command).get("path", "")
            url = f"{url}{path}"
            method = "GET"
            body = None
        else:
            # For other interfaces, use POST with interface_command as body
            method = "POST"
            body = interface_command

        # Prepare headers
        headers = {
            "Content-Type": "application/json",
        }

        # Add cache refresh header if skip_cache is enabled
        if skip_cache:
            headers["lava-force-cache-refresh"] = "true"

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.request(
                method=method,
                url=url,
                headers=headers,
                content=body,
            )

            # Extract timing information from httpx response
            latency_ms = response.elapsed.total_seconds() * 1000

            try:
                response_data = (
                    response.json()
                    if response.headers.get("content-type", "").startswith(
                        "application/json"
                    )
                    else response.text
                )
            except Exception:
                response_data = response.text

            return {
                "status_code": response.status_code,
                "latency_ms": latency_ms,
                "success": 200 <= response.status_code < 300,
                "response_data": response_data,
                "headers": dict(response.headers),
            }

    except Exception as e:
        end_time = time.time()
        latency_ms = (end_time - start_time) * 1000

        return {
            "status_code": 0,
            "latency_ms": latency_ms,
            "success": False,
            "error": str(e),
            "response_data": None,
            "headers": {},
        }


@router.post("/")
async def run_live_test(
    request: LiveTestRequest,
    current_user: str = Depends(get_current_user),
):
    """Run live test with specified number of requests."""
    try:
        domain = getattr(settings, "domain", "lava.lavapro.xyz")
        port = getattr(settings, "port", "8443")

        # Validate interface command for REST
        if request.interface == "rest":
            try:
                import json

                json.loads(request.interface_command)
            except json.JSONDecodeError:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid interface_command for REST interface. Must be valid JSON with 'path' field.",
                )

        # Run parallel requests
        tasks = []
        for i in range(request.number_of_requests):
            task = make_test_request(
                request.chain_id,
                request.interface,
                request.interface_command,
                domain,
                port,
                request.skip_cache,
            )
            tasks.append(task)

        # Execute all requests in parallel
        responses = await asyncio.gather(*tasks)

        # Process results
        latencies = []
        successful_count = 0

        for response_data in responses:
            latencies.append(response_data["latency_ms"])
            if response_data["success"]:
                successful_count += 1

        # Calculate statistics
        success_rate = (successful_count / request.number_of_requests) * 100

        latency_stats = {
            "min": min(latencies) if latencies else 0,
            "max": max(latencies) if latencies else 0,
            "avg": statistics.mean(latencies) if latencies else 0,
            "p50": (
                statistics.quantiles(latencies, n=2)[0]
                if len(latencies) >= 2
                else statistics.mean(latencies) if latencies else 0
            ),
            "p90": (
                statistics.quantiles(latencies, n=10)[8]
                if len(latencies) >= 10
                else statistics.mean(latencies) if latencies else 0
            ),
            "p95": (
                statistics.quantiles(latencies, n=20)[18]
                if len(latencies) >= 20
                else statistics.mean(latencies) if latencies else 0
            ),
        }

        # Compute cached vs non-cached across ALL responses (case-insensitive)
        cached_count = 0
        non_cached_count = 0
        for r in responses:
            headers: Dict[str, Any] = r.get("headers", {}) or {}
            key = next(
                (k for k in headers.keys() if k.lower() == "lava-provider-address"),
                None,
            )
            value = headers.get(key) if key else None
            if value is not None and str(value).lower() == "cached":
                cached_count += 1
            else:
                non_cached_count += 1

        return LiveTestResponse(
            success_rate=success_rate,
            total_requests=request.number_of_requests,
            successful_requests=successful_count,
            failed_requests=request.number_of_requests - successful_count,
            latency_stats=latency_stats,
            cached_count=cached_count,
            non_cached_count=non_cached_count,
            responses=responses,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cross-validation/", response_model=CrossValidationResponse)
async def cross_validation_endpoint(
    request: CrossValidationRequest, current_user: dict = Depends(get_current_user)
):
    """Cross validation endpoint that sends a single request with quorum headers."""

    # Validate quorum parameters
    if request.quorum_min > request.quorum_max:
        raise HTTPException(
            status_code=400, detail="quorum_min cannot be greater than quorum_max"
        )

    try:
        # Construct the target URL
        domain = getattr(settings, "domain", "lava.lavapro.xyz")
        port = getattr(settings, "port", "8443")
        curl_host = f"{request.chain_id}-{request.interface}.{domain}"

        # Determine HTTP method and URL based on interface
        if request.interface == "rest":
            try:
                rest_config = json.loads(request.interface_command)
                path = rest_config.get("path", "")
                http_method = rest_config.get("method", "GET").upper()
            except json.JSONDecodeError:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid interface_command for REST interface. Expected JSON with 'path' and 'method' fields.",
                )
        else:
            http_method = "POST"
            path = ""

        full_url = f"https://{curl_host}:{port}{path}"

        # Prepare headers with quorum parameters
        headers = {
            "Content-Type": "application/json",
            "lava-quorum-rate": str(request.quorum_rate),
            "lava-quorum-max": str(request.quorum_max),
            "lava-quorum-min": str(request.quorum_min),
        }

        # Add cache refresh header if skip_cache is enabled
        if request.skip_cache:
            headers["lava-force-cache-refresh"] = "true"

        # Prepare request body
        json_body = None
        body_content = None

        if request.interface == "rest":
            json_body = None  # REST requests typically don't have JSON body
        else:
            body_content = request.interface_command

        # Make the request
        start_time = time.time()

        try:
            async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
                try:
                    response = await client.request(
                        method=http_method,
                        url=full_url,
                        headers=headers,
                        json=json_body,
                        content=body_content,
                    )
                    end_time = time.time()
                    latency_ms = (end_time - start_time) * 1000

                    try:
                        # Attempt to parse as JSON if content-type is application/json
                        if response.headers.get("content-type", "").startswith(
                            "application/json"
                        ):
                            response_data = await response.json()
                        else:
                            response_data = response.text
                    except Exception:
                        response_data = response.text

                    return CrossValidationResponse(
                        status_code=response.status_code,
                        latency_ms=latency_ms,
                        success=200 <= response.status_code < 300,
                        response_data=response_data,
                        headers=dict(response.headers),
                    )
                except Exception as e:
                    end_time = time.time()
                    latency_ms = (end_time - start_time) * 1000
                    return CrossValidationResponse(
                        status_code=500,
                        latency_ms=latency_ms,
                        success=False,
                        response_data=None,
                        error=str(e),
                        headers={},
                    )

        except Exception as e:
            end_time = time.time()
            latency_ms = (end_time - start_time) * 1000
            return CrossValidationResponse(
                status_code=500,
                latency_ms=latency_ms,
                success=False,
                response_data=None,
                error=str(e),
                headers={},
            )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
