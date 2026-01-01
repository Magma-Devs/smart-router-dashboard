"""
Tests for tasks module integration.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.tasks import (
    DEFAULT_PROM_QUERY,
    create_http_session,
    create_s3_client,
    upload_metrics_to_s3_task,
)


def test_create_s3_client():
    """Test S3 client creation with settings."""
    with patch("app.tasks.boto3.client") as mock_boto3:
        mock_client = MagicMock()
        mock_boto3.return_value = mock_client

        client = create_s3_client()

        assert client == mock_client
        mock_boto3.assert_called_once_with(
            "s3",
            aws_access_key_id=None,  # From default settings (None when not set)
            aws_secret_access_key=None,
            region_name="us-east-1",
        )


def test_create_http_session():
    """Test HTTP session creation."""
    with patch("app.tasks.requests.Session") as mock_session_class:
        mock_session = MagicMock()
        mock_session_class.return_value = mock_session

        session = create_http_session()

        assert session == mock_session
        mock_session_class.assert_called_once()


@patch("app.tasks.upload_metrics_to_s3")
@patch("app.tasks.build_metrics_url")
@patch("app.tasks.create_http_session")
@patch("app.tasks.create_s3_client")
def test_upload_metrics_to_s3_task_success(
    mock_create_s3, mock_create_http, mock_build_url, mock_upload
):
    """Test successful metrics upload task."""
    # Setup mocks
    mock_s3_client = MagicMock()
    mock_http_session = MagicMock()
    mock_create_s3.return_value = mock_s3_client
    mock_create_http.return_value = mock_http_session
    mock_build_url.return_value = "http://localhost:8000/api/metrics/..."
    mock_upload.return_value = "metrics/default/relays_served_2024-01-01T00-00-00Z.json"

    # Call the task
    upload_metrics_to_s3_task()

    # Verify client creation
    mock_create_s3.assert_called_once()
    mock_create_http.assert_called_once()

    # Verify URL building
    mock_build_url.assert_called_once_with(
        "http://localhost:8000", DEFAULT_PROM_QUERY, minutes=60
    )

    # Verify upload call
    mock_upload.assert_called_once_with(
        s3_client=mock_s3_client,
        http_session=mock_http_session,
        url="http://localhost:8000/api/metrics/...",
        bucket="smart-router-output-metrics",  # From default settings
        tenant_id="modified",  # From singleton settings cache
    )


@patch("app.tasks.upload_metrics_to_s3")
@patch("app.tasks.build_metrics_url")
@patch("app.tasks.create_http_session")
@patch("app.tasks.create_s3_client")
@patch("app.tasks.logger")
def test_upload_metrics_to_s3_task_error(
    mock_logger, mock_create_s3, mock_create_http, mock_build_url, mock_upload
):
    """Test metrics upload task with error handling."""
    # Setup mocks
    mock_create_s3.return_value = MagicMock()
    mock_create_http.return_value = MagicMock()
    mock_build_url.return_value = "http://localhost:8000/api/metrics/..."
    mock_upload.side_effect = Exception("Upload failed")

    # Call the task - should not raise
    upload_metrics_to_s3_task()

    # Verify error was logged
    mock_logger.error.assert_called_once_with("[S3 UPLOAD ERROR] Upload failed")


def test_default_prom_query_constant():
    """Test that default Prometheus query is properly defined."""
    assert DEFAULT_PROM_QUERY == "sum(lava_consumer_total_relays_serviced) by (spec)"
    assert isinstance(DEFAULT_PROM_QUERY, str)
    assert len(DEFAULT_PROM_QUERY) > 0
