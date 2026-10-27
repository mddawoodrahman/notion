"""Worker implementation processing claimed events from sync_inbox."""

import asyncio
import signal
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from psycopg_pool import AsyncConnectionPool

from app.config import AppConfig, get_config
from app.db.inbox_repo import InboxRepository
from app.db.pool import transaction_scope
from app.db.tasks_repo import TasksRepository
from app.errors import classify_error
from app.logging_config import get_logger
from app.sync.normalize import normalize_page
from app.sync.notion_client import NotionSyncClient
from app.sync.retry_policy import backoff_ms

logger = get_logger(__name__)


@dataclass
class WorkerOptions:
    client: NotionSyncClient
    pool: AsyncConnectionPool
    config: AppConfig | None = None
    resolved_data_source_id: str | None = None


async def process_next_event(options: WorkerOptions) -> bool:
    """Processes a single claimed event according to SPEC §11.2.

    Returns True if an event was claimed and processed, False if no pending events were due.
    """
    config = options.config or get_config()
    pool = options.pool
    client = options.client

    event = await InboxRepository.claim_next_event(pool)
    if not event:
        return False

    event_id = event.event_id
    event_type = event.event_type
    payload = event.payload or {}
    entity_obj = payload.get("entity") if isinstance(payload, dict) else None
    page_id = event.entity_id or (entity_obj.get("id") if isinstance(entity_obj, dict) else None)

    logger.info(
        "Worker processing inbox event",
        extra={
            "eventId": event_id,
            "eventType": event_type,
            "pageId": page_id,
            "attempt": event.attempts,
        },
    )

    try:
        # Handle according to event matrix (SPEC §11.2)
        if event_type == "page.deleted":
            # Tombstone without re-fetching from Notion (404 expected on deleted page)
            if page_id:
                async with transaction_scope(pool) as conn:
                    await TasksRepository.mark_task_in_trash(conn, page_id)
                    await InboxRepository.settle_event_success(conn, event_id)
            else:
                await InboxRepository.settle_event_success(pool, event_id)
        elif event_type in (
            "page.created",
            "page.properties_updated",
            "page.content_updated",
            "page.undeleted",
            "page.moved",
        ):
            if not page_id:
                raise ValueError(f"Page event {event_type} missing entity ID")

            # Fetch latest authoritative page record from Notion (INV-2)
            page = await client.fetch_page(page_id)

            # Fetch blocks if content updated and enabled.
            # BUG-004: leave body_blocks None when not fetched or when fetch fails,
            # so upsert preserves any previously stored page_content_json.
            body_blocks: list[dict[str, Any]] | None = None
            if (
                event_type == "page.content_updated" or config.SYNC_SYNC_BODY_CONTENT
            ) and not page.get("in_trash"):
                try:
                    body_blocks = await client.fetch_page_blocks(page_id)
                except Exception as block_err:
                    logger.warning(
                        "Could not fetch updated page body blocks; preserving stored page content",
                        extra={"pageId": page_id, "blockErr": str(block_err)},
                    )

            # BUG-001: resolve the target data source once and reuse it for every page event
            if not options.resolved_data_source_id:
                options.resolved_data_source_id = await client.resolve_data_source(
                    config.NOTION_DATABASE_ID,
                    config.NOTION_DATA_SOURCE_ID,
                )

            normalized = normalize_page(
                page,
                configured_data_source_id=options.resolved_data_source_id,
                configured_database_id=config.NOTION_DATABASE_ID,
                timezone_str=config.SYNC_TIMEZONE,
                body_blocks=body_blocks,
            )

            # Atomic commit: upsert task + settle inbox row (INV-6)
            async with transaction_scope(pool) as conn:
                await TasksRepository.upsert_task(conn, normalized)
                await InboxRepository.settle_event_success(conn, event_id)
        else:
            # Out-of-scope or informational event: acknowledge without mutating tasks
            async with transaction_scope(pool) as conn:
                await InboxRepository.settle_event_success(conn, event_id)

        logger.info("Worker settled event as processed", extra={"eventId": event_id})
        return True

    except Exception as err:
        classification = classify_error(err, event.attempts, config.SYNC_MAX_ATTEMPTS)
        logger.error(
            "Error processing inbox event",
            extra={
                "eventId": event_id,
                "category": classification.category,
                "err": classification.message,
            },
        )

        if classification.category == "RETRYABLE":
            delay_ms = backoff_ms(event.attempts, classification.retry_after_ms)
            available_at = datetime.now(UTC) + timedelta(milliseconds=delay_ms)
            await InboxRepository.settle_event_retryable(
                pool, event_id, available_at, classification.message
            )
        else:
            # PERMANENT or EXHAUSTED
            await InboxRepository.settle_event_failed(pool, event_id, classification.message)

        return True


async def start_worker(
    options: WorkerOptions,
    stop_event: asyncio.Event | None = None,
) -> None:
    """Runs the continuous worker loop with graceful shutdown support."""
    config = options.config or get_config()
    shutdown_event = stop_event or asyncio.Event()

    def handle_signal(*_args: Any) -> None:
        logger.info("Worker received shutdown signal, draining in-flight work...")
        shutdown_event.set()

    # Register OS signal handlers if supported
    try:
        signal.signal(signal.SIGINT, handle_signal)
        signal.signal(signal.SIGTERM, handle_signal)
    except (ValueError, AttributeError):
        pass  # If run outside main thread

    logger.info("TaskBridge Worker started")

    idle_delay_s = 1.0
    max_idle_delay_s = 30.0
    last_lease_check = 0.0

    loop = asyncio.get_running_loop()

    while not shutdown_event.is_set():
        try:
            now = loop.time()
            # Periodically recover expired leases (every 60s)
            if now - last_lease_check > 60.0:
                last_lease_check = now
                recovered = await InboxRepository.recover_stuck_events(
                    options.pool,
                    config.SYNC_LEASE_SECONDS,
                )
                if recovered > 0:
                    logger.warning(
                        "Recovered stuck inbox events with expired leases",
                        extra={"recovered": recovered},
                    )

            did_work = await process_next_event(options)
            if did_work:
                idle_delay_s = 1.0
            else:
                try:
                    await asyncio.wait_for(shutdown_event.wait(), timeout=idle_delay_s)
                    break
                except TimeoutError:
                    pass
                idle_delay_s = min(idle_delay_s * 1.5, max_idle_delay_s)

        except Exception as loop_err:
            logger.error(
                "Unexpected error in worker loop; sleeping 5s", extra={"err": str(loop_err)}
            )
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=5.0)
            except TimeoutError:
                pass

    logger.info("TaskBridge Worker stopped gracefully")
