FROM python:3.11-slim

# Accept version as build arg
ARG APP_VERSION=unknown

WORKDIR /app

# Install system dependencies
RUN apt-get update && \
    apt-get install -y git curl apt-transport-https gnupg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --system appuser && \
    useradd --system --gid appuser --create-home appuser

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Write version to file for runtime access
RUN echo "${APP_VERSION}" > /app/VERSION

# Change ownership to non-root user
RUN chown -R appuser:appuser /app

EXPOSE 8000

USER appuser

# Run the application (no --reload in production)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
