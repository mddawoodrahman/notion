"""Initial paginated backfill importing all accessible tasks from the configured source."""

from dataclasses import dataclass

from psycopg_pool import AsyncConnectionPool

from app.config import AppConfig, get_config
from app.db.runs_repo import RunsRepository, RunStatus
from app.db.tasks_repo import TasksRepository
from app.errors import sanitize_error_message
from app.logging_config import get_logger
from app.sync.normalize import normalize_page
from app.sync.notion_client import NotionSyncClient

logger = get_logger(__name__)


@dataclass
class BackfillOptions:
    client: NotionSyncClient
    pool: AsyncConnectionPool
    config: AppConfig | None = None
    dry_run: bool = False


@dataclass
class BackfillResult:
    run_id: int | None
    records_processed: int
    page_failures: int
    status: RunStatus
    data_source_id: str
    is_incomplete: bool
    incomplete_reason: str | None


async def run_backfill(options: BackfillOptions) -> BackfillResult:
    """Runs the initial paginated backfill importing all accessible tasks from the configured source."""
    config = options.config or get_config()
    pool = options.pool
    client = options.client

    # 1. Resolve master Tasks data source
    data_source_id = await client.resolve_data_source(
        config.NOTION_DATABASE_ID,
        config.NOTION_DATA_SOURCE_ID,
    )

    logger.info(
        "Starting initial backfill",
        extra={"dataSourceId": data_source_id, "dryRun": options.dry_run},
    )

    # 2. Open sync_runs record
    run_id: int | None = None
    if not options.dry_run:
        run_id = await RunsRepository.start_run(pool, "initial_backfill")

    records_processed = 0
    page_failures = 0
    cursor: str | None = None
    has_more = True
    final_status: RunStatus = "succeeded"
    is_incomplete = False
    incomplete_reason: str | None = None
    last_error_message: str | None = None
    seen_cursors: set[str] = set()

    try:
        # 3. Paginate until complete
        while has_more:
            if cursor:
                if cursor in seen_cursors:
                    raise RuntimeError(
                        f"Infinite pagination cycle detected: cursor {cursor} already seen"
                    )
                seen_cursors.add(cursor)

            response = await client.query_data_source_pages(
                data_source_id,
                start_cursor=cursor,
                page_size=config.SYNC_PAGE_SIZE,
            )

            # BUG-002: surface the Notion 10,000-result query cap instead of trusting has_more=false
            if response.is_incomplete:
                is_incomplete = True
                incomplete_reason = response.incomplete_reason or "query_result_limit_reached"
                logger.warning(
                    "Notion reported an incomplete query result set during backfill",
                    extra={
                        "dataSourceId": data_source_id,
                        "cursor": cursor,
                        "incompleteReason": incomplete_reason,
                    },
                )

            for page in response.results:
                try:
                    record = normalize_page(
                        page,
                        configured_data_source_id=data_source_id,
                        configured_database_id=config.NOTION_DATABASE_ID,
                        timezone_str=config.SYNC_TIMEZONE,
                    )

                    if not options.dry_run:
                        await TasksRepository.upsert_task(pool, record)
                    records_processed += 1
                except Exception as page_err:
                    page_failures += 1
                    last_error_message = sanitize_error_message(page_err)
                    logger.error(
                        "Failed to process page during backfill",
                        extra={
                            "pageId": page.id
                            if hasattr(page, "id")
                            else getattr(page, "get", lambda _: None)("id"),
                            "err": str(page_err),
                        },
                    )

            has_more = response.has_more
            cursor = response.next_cursor

        if is_incomplete or page_failures > 0:
            final_status = "partial" if (records_processed > 0 or is_incomplete) else "failed"
            if not last_error_message:
                last_error_message = (
                    f"Notion query returned an incomplete result set ({incomplete_reason or 'unknown reason'})"
                    if is_incomplete
                    else f"Backfill completed with {page_failures} page failure(s)"
                )
            logger.warning(
                "Backfill coverage is incomplete; run status recorded as partial",
                extra={
                    "recordsProcessed": records_processed,
                    "pageFailures": page_failures,
                    "isIncomplete": is_incomplete,
                    "incompleteReason": incomplete_reason,
                },
            )

    except Exception as err:
        final_status = "failed"
        last_error_message = sanitize_error_message(err)
        logger.error("Backfill failed abruptly", extra={"err": str(err)})
        raise
    finally:
        if run_id is not None:
            await RunsRepository.finish_run(
                pool,
                run_id,
                final_status,
                records_processed,
                last_error_message,
                cursor,
            )

    logger.info(
        "Initial backfill completed",
        extra={
            "runId": run_id,
            "recordsProcessed": records_processed,
            "pageFailures": page_failures,
            "status": final_status,
            "isIncomplete": is_incomplete,
        },
    )

    return BackfillResult(
        run_id=run_id,
        records_processed=records_processed,
        page_failures=page_failures,
        status=final_status,
        data_source_id=data_source_id,
        is_incomplete=is_incomplete,
        incomplete_reason=incomplete_reason,
    )
