from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI

from app.config import get_config
from app.db.pool import close_pool, get_pool
from app.logging_config import logger


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manages application startup and shutdown lifecycle for connection pools and resources."""
    # Ensure config is initialized
    if not hasattr(app.state, "config") or app.state.config is None:
        app.state.config = get_config()

    # Track startup timestamp for uptime monitoring
    app.state.started_at = datetime.now(UTC)

    # Initialize connection pool if not already injected
    if not hasattr(app.state, "pool") or app.state.pool is None:
        try:
            pool = await get_pool(app.state.config.DATABASE_URL)
            app.state.pool = pool
            app.state._owns_pool = True
            logger.info("Database connection pool initialized")
        except Exception as e:
            logger.error(
                "Failed to initialize database connection pool on startup", extra={"err": str(e)}
            )
            app.state.pool = None
            app.state._owns_pool = False
    else:
        app.state._owns_pool = False

    yield

    # Teardown pool on shutdown if created by lifespan
    if getattr(app.state, "_owns_pool", False) and app.state.pool is not None:
        logger.info("Closing database connection pool on shutdown...")
        await close_pool(app.state.pool)
        app.state.pool = None
