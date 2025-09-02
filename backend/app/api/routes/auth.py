from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from app.core.auth import get_current_user, verify_form_credentials, LoginRequest
from app.core.config import settings
import logging

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/login")
async def login(login_request: LoginRequest):
    """
    Login endpoint that validates credentials from form.
    Returns success message and credentials if authentication is successful.
    """
    username, credentials = verify_form_credentials(login_request)
    return {
        "message": "Authentication successful",
        "username": username,
        "credentials": credentials,
        "status": "authenticated"
    }


@router.post("/logout")
async def logout(current_user: str = Depends(get_current_user)):
    """
    Logout endpoint (client-side should clear stored credentials).
    """
    return {
        "message": "Logout successful",
        "username": current_user,
        "status": "logged_out"
    }


@router.get("/me")
async def get_current_user_info(current_user: str = Depends(get_current_user)):
    """
    Get current user information.
    """
    return {
        "username": current_user,
        "authenticated": True
    }


@router.get("/status")
async def auth_status():
    """
    Get authentication status (public endpoint).
    """
    return {
        "authentication_required": True,
        "auth_type": "Form-based with session",
        "message": "All endpoints require authentication"
    }


@router.get("/debug-status")
async def debug_status():
    """
    Get debug mode status (public endpoint).
    """
    return {
        "debug_mode": settings.DEBUG,
        "message": "Debug mode status"
    }
