"""
API Keys proxy routes.

Proxies requests to the auth-gateway service for API key management.
Returns 501 if AUTH_GATEWAY_URL is not configured.
"""

import httpx
from fastapi import APIRouter, Depends, Request, Response

from app.core.auth import get_current_user
from app.core.config import settings

router = APIRouter()

PROXY_TIMEOUT = 15.0


def _gateway_enabled() -> bool:
    return bool(settings.auth_gateway_url)


def _gateway_headers() -> dict[str, str]:
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if settings.auth_gateway_admin_token:
        headers["X-Admin-Token"] = settings.auth_gateway_admin_token
    return headers


async def _proxy(
    method: str,
    path: str,
    body: bytes | None = None,
) -> Response:
    """Forward a request to the auth-gateway and return its response."""
    url = f"{settings.auth_gateway_url}/api/v1/keys{path}"
    async with httpx.AsyncClient(timeout=PROXY_TIMEOUT) as client:
        resp = await client.request(
            method,
            url,
            headers=_gateway_headers(),
            content=body,
        )
    # Return 204 as-is (no body), otherwise forward JSON body
    if resp.status_code == 204:
        return Response(status_code=204)
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type="application/json",
    )


@router.get("")
async def list_keys(
    current_user: str = Depends(get_current_user),
):
    if not _gateway_enabled():
        return Response(
            content='{"detail":"API key management is not enabled. Configure AUTH_GATEWAY_URL."}',
            status_code=501,
            media_type="application/json",
        )
    return await _proxy("GET", "")


@router.post("")
async def create_key(
    request: Request,
    current_user: str = Depends(get_current_user),
):
    if not _gateway_enabled():
        return Response(
            content='{"detail":"API key management is not enabled. Configure AUTH_GATEWAY_URL."}',
            status_code=501,
            media_type="application/json",
        )
    body = await request.body()
    return await _proxy("POST", "", body)


@router.get("/{key_id}")
async def get_key(
    key_id: str,
    current_user: str = Depends(get_current_user),
):
    if not _gateway_enabled():
        return Response(
            content='{"detail":"API key management is not enabled. Configure AUTH_GATEWAY_URL."}',
            status_code=501,
            media_type="application/json",
        )
    return await _proxy("GET", f"/{key_id}")


@router.patch("/{key_id}")
async def update_key(
    key_id: str,
    request: Request,
    current_user: str = Depends(get_current_user),
):
    if not _gateway_enabled():
        return Response(
            content='{"detail":"API key management is not enabled. Configure AUTH_GATEWAY_URL."}',
            status_code=501,
            media_type="application/json",
        )
    body = await request.body()
    return await _proxy("PATCH", f"/{key_id}", body)


@router.delete("/{key_id}")
async def delete_key(
    key_id: str,
    current_user: str = Depends(get_current_user),
):
    if not _gateway_enabled():
        return Response(
            content='{"detail":"API key management is not enabled. Configure AUTH_GATEWAY_URL."}',
            status_code=501,
            media_type="application/json",
        )
    return await _proxy("DELETE", f"/{key_id}")
