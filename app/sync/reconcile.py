"""Full reconciliation scan across the authorized data source (SPEC §11.6)."""

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
class ReconcileOptions:
    client: NotionSyncClient
    pool: AsyncConnectionPool
    config: AppConfig | None = None
    dry_run: bool = False


@dataclass
class ReconcileResult:
    run_id: int | None
    records_processed: int
    page_failures: int
    status: RunStatus
    remediated_outdated: int
    data_source_id: str
    is_incomplete: bool
    incomplete_reason: str | None


async def run_reconciliation(options: ReconcileOptions) -> ReconcileResult:
    """Executes a full reconciliation scan across the authorized data source (SPEC §11.6).

    Safely repairs missed updates and marks vanished records out-of-scope ONLY if
    the scan was 100% complete with 0 page failures (INV-5).
    """
    config = options.config or get_config()
    pool = options.pool
    client = options.client

    data_source_id = await client.resolve_data_source(
        config.NOTION_DATABASE_ID,
        config.NOTION_DATA_SOURCE_ID,
    )

    logger.info(
        "Starting reconciliation scan",
        extra={"dataSourceId": data_source_id, "dryRun": options.dry_run},
    )

    run_id: int | None = None
    if not options.dry_run:
        run_id = await RunsRepository.start_run(pool, "reconciliation")

    seen_page_ids: set[str] = set()
    records_processed = 0
    page_failures = 0
    cursor: str | None = None
    has_more = True
    scan_complete = False
    is_incomplete = False
    incomplete_reason: str | None = None
    remediated_outdated = 0
    final_status: RunStatus = "succeeded"
    last_error_message: str | None = None
    seen_cursors: set[str] = set()

    try:
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

            # BUG-002: Notion sets request_status=incomplete (e.g. query_result_limit_reached)
            # when it silently caps a query at 10,000 results and reports has_more=false.
            if response.is_incomplete:
                is_incomplete = True
                incomplete_reason = response.incomplete_reason or "query_result_limit_reached"
                logger.warning(
                    "Notion reported an incomplete query result set during reconciliation",
                    extra={
                        "dataSourceId": data_source_id,
                        "cursor": cursor,
                        "incompleteReason": incomplete_reason,
                    },
                )

            for page in response.results:
                page_id = (
                    page.id if hasattr(page, "id") else getattr(page, "get", lambda _: None)("id")
                )
                if not page_id:
                    continue
                seen_page_ids.add(page_id)

                try:
                    # Fetch full page to repair any missed field changes
                    full_page = await client.fetch_page(page_id)
                    record = normalize_page(
                        full_page,
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
                        "Failed to reconcile page",
                        extra={"pageId": page_id, "err": str(page_err)},
                    )

            has_more = response.has_more
            cursor = response.next_cursor

        scan_complete = True

        # INV-5 + BUG-002: remediation requires a provably complete, uncapped, error-free scan.
        if not scan_complete or is_incomplete or page_failures > 0:
            final_status = "partial" if (records_processed > 0 or is_incomplete) else "failed"
            if not last_error_message:
                last_error_message = (
                    f"Notion query returned an incomplete result set ({incomplete_reason or 'unknown reason'}); out-of-source remediation skipped"
                    if is_incomplete
                    else f"Scan completed with {page_failures} page failure(s); out-of-source remediation skipped"
                )
            logger.warning(
                "Reconciliation was partial. Skipping out-of-source remediation to protect existing tasks (INV-5)",
                extra={
                    "recordsProcessed": records_processed,
                    "pageFailures": page_failures,
                    "isIncomplete": is_incomplete,
                    "incompleteReason": incomplete_reason,
                },
            )
        else:
            final_status = "succeeded"
            if not options.dry_run and seen_page_ids:
                remediated_outdated = await TasksRepository.mark_tasks_out_of_source(
                    pool,
                    list(seen_page_ids),
                )
                if remediated_outdated > 0:
                    logger.info(
                        "Flagged vanished pages as is_in_source=false",
                        extra={"remediatedOutdated": remediated_outdated},
                    )

    except Exception as err:
        final_status = "failed"
        last_error_message = sanitize_error_message(err)
        logger.error("Reconciliation scan aborted", extra={"err": str(err)})
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
        "Reconciliation completed",
        extra={
            "runId": run_id,
            "recordsProcessed": records_processed,
            "pageFailures": page_failures,
            "remediatedOutdated": remediated_outdated,
            "status": final_status,
            "isIncomplete": is_incomplete,
        },
    )

    return ReconcileResult(
        run_id=run_id,
        records_processed=records_processed,
        page_failures=page_failures,
        status=final_status,
        remediated_outdated=remediated_outdated,
        data_source_id=data_source_id,
        is_incomplete=is_incomplete,
        incomplete_reason=incomplete_reason,
    )
