import logging

from fastapi import HTTPException, Request, status
from pydantic import BaseModel

from app.core.config import settings
from app.core import auth_utils

logger = logging.getLogger(__name__)


class LoginRequest(BaseModel):
    username: str
    password: str


def verify_form_credentials(login_request: LoginRequest):
    """
    Verify the provided username and password from form against configured credentials.
    Returns the username and session credential token (base64 value only) if successful.
    """
    if not auth_utils.verify_credentials(
        login_request.username,
        login_request.password,
        settings.AUTH_USERNAME,
        settings.AUTH_PASSWORD,
    ):
        logger.warning(
            f"Failed authentication attempt for user: {login_request.username}"
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )

    logger.info(f"Successful authentication for user: {login_request.username}")
    # Create basic auth header for session, but return only the token part (without prefix)
    basic_header = auth_utils.build_basic_credentials(
        login_request.username, login_request.password
    )
    credentials = basic_header[len(auth_utils.BASIC_PREFIX) :]
    return login_request.username, credentials


def get_current_user(request: Request):
    """
    Dependency to get the current authenticated user from Authorization header.
    This can be used to protect any endpoint.
    """
    auth_header = request.headers.get("Authorization")

    try:
        username, password = auth_utils.parse_basic_credentials(auth_header)

        if not auth_utils.verify_credentials(
            username, password, settings.AUTH_USERNAME, settings.AUTH_PASSWORD
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
            )

        return username
    except HTTPException:
        # re-raise HTTP exceptions unchanged
        raise
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
