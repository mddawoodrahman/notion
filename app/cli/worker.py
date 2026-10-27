"""CLI entrypoint for running the continuous background sync worker."""

from __future__ import annotations

import asyncio
import os
import sys

from dotenv import load_dotenv

from app.config import get_config
from app.db.pool import close_pool, get_pool
from app.logging_config import configure_logging, get_logger
from app.sync.notion_client import NotionSyncClient
from app.sync.worker import WorkerOptions, start_worker

logger = get_logger(__name__)


async def run_worker() -> None:
    config = get_config()
    pool = await get_pool(config.DATABASE_URL)
    client = NotionSyncClient(config)
    try:
        await start_worker(WorkerOptions(client=client, pool=pool, config=config))
    except Exception as err:
        logger.error("Worker failed", extra={"err": str(err)})
        sys.exit(1)
    finally:
        await client.close()
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
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
