# ==============================================================================
# RedactVision Reasoning Server - Production Dockerfile for AWS Deployment
# Compatible with AWS App Runner, AWS ECS (Fargate/EC2), AWS EKS, Elastic Beanstalk
# (The browser extension is excluded as it executes client-side)
# ==============================================================================

# --- Stage 1: Build & Dependency Installation ---
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /build

# Create isolated virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install production dependencies first to maximize Docker layer caching
COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r ./server/requirements.txt

# Copy server package code and install package
COPY server/pyproject.toml ./server/pyproject.toml
COPY server/redactvision_server/ ./server/redactvision_server/
RUN pip install --no-cache-dir --no-deps ./server


# --- Stage 2: Production Runtime ---
FROM python:3.11-slim AS runner

# Security & Python runtime optimizations
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PATH="/opt/venv/bin:$PATH" \
    HOST="0.0.0.0" \
    PORT="8001" \
    ENVIRONMENT="production" \
    RELOAD="false"

WORKDIR /app

# Run as non-root user (adheres to AWS Well-Architected & CIS Docker benchmarks)
RUN groupadd -r appgroup && useradd -r -g appgroup -u 1001 appuser

# Copy virtual environment and installed server from builder
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder --chown=appuser:appgroup /build/server /app/server

# Expose default port (default: 8001, configurable via PORT env var)
EXPOSE 8001

# Healthcheck for container orchestrators (AWS ECS, App Runner, Docker Compose)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", 8001)}/health', timeout=3)" || exit 1

# Run as non-root user
USER appuser

# Launch server with exec so uvicorn receives PID 1 signals directly (graceful shutdown)
CMD ["sh", "-c", "exec uvicorn redactvision_server.main:app --host ${HOST:-0.0.0.0} --port ${PORT:-8001}"]
