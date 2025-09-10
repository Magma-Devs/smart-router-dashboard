"""
Logging configuration for the Smart Router Dashboard API.
"""

import logging

from .constants import DEFAULT_LOG_LEVEL, DEFAULT_LOG_FORMAT


def setup_logging(
    level: str | None = None,
    format_string: str | None = None,
    debug_mode: bool = False,
) -> None:
    """
    Set up logging configuration for the application.

    Args:
        level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        format_string: Custom log format string
        debug_mode: Whether debug mode is enabled
    """
    # Determine logging level
    if level is None:
        level = DEFAULT_LOG_LEVEL

    # Override with DEBUG if in debug mode
    if debug_mode:
        level = "DEBUG"

    # Convert string to logging level
    numeric_level = getattr(logging, level.upper(), logging.INFO)

    # Set up basic logging configuration
    logging.basicConfig(
        level=numeric_level,
        format=format_string or DEFAULT_LOG_FORMAT,
        force=True,  # Override any existing configuration
    )

    # Set specific logger levels
    logging.getLogger().setLevel(numeric_level)

    # Reduce noise from third-party libraries
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("kubernetes").setLevel(logging.WARNING)

    # Create logger for this module
    logger = logging.getLogger(__name__)

    if debug_mode:
        logger.debug("Debug mode enabled - logging level set to DEBUG")
    else:
        logger.info(f"Logging configured with level: {level}")


def get_logger(name: str) -> logging.Logger:
    """
    Get a logger instance with the specified name.

    Args:
        name: Logger name (usually __name__)

    Returns:
        Configured logger instance
    """
    return logging.getLogger(name)
