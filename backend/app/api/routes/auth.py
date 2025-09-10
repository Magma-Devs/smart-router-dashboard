"""
Authentication API routes for the dashboard application.

This module provides endpoints for user authentication, session management,
and authentication status checking.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends

from app.core.auth import LoginRequest, get_current_user, verify_form_credentials
from app.core.config import settings

# Configure logger for this module
logger = logging.getLogger(__name__)

# Create router instance for authentication endpoints
router = APIRouter()


@router.post("/login")
async def login(login_request: LoginRequest) -> dict[str, Any]:
    """
    Authenticate user with form-based credentials.

    This endpoint validates the provided username and password against
    the configured authentication credentials. On successful authentication,
    it returns user information and credentials for session management.

    Args:
        login_request: LoginRequest object containing username and password

    Returns:
        Dict containing authentication status, user information, and credentials

    Raises:
        HTTPException: 401 if credentials are invalid
    """
    username, credentials = verify_form_credentials(login_request)
    logger.info(f"Successful login for user: {username}")

    return {
        "message": "Authentication successful",
        "username": username,
        "credentials": credentials,
        "status": "authenticated",
    }


@router.post("/logout")
async def logout(current_user: str = Depends(get_current_user)) -> dict[str, str]:
    """
    Logout the current authenticated user.

    This endpoint handles user logout. Note that this is primarily for
    client-side session management - the client should clear stored
    credentials after receiving this response.

    Args:
        current_user: Current authenticated username (injected by dependency)

    Returns:
        Dict containing logout confirmation and user information
    """
    logger.info(f"User logout: {current_user}")

    return {
        "message": "Logout successful",
        "username": current_user,
        "status": "logged_out",
    }


@router.get("/me")
async def get_current_user_info(
    current_user: str = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Get information about the currently authenticated user.

    This endpoint returns details about the authenticated user session.
    Requires valid authentication credentials.

    Args:
        current_user: Current authenticated username (injected by dependency)

    Returns:
        Dict containing user information and authentication status
    """
    return {"username": current_user, "authenticated": True}


@router.get("/status")
async def auth_status() -> dict[str, Any]:
    """
    Get authentication system status and requirements.

    This is a public endpoint that provides information about the
    authentication system configuration and requirements.

    Returns:
        Dict containing authentication system information
    """
    return {
        "authentication_required": True,
        "auth_type": "Form-based with session",
        "message": "All endpoints require authentication",
    }


@router.get("/debug-status")
async def debug_status() -> dict[str, Any]:
    """
    Get debug mode status for development and troubleshooting.

    This public endpoint returns the current debug mode configuration,
    which is useful for development environments and troubleshooting.

    Returns:
        Dict containing debug mode status and information
    """
    return {"debug_mode": settings.DEBUG, "message": "Debug mode status"}
