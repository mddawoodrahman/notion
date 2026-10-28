# syntax=docker/dockerfile:1
# TaskBridge — Notion to PostgreSQL Sync Engine
# Tagline: Bridge your tasks. Synchronize with confidence.
FROM python:3.12-slim-bookworm AS builder

WORKDIR /app

# Install uv for fast, reliable package builds
COPY --from=ghcr.io/astral-sh/uv:0.5.26 /uv /bin/uv

# Copy project definition and lockfiles
COPY pyproject.toml uv.lock* ./

# Install dependencies into virtualenv without building project (layer caching)
RUN uv sync --frozen --no-dev --no-install-project

# Copy application source and build project into virtualenv
COPY README.md ./
COPY app ./app
RUN uv sync --frozen --no-dev --no-editable

# --- Final Production Image ---
FROM python:3.12-slim-bookworm AS runner

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

LABEL org.opencontainers.image.title="TaskBridge" \
      org.opencontainers.image.description="TaskBridge is a Python-powered synchronization platform that replicates Notion tasks into PostgreSQL using FastAPI, durable webhook ingestion, and independent background processing." \
      org.opencontainers.image.version="0.1.0"

WORKDIR /app

# Create unprivileged application user
RUN groupadd -g 10001 appgroup && \
    useradd -u 10001 -g appgroup -s /sbin/nologin -d /app appuser

# Copy installed virtualenv from builder
COPY --from=builder --chown=appuser:appgroup /app/.venv /app/.venv

# Copy application source code and migrations
COPY --chown=appuser:appgroup app /app/app
COPY --chown=appuser:appgroup migrations /app/migrations
COPY --chown=appuser:appgroup pyproject.toml /app/pyproject.toml
COPY --chown=appuser:appgroup README.md /app/README.md

USER appuser

EXPOSE 3000

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-3000}\""]
