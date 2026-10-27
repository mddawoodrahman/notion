"""CLI entrypoint for requeuing permanently failed events."""

from __future__ import annotations

import asyncio
import os
import sys

from dotenv import load_dotenv

from app.config import get_config
from app.db.inbox_repo import InboxRepository
from app.db.pool import close_pool, get_pool
from app.logging_config import configure_logging, get_logger

logger = get_logger(__name__)


async def run_retry_failed_cli(limit: int = 100) -> int:
    config = get_config()
    pool = await get_pool(config.DATABASE_URL)
    try:
        requeued = await InboxRepository.retry_failed_events(pool, limit)
        print(f"Requeued {requeued} failed events back to pending status.")
        return requeued
    except Exception as err:
        logger.error("Failed to requeue failed events", extra={"err": str(err)})
        sys.exit(1)
    finally:
        await close_pool(pool)


def main() -> None:
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    if os.getenv("APP_ENV") != "test" and os.getenv("NODE_ENV") != "test":
        load_dotenv(override=False)
    try:
        config = get_config()
        configure_logging(config.LOG_LEVEL)
    except Exception:
        configure_logging()
    limit = 100
    for arg in sys.argv[1:]:
        if arg.isdigit():
            limit = int(arg)
    asyncio.run(run_retry_failed_cli(limit=limit))


if __name__ == "__main__":
    main()
