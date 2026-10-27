"""CLI entrypoint for running the periodic reconciliation scan."""

from __future__ import annotations

import asyncio
import os
import sys

from dotenv import load_dotenv

from app.config import get_config
from app.db.pool import close_pool, get_pool
from app.logging_config import configure_logging, get_logger
from app.sync.notion_client import NotionSyncClient
from app.sync.reconcile import ReconcileOptions, ReconcileResult, run_reconciliation

logger = get_logger(__name__)


async def run_reconcile_cli(dry_run: bool = False) -> ReconcileResult:
    config = get_config()
    pool = await get_pool(config.DATABASE_URL)
    client = NotionSyncClient(config)
    try:
        result = await run_reconciliation(
            ReconcileOptions(
                client=client,
                pool=pool,
                config=config,
                dry_run=dry_run,
            )
        )
        print(
            f"Reconciliation complete: status={result.status} processed={result.records_processed} "
            f"failed={result.page_failures} remediated={result.remediated_outdated} "
            f"run_id={result.run_id if result.run_id is not None else 'dry-run'}"
        )
        if result.status in ("failed", "partial"):
            sys.exit(1)
        return result
    except Exception as err:
        logger.error("Reconciliation command failed", extra={"err": str(err)})
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
    dry_run = "--dry-run" in sys.argv
    asyncio.run(run_reconcile_cli(dry_run=dry_run))


if __name__ == "__main__":
    main()
