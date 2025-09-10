"""
Tests for logging configuration.
"""

import logging
from unittest.mock import patch

from app.core.logging_config import setup_logging, DEFAULT_LOG_LEVEL


class TestLoggingConfig:
    """Test logging configuration functions."""

    def test_setup_logging_with_none_level(self):
        """Test setup_logging uses DEFAULT_LOG_LEVEL when level is None."""
        with patch("logging.basicConfig") as mock_basic_config:
            setup_logging(level=None)

            # Should call basicConfig with DEFAULT_LOG_LEVEL
            mock_basic_config.assert_called_once()
            call_args = mock_basic_config.call_args
            assert call_args[1]["level"] == getattr(logging, DEFAULT_LOG_LEVEL)

    def test_setup_logging_with_debug_mode(self):
        """Test setup_logging overrides level with DEBUG when debug_mode=True."""
        with patch("logging.basicConfig") as mock_basic_config:
            setup_logging(level="INFO", debug_mode=True)

            # Should call basicConfig with DEBUG level regardless of input level
            mock_basic_config.assert_called_once()
            call_args = mock_basic_config.call_args
            assert call_args[1]["level"] == logging.DEBUG

    def test_setup_logging_with_specific_level(self):
        """Test setup_logging uses provided level when not in debug mode."""
        with patch("logging.basicConfig") as mock_basic_config:
            setup_logging(level="WARNING", debug_mode=False)

            # Should call basicConfig with provided level
            mock_basic_config.assert_called_once()
            call_args = mock_basic_config.call_args
            assert call_args[1]["level"] == logging.WARNING

    def test_setup_logging_with_custom_format(self):
        """Test setup_logging uses custom format string."""
        custom_format = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        with patch("logging.basicConfig") as mock_basic_config:
            setup_logging(format_string=custom_format)

            # Should call basicConfig with custom format
            mock_basic_config.assert_called_once()
            call_args = mock_basic_config.call_args
            assert call_args[1]["format"] == custom_format
