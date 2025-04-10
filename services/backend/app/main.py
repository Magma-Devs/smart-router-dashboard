from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import metrics, helm
from app.core.config import settings

app = FastAPI(
    title="Lava Dashboard API",
    description="Backend API for Lava Dashboard with Prometheus metrics and Helm management",
    version="0.1.0"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(metrics.router, prefix="/api/metrics", tags=["metrics"])
app.include_router(helm.router, prefix="/api/helm", tags=["helm"])

@app.get("/api/health")
async def health_check():
    return {"status": "healthy"}

@app.get("/api")
async def root():
    return {
        "message": "Welcome to Lava Infra Manager Dashboard API",
        "docs_url": "/docs",
        "version": app.version
    } 