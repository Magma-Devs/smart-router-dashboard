"""
Tasks module for background job scheduling.
"""

import logging
from datetime import datetime

import boto3
import requests
from apscheduler.schedulers.background import BackgroundScheduler

from app.core.config import settings
from .metrics_uploader import build_metrics_url, upload_metrics_to_s3

logger = logging.getLogger(__name__)

# Default Prometheus query for metrics collection
DEFAULT_PROM_QUERY = "sum(lava_consumer_total_relays_serviced) by (spec)"


def create_s3_client():
    """Create S3 client with settings configuration."""
    return boto3.client(
        "s3",
        aws_access_key_id=settings.S3_ACCESS_KEY,
        aws_secret_access_key=settings.S3_SECRET_KEY,
        region_name=settings.S3_REGION,
    )


def create_http_session():
    """Create HTTP session for making requests."""
    return requests.Session()


def upload_metrics_to_s3_task():
    """
    Task wrapper for uploading metrics to S3.
    Creates clients and delegates to pure function.
    """
    try:
        # Create clients
        s3_client = create_s3_client()
        http_session = create_http_session()

        # Build metrics URL
        base_url = "http://localhost:8000"  # TODO: Make configurable
        url = build_metrics_url(base_url, DEFAULT_PROM_QUERY, minutes=60)

        # Upload metrics
        key = upload_metrics_to_s3(
            s3_client=s3_client,
            http_session=http_session,
            url=url,
            bucket=settings.S3_BUCKET,
            tenant_id=settings.TENANT_ID,
        )

        logger.info(f"[S3 UPLOAD] Uploaded metrics to {settings.S3_BUCKET}/{key}")

    except Exception as e:
        logger.error(f"[S3 UPLOAD ERROR] {e}")


def schedule_metrics_s3_upload():
    """
    Schedule periodic metrics upload to S3.
    Only starts scheduler if S3 upload is enabled in settings.
    """
    scheduler = BackgroundScheduler()
    scheduler.add_job(
        upload_metrics_to_s3_task, "interval", hours=1, next_run_time=datetime.utcnow()
    )
    scheduler.start()
    logger.info("[SCHEDULER] Started hourly metrics upload to S3.")
