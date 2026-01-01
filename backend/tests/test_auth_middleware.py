"""
Tests for authentication middleware.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.auth import AuthMiddleware


class TestAuthMiddleware:
    """Test authentication middleware functionality."""

    def test_init(self):
        """Test AuthMiddleware initialization."""
        app = MagicMock()
        middleware = AuthMiddleware(app)
        assert middleware.app == app

    @pytest.mark.asyncio
    async def test_options_request_bypass(self):
        """Test that OPTIONS requests bypass authentication."""
        app = AsyncMock()
        middleware = AuthMiddleware(app)

        scope = {"type": "http", "method": "OPTIONS", "path": "/api/test"}
        receive = AsyncMock()
        send = AsyncMock()

        await middleware(scope, receive, send)

        # Should call the app directly without authentication
        app.assert_called_once_with(scope, receive, send)

    @pytest.mark.asyncio
    async def test_cors_headers_added(self):
        """Test that CORS headers are added to responses."""
        app = AsyncMock()
        middleware = AuthMiddleware(app)

        scope = {"type": "http", "method": "GET", "path": "/api/test"}
        receive = AsyncMock()
        send = AsyncMock()

        # Mock the app to call send with a response
        async def mock_app(scope, receive, send_func):
            await send_func(
                {"type": "http.response.start", "status": 200, "headers": []}
            )

        app.side_effect = mock_app

        await middleware(scope, receive, send)

        # Check that send was called with CORS headers
        send.assert_called()
        call_args = send.call_args_list

        # Find the response.start message
        response_start = None
        for call in call_args:
            message = call[0][0]
            if message["type"] == "http.response.start":
                response_start = message
                break

        assert response_start is not None
        headers_dict = dict(response_start["headers"])

        # Check for CORS headers
        assert b"Access-Control-Allow-Credentials" in headers_dict
        assert headers_dict[b"Access-Control-Allow-Credentials"] == b"true"
