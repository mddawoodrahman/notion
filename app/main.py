"""TaskBridge — Notion to PostgreSQL Sync Engine.

FastAPI application factory, lifecycle, and server entrypoint.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import uvicorn
from fastapi import FastAPI
from psycopg_pool import AsyncConnectionPool

from app.api.health import router as health_router
from app.api.webhooks import router as webhooks_router
from app.config import AppConfig, get_config
from app.lifespan import lifespan
from app.logging_config import logger


def create_app(
    config: AppConfig | None = None,
    pool: AsyncConnectionPool | None = None,
    check_db_ready: Callable[[], Any] | None = None,
) -> FastAPI:
    cfg = config or get_config()

    app = FastAPI(
        title="TaskBridge API",
        description="Reliable Notion-to-PostgreSQL synchronization API",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.state.config = cfg
    app.state.pool = pool
    app.state.check_db_ready = check_db_ready
    app.state.started_at = getattr(app.state, "started_at", None) or datetime.now(UTC)

    app.include_router(health_router)
    app.include_router(webhooks_router)

    return app


app: FastAPI = create_app()


def main() -> None:
    cfg = get_config()
    logger.info("Starting TaskBridge API HTTP server...", extra={"port": cfg.PORT})
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=cfg.PORT,
        log_level=cfg.LOG_LEVEL
        if cfg.LOG_LEVEL in ("debug", "info", "warning", "error", "critical")
        else "info",
    )


if __name__ == "__main__":
    main()
