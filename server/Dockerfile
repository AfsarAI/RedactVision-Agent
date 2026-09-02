# ==============================================================================
# RedactVision Reasoning Server - Dockerfile (Built from server/ directory)
# ==============================================================================

# --- Stage 1: Build & Dependency Installation ---
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /build

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

COPY pyproject.toml .
COPY redactvision_server/ ./redactvision_server/
RUN pip install --no-cache-dir --no-deps .


# --- Stage 2: Production Runtime ---
FROM python:3.11-slim AS runner

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PATH="/opt/venv/bin:$PATH" \
    HOST="0.0.0.0" \
    PORT="8001" \
    ENVIRONMENT="production" \
    RELOAD="false"

WORKDIR /app

RUN groupadd -r appgroup && useradd -r -g appgroup -u 1001 appuser

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder --chown=appuser:appgroup /build /app/server

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", 8001)}/health', timeout=3)" || exit 1

USER appuser

CMD ["sh", "-c", "exec uvicorn redactvision_server.main:app --host ${HOST:-0.0.0.0} --port ${PORT:-8001}"]
