from fastapi import HTTPException, Depends, status, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import secrets
import base64
from app.core.config import settings
import logging

logger = logging.getLogger(__name__)


class LoginRequest(BaseModel):
    username: str
    password: str


def verify_form_credentials(login_request: LoginRequest):
    """
    Verify the provided username and password from form against hardcoded credentials.
    Returns the username if authentication is successful.
    """
    is_correct_username = secrets.compare_digest(
        login_request.username, settings.AUTH_USERNAME
    )
    is_correct_password = secrets.compare_digest(
        login_request.password, settings.AUTH_PASSWORD
    )
    
    if not (is_correct_username and is_correct_password):
        logger.warning(f"Failed authentication attempt for user: {login_request.username}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )
    
    logger.info(f"Successful authentication for user: {login_request.username}")
    # Create basic auth header for session
    credentials = base64.b64encode(f"{login_request.username}:{login_request.password}".encode()).decode()
    return login_request.username, credentials


def get_current_user(request: Request):
    """
    Dependency to get the current authenticated user from Authorization header.
    This can be used to protect any endpoint.
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Basic "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    
    try:
        # Extract and decode credentials
        credentials = auth_header.split(" ")[1]
        decoded = base64.b64decode(credentials).decode()
        username, password = decoded.split(":", 1)
        
        # Verify credentials
        is_correct_username = secrets.compare_digest(username, settings.AUTH_USERNAME)
        is_correct_password = secrets.compare_digest(password, settings.AUTH_PASSWORD)
        
        if not (is_correct_username and is_correct_password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
            )
        
        return username
    except Exception as e:
        logger.warning(f"Failed to validate authorization header: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization header",
        )


class AuthMiddleware:
    """
    Middleware to add authentication headers to responses.
    """
    
    def __init__(self, app):
        self.app = app
    
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            # Skip auth middleware for OPTIONS requests (CORS preflight)
            method = scope.get("method", "").upper()
            if method == "OPTIONS":
                await self.app(scope, receive, send)
                return
            
            # Add CORS headers for authentication
            async def send_with_auth(message):
                if message["type"] == "http.response.start":
                    headers = dict(message.get("headers", []))
                    # Only add auth headers if not already present from CORS middleware
                    if b"access-control-allow-credentials" not in headers:
                        message["headers"] = list(headers.items()) + [
                            (b"Access-Control-Allow-Credentials", b"true"),
                        ]
                await send(message)
            
            await self.app(scope, receive, send_with_auth)
        else:
            await self.app(scope, receive, send)
