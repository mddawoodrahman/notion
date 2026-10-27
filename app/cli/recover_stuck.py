"""CLI entrypoint for recovering stuck in-flight events."""

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


async def run_recover_stuck_cli() -> int:
    config = get_config()
    pool = await get_pool(config.DATABASE_URL)
    try:
        recovered = await InboxRepository.recover_stuck_events(pool, config.SYNC_LEASE_SECONDS)
        print(f"Recovered {recovered} stuck processing events (reset to pending).")
        return recovered
    except Exception as err:
        logger.error("Failed to recover stuck events", extra={"err": str(err)})
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
    asyncio.run(run_recover_stuck_cli())


if __name__ == "__main__":
    main()
