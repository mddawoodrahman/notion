"""CLI entrypoint for notion-sync operations."""

import asyncio
import sys
from typing import Annotated

import typer

from app.cli.backfill import run_backfill_cli
from app.cli.reconcile import run_reconcile_cli
from app.cli.recover_stuck import run_recover_stuck_cli
from app.cli.retry_failed import run_retry_failed_cli
from app.cli.worker import run_worker
from app.config import get_config
from app.db.migrate import get_migration_status, run_migrations
from app.db.pool import close_pool, get_pool
from app.logging_config import configure_logging, get_logger

app = typer.Typer(
    name="notion-sync",
    help="Notion Tasks to PostgreSQL synchronization service CLI",
    no_args_is_help=True,
)

logger = get_logger(__name__)


@app.callback()
def main_callback() -> None:
    """Configure structured logging before running CLI commands."""
    try:
        config = get_config()
        configure_logging(config.LOG_LEVEL)
    except Exception:
        configure_logging()


@app.command("worker")
def worker_cmd() -> None:
    """Run the continuous background sync worker."""
    asyncio.run(run_worker())


@app.command("backfill")
def backfill_cmd(
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Run without persisting task upserts")
    ] = False,
) -> None:
    """Run the initial paginated backfill."""
    asyncio.run(run_backfill_cli(dry_run=dry_run))


@app.command("reconcile")
def reconcile_cmd(
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Run without modifying database")
    ] = False,
) -> None:
    """Run the periodic reconciliation scan."""
    asyncio.run(run_reconcile_cli(dry_run=dry_run))


@app.command("recover-stuck")
def recover_stuck_cmd() -> None:
    """Recover stuck in-flight events whose lease has expired."""
    asyncio.run(run_recover_stuck_cli())


@app.command("retry-failed")
def retry_failed_cmd(
    limit: Annotated[int, typer.Option("--limit", help="Max events to retry")] = 100,
) -> None:
    """Requeue permanently failed inbox events back to pending status."""
    asyncio.run(run_retry_failed_cli(limit=limit))


@app.command("migrate")
def migrate_cmd(
    action: Annotated[str, typer.Argument(help="Operation: 'up' (default) or 'status'")] = "up",
) -> None:
    """Run database migrations or inspect status."""

    async def _run() -> None:
        config = get_config()
        conn_string = config.DIRECT_DATABASE_URL or config.DATABASE_URL
        pool = await get_pool(conn_string)
        try:
            if action.lower() == "status":
                status = await get_migration_status(pool)
                print("Migration status:")
                for item in status:
                    applied_mark = "[X]" if item.applied else "[ ]"
                    info = (
                        f"(applied at {item.applied_at.isoformat()})"
                        if item.applied_at
                        else "(pending)"
                    )
                    print(f"  {applied_mark} {item.version} {info}")
            else:
                results = await run_migrations(pool)
                applied_count = sum(1 for r in results if r.applied)
                print(
                    f"Migrations complete: {applied_count} applied, {len(results) - applied_count} already current."
                )
                for r in results:
                    mark = "APPLIED" if r.applied else "CURRENT"
                    print(f"  [{mark}] {r.version}")
        except Exception as err:
            logger.error("Migration failed", extra={"err": str(err)})
            sys.exit(1)
        finally:
            await close_pool(pool)

    asyncio.run(_run())


if __name__ == "__main__":
    app()
