"""
Main FastAPI application for the Smart Router Dashboard API.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import auth, components, metrics
from app.api.routes import settings as settings_router
from app.core.auth import AuthMiddleware
from app.core.config import settings
from app.tasks import schedule_metrics_s3_upload

app = FastAPI(
    title=settings.project_name,
    description="Backend API for Smart Router Dashboard with Prometheus metrics and Helm management",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Add authentication middleware
app.add_middleware(AuthMiddleware)

# Include routers
app.include_router(auth.router, prefix="/api/auth", tags=["authentication"])
app.include_router(metrics.router, prefix="/api/metrics", tags=["metrics"])
app.include_router(components.router, prefix="/api/components", tags=["components"])
app.include_router(settings_router.router, prefix="/api/settings", tags=["settings"])

if settings.is_send_metrics_to_s3:
    schedule_metrics_s3_upload()


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}


@app.get("/api")
async def root():
    """Root endpoint with API information."""
    return {
        "message": f"Welcome to {settings.project_name} API",
        "docs_url": "/docs",
        "version": app.version,
        "authentication_required": True,
        "features": ["authentication", "metrics", "components", "settings"],
    }
