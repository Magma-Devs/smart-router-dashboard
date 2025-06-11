import boto3
import requests
import urllib.parse

from app.core.config import settings
import json
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler


PROM_QUERY = 'sum(lava_consumer_total_relays_serviced) by (spec)'
ENCODED_QUERY = urllib.parse.quote_plus(PROM_QUERY)
METRICS_API_URL = f"http://localhost:8000/api/metrics/last_minutes?query={ENCODED_QUERY}&minutes=60&step=1s"

s3_client = boto3.client(
    "s3",
    aws_access_key_id=settings.S3_ACCESS_KEY,
    aws_secret_access_key=settings.S3_SECRET_KEY,
    region_name=settings.S3_REGION,
)

def upload_metrics_to_s3():
    try:
        resp = requests.get(METRICS_API_URL)
        resp.raise_for_status()
        data = resp.json()
        now = datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ")
        key = f"metrics/{settings.TENANT_ID}/relays_served_{now}.json"
        s3_client.put_object(
            Bucket=settings.S3_BUCKET,
            Key=key,
            Body=json.dumps(data),
            ContentType="application/json"
        )
        print(f"[S3 UPLOAD] Uploaded metrics to {settings.S3_BUCKET}/{key}")
    except Exception as e:
        print(f"[S3 UPLOAD ERROR] {e}")

def schedule_metrics_s3_upload():
    scheduler = BackgroundScheduler()
    scheduler.add_job(upload_metrics_to_s3, 'interval', hours=1, next_run_time=datetime.utcnow())
    scheduler.start()
    print("[SCHEDULER] Started hourly metrics upload to S3.")
