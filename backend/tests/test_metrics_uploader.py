"""
Tests for metrics uploader pure functions.
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest

from app.tasks.metrics_uploader import (
    build_metrics_url,
    generate_s3_key,
    upload_metrics_to_s3,
)


def test_build_metrics_url():
    """Test URL building with encoded query parameters."""
    url = build_metrics_url(
        base_url="http://localhost:8000",
        query="sum(lava_consumer_total_relays_serviced) by (spec)",
        minutes=60,
        step="1s",
    )

    expected = "http://localhost:8000/api/metrics/last_minutes?query=sum%28lava_consumer_total_relays_serviced%29+by+%28spec%29&minutes=60&step=1s"
    assert url == expected


def test_build_metrics_url_default_step():
    """Test URL building with default step parameter."""
    url = build_metrics_url(base_url="http://api.example.com", query="up", minutes=15)

    expected = (
        "http://api.example.com/api/metrics/last_minutes?query=up&minutes=15&step=1s"
    )
    assert url == expected


def test_generate_s3_key():
    """Test S3 key generation with timestamp."""
    timestamp = datetime(2024, 1, 15, 14, 30, 45)
    key = generate_s3_key("test-tenant", timestamp)

    expected = "metrics/test-tenant/relays_served_2024-01-15T14-30-45Z.json"
    assert key == expected


def test_upload_metrics_to_s3_success():
    """Test successful metrics upload to S3."""
    # Mock HTTP session
    mock_response = MagicMock()
    mock_response.json.return_value = {"status": "success", "data": {"result": []}}

    mock_session = MagicMock()
    mock_session.get.return_value = mock_response

    # Mock S3 client
    mock_s3_client = MagicMock()
    mock_s3_client.put_object.return_value = {"ETag": "test-etag"}

    # Fixed timestamp for predictable key
    timestamp = datetime(2024, 1, 15, 14, 30, 45)

    key = upload_metrics_to_s3(
        s3_client=mock_s3_client,
        http_session=mock_session,
        url="http://test.com/metrics",
        bucket="test-bucket",
        tenant_id="test-tenant",
        timestamp=timestamp,
    )

    # Verify HTTP request
    mock_session.get.assert_called_once_with("http://test.com/metrics")
    mock_response.raise_for_status.assert_called_once()

    # Verify S3 upload
    expected_key = "metrics/test-tenant/relays_served_2024-01-15T14-30-45Z.json"
    mock_s3_client.put_object.assert_called_once_with(
        Bucket="test-bucket",
        Key=expected_key,
        Body='{"status": "success", "data": {"result": []}}',
        ContentType="application/json",
    )

    assert key == expected_key


def test_upload_metrics_to_s3_http_error():
    """Test upload failure when HTTP request fails."""
    # Mock HTTP session with error
    mock_response = MagicMock()
    mock_response.raise_for_status.side_effect = Exception("HTTP 500")

    mock_session = MagicMock()
    mock_session.get.return_value = mock_response

    mock_s3_client = MagicMock()

    with pytest.raises(Exception, match="HTTP 500"):
        upload_metrics_to_s3(
            s3_client=mock_s3_client,
            http_session=mock_session,
            url="http://test.com/metrics",
            bucket="test-bucket",
            tenant_id="test-tenant",
        )

    # S3 should not be called if HTTP fails
    mock_s3_client.put_object.assert_not_called()


def test_upload_metrics_to_s3_s3_error():
    """Test upload failure when S3 put_object fails."""
    # Mock successful HTTP response
    mock_response = MagicMock()
    mock_response.json.return_value = {"data": "test"}

    mock_session = MagicMock()
    mock_session.get.return_value = mock_response

    # Mock S3 client with error
    mock_s3_client = MagicMock()
    mock_s3_client.put_object.side_effect = Exception("S3 error")

    with pytest.raises(Exception, match="S3 error"):
        upload_metrics_to_s3(
            s3_client=mock_s3_client,
            http_session=mock_session,
            url="http://test.com/metrics",
            bucket="test-bucket",
            tenant_id="test-tenant",
        )

    # HTTP should have been called
    mock_session.get.assert_called_once()


def test_upload_metrics_to_s3_default_timestamp():
    """Test that upload uses current time when no timestamp provided."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"test": "data"}

    mock_session = MagicMock()
    mock_session.get.return_value = mock_response

    mock_s3_client = MagicMock()

    # Call without timestamp
    key = upload_metrics_to_s3(
        s3_client=mock_s3_client,
        http_session=mock_session,
        url="http://test.com/metrics",
        bucket="test-bucket",
        tenant_id="test-tenant",
        # No timestamp parameter
    )

    # Should generate a key with current timestamp
    assert key.startswith("metrics/test-tenant/relays_served_")
    assert key.endswith("Z.json")

    # S3 should have been called with the generated key
    mock_s3_client.put_object.assert_called_once()
    call_args = mock_s3_client.put_object.call_args
    assert call_args[1]["Key"] == key
    assert call_args[1]["Bucket"] == "test-bucket"
    assert call_args[1]["Body"] == '{"test": "data"}'
    assert call_args[1]["ContentType"] == "application/json"
