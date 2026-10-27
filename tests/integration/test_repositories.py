"""Integration tests for repositories against real PostgreSQL."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from psycopg.rows import dict_row

from app.db.inbox_repo import InboxEventInput, InboxRepository
from app.db.migrate import run_migrations
from app.db.pool import close_pool, create_pool, with_transaction
from app.db.runs_repo import RunsRepository
from app.db.tasks_repo import NormalizedTaskRecord, TasksRepository
from tests.integration.helpers.test_database import start_test_database

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent.parent / "migrations"


def sample_task(**overrides: Any) -> NormalizedTaskRecord:
    now_iso = datetime.now(UTC).isoformat()
    defaults = {
        "notion_page_id": "11111111-1111-4111-8111-111111111111",
        "title": "Write the report",
        "status": "Todo",
        "list_name": "Work",
        "important": False,
        "in_my_day": False,
        "priority": "High",
        "due_date": "2026-10-21",
        "due_at": None,
        "reminder_at": None,
        "user_archived": False,
        "notion_is_archived": False,
        "notion_in_trash": False,
        "is_in_source": True,
        "page_url": "https://www.notion.so/11111111111141118111111111111111",
        "notion_created_time": "2026-10-01T08:00:00.000Z",
        "notion_last_edited_time": "2026-10-20T12:00:00.000Z",
        "raw_properties": {
            "Name": {"type": "title", "title": [{"plain_text": "Write the report"}]},
            "Unknown Future": {"type": "future_widget", "future_widget": {"hard": "to map"}},
        },
        "page_content_json": [],
        "synced_at": now_iso,
    }
    defaults.update(overrides)
    return NormalizedTaskRecord(**defaults)  # type: ignore[arg-type]


def sample_event(event_id: str, **overrides: Any) -> InboxEventInput:
    defaults = {
        "event_id": event_id,
        "event_type": "page.properties_updated",
        "entity_type": "page",
        "entity_id": f"page-{event_id}",
        "event_timestamp": "2026-10-21T10:00:00.000Z",
        "payload": {"id": event_id, "type": "page.properties_updated"},
    }
    defaults.update(overrides)
    return InboxEventInput(**defaults)  # type: ignore[arg-type]


async def count_tasks(pool) -> int:
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) FROM notion_sync.notion_tasks")
            row = await cur.fetchone()
            return int(row[0]) if row else 0


async def get_task_row(pool, page_id: str) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT * FROM notion_sync.notion_tasks WHERE notion_page_id = %s",
                (page_id,),
            )
            row = await cur.fetchone()
            return dict(row) if row else None


async def get_inbox_row(pool, event_id: str) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT * FROM notion_sync.sync_inbox WHERE event_id = %s",
                (event_id,),
            )
            row = await cur.fetchone()
            return dict(row) if row else None


async def get_run_row(pool, run_id: int) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT * FROM notion_sync.sync_runs WHERE run_id = %s",
                (run_id,),
            )
            row = await cur.fetchone()
            return dict(row) if row else None


@pytest.fixture(scope="module")
async def pg_cluster():
    database = await start_test_database()
    pool = create_pool(database.url, open_pool=False)
    await pool.open()
    await run_migrations(pool, MIGRATIONS_DIR)
    try:
        yield database, pool
    finally:
        await close_pool(pool)
        await database.stop()


@pytest.fixture(autouse=True)
async def clean_tables(pg_cluster):
    _, pool = pg_cluster
    async with pool.connection() as conn:
        await conn.execute(
            "TRUNCATE notion_sync.notion_tasks, notion_sync.sync_inbox, notion_sync.sync_runs RESTART IDENTITY"
        )


# --- tasks-repo tests (12 tests) ---


@pytest.mark.asyncio
async def test_tasks_repo_inserts_once_and_updates_on_repeat(pg_cluster):
    _, pool = pg_cluster
    first = await TasksRepository.upsert_task(pool, sample_task())
    second = await TasksRepository.upsert_task(
        pool,
        sample_task(title="Write the final report", status="Done", priority="Low"),
    )

    assert first is not None
    assert second is not None
    assert await count_tasks(pool) == 1

    row = await get_task_row(pool, sample_task().notion_page_id)
    assert row is not None
    assert row["title"] == "Write the final report"
    assert row["status"] == "Done"
    assert row["priority"] == "Low"


@pytest.mark.asyncio
async def test_tasks_repo_preserves_unknown_json_properties_verbatim(pg_cluster):
    _, pool = pg_cluster
    await TasksRepository.upsert_task(pool, sample_task())
    row = await get_task_row(pool, sample_task().notion_page_id)
    assert row is not None
    assert row["raw_properties"]["Unknown Future"] == {
        "type": "future_widget",
        "future_widget": {"hard": "to map"},
    }


@pytest.mark.asyncio
async def test_tasks_repo_does_not_regress_to_older_last_edited_time(pg_cluster):
    _, pool = pg_cluster
    await TasksRepository.upsert_task(pool, sample_task(title="Newest"))
    stale = await TasksRepository.upsert_task(
        pool,
        sample_task(title="Older", notion_last_edited_time="2026-10-19T00:00:00.000Z"),
    )

    assert stale is None
    row = await get_task_row(pool, sample_task().notion_page_id)
    assert row is not None
    assert row["title"] == "Newest"


@pytest.mark.asyncio
async def test_tasks_repo_preserves_page_content_json_when_newer_has_no_fetched_content(pg_cluster):
    _, pool = pg_cluster
    await TasksRepository.upsert_task(
        pool,
        sample_task(page_content_json=[{"type": "paragraph", "text": "keep me"}]),
    )

    newer = await TasksRepository.upsert_task(
        pool,
        sample_task(
            title="Newer revision",
            notion_last_edited_time="2026-10-21T13:00:00.000Z",
            page_content_json=None,
        ),
    )

    assert newer is not None
    row = await get_task_row(pool, sample_task().notion_page_id)
    assert row is not None
    assert row["title"] == "Newer revision"
    assert row["page_content_json"] == [{"type": "paragraph", "text": "keep me"}]

    # A genuinely empty fetched page ([]) must still overwrite stored content
    await TasksRepository.upsert_task(
        pool,
        sample_task(notion_last_edited_time="2026-10-22T00:00:00.000Z", page_content_json=[]),
    )
    row = await get_task_row(pool, sample_task().notion_page_id)
    assert row is not None
    assert row["page_content_json"] == []


@pytest.mark.asyncio
async def test_tasks_repo_stores_empty_array_when_content_never_fetched_first_insert(pg_cluster):
    _, pool = pg_cluster
    await TasksRepository.upsert_task(pool, sample_task(page_content_json=None))

    row = await get_task_row(pool, sample_task().notion_page_id)
    assert row is not None
    assert row["page_content_json"] == []
    assert await count_tasks(pool) == 1


@pytest.mark.asyncio
async def test_tasks_repo_never_lets_null_last_edited_time_overwrite_existing(pg_cluster):
    _, pool = pg_cluster
    await TasksRepository.upsert_task(pool, sample_task(title="Authoritative"))

    malformed = await TasksRepository.upsert_task(
        pool,
        sample_task(title="Malformed payload", status="Done", notion_last_edited_time=None),
    )

    assert malformed is None
    row = await get_task_row(pool, sample_task().notion_page_id)
    assert row is not None
    assert row["title"] == "Authoritative"
    assert row["status"] == "Todo"
    assert row["notion_last_edited_time"] == datetime(2026, 10, 20, 12, 0, tzinfo=UTC)

    # A valid snapshot can still repair a row that has no timestamp at all
    await TasksRepository.upsert_task(
        pool,
        sample_task(
            notion_page_id="page-null-timestamp",
            title="No timestamp yet",
            notion_last_edited_time=None,
        ),
    )
    repaired = await TasksRepository.upsert_task(
        pool,
        sample_task(
            notion_page_id="page-null-timestamp",
            title="Timestamped",
            notion_last_edited_time="2026-10-20T12:00:00.000Z",
        ),
    )
    assert repaired is not None
    row = await get_task_row(pool, "page-null-timestamp")
    assert row is not None
    assert row["title"] == "Timestamped"


@pytest.mark.asyncio
async def test_tasks_repo_applies_equal_timestamp_and_refreshes_synced_at(pg_cluster):
    _, pool = pg_cluster
    await TasksRepository.upsert_task(pool, sample_task())
    before = await get_task_row(pool, sample_task().notion_page_id)

    await asyncio.sleep(0.02)
    equal = await TasksRepository.upsert_task(pool, sample_task(title="Same version, new title"))
    after = await get_task_row(pool, sample_task().notion_page_id)

    assert equal is not None
    assert after is not None
    assert before is not None
    assert after["title"] == "Same version, new title"
    assert after["synced_at"] > before["synced_at"]


@pytest.mark.asyncio
async def test_tasks_repo_tombstones_trashed_page_without_deleting_and_restores(pg_cluster):
    _, pool = pg_cluster
    await TasksRepository.upsert_task(pool, sample_task())

    assert await TasksRepository.mark_task_in_trash(pool, sample_task().notion_page_id) is True

    after_trash = await get_task_row(pool, sample_task().notion_page_id)
    assert after_trash is not None
    assert after_trash["notion_in_trash"] is True
    assert after_trash["user_archived"] is False
    assert await count_tasks(pool) == 1

    await TasksRepository.upsert_task(pool, sample_task(notion_in_trash=False, title="Restored"))
    after_restore = await get_task_row(pool, sample_task().notion_page_id)
    assert after_restore is not None
    assert after_restore["notion_in_trash"] is False
    assert after_restore["title"] == "Restored"


@pytest.mark.asyncio
async def test_tasks_repo_keeps_out_of_scope_page_with_is_in_source_false(pg_cluster):
    _, pool = pg_cluster
    await TasksRepository.upsert_task(
        pool, sample_task(is_in_source=False, notion_is_archived=True)
    )

    row = await get_task_row(pool, sample_task().notion_page_id)
    assert row is not None
    assert row["is_in_source"] is False
    assert row["notion_is_archived"] is True
    assert await count_tasks(pool) == 1


@pytest.mark.asyncio
async def test_tasks_repo_flags_pages_missing_from_completed_scan(pg_cluster):
    _, pool = pg_cluster
    await TasksRepository.upsert_task(pool, sample_task(notion_page_id="page-keep"))
    await TasksRepository.upsert_task(pool, sample_task(notion_page_id="page-gone"))

    assert await TasksRepository.mark_tasks_out_of_source(pool, ["page-keep"]) == 1

    row_keep = await get_task_row(pool, "page-keep")
    row_gone = await get_task_row(pool, "page-gone")
    assert row_keep is not None and row_keep["is_in_source"] is True
    assert row_gone is not None and row_gone["is_in_source"] is False
    assert await count_tasks(pool) == 2


@pytest.mark.asyncio
async def test_tasks_repo_refuses_to_mass_tombstone_when_active_ids_empty(pg_cluster):
    _, pool = pg_cluster
    await TasksRepository.upsert_task(pool, sample_task(notion_page_id="page-keep"))

    assert await TasksRepository.mark_tasks_out_of_source(pool, []) == 0
    row_keep = await get_task_row(pool, "page-keep")
    assert row_keep is not None and row_keep["is_in_source"] is True


@pytest.mark.asyncio
async def test_tasks_repo_never_issues_delete_against_notion_tasks():
    repo_root = Path(__file__).resolve().parent.parent.parent
    directories = [repo_root / "app" / "db", repo_root / "app" / "sync"]

    for d in directories:
        for py_file in d.glob("*.py"):
            content = py_file.read_text(encoding="utf-8")
            import re

            assert not re.search(
                r"DELETE\s+FROM\s+notion_sync\.notion_tasks", content, re.IGNORECASE
            )


# --- inbox-repo tests (8 tests) ---


@pytest.mark.asyncio
async def test_inbox_repo_stores_events_idempotently_by_event_id(pg_cluster):
    _, pool = pg_cluster
    first = await InboxRepository.enqueue_event(pool, sample_event("evt-1"))
    duplicate = await InboxRepository.enqueue_event(pool, sample_event("evt-1"))

    assert first.is_duplicate is False
    assert duplicate.is_duplicate is True

    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT COUNT(*) FROM notion_sync.sync_inbox WHERE status = 'pending'"
            )
            row = await cur.fetchone()
            assert row is not None and int(row[0]) == 1


@pytest.mark.asyncio
async def test_inbox_repo_claims_due_events_atomically_with_skip_locked(pg_cluster):
    _, pool = pg_cluster
    await InboxRepository.enqueue_event(pool, sample_event("evt-1"))
    await InboxRepository.enqueue_event(pool, sample_event("evt-2"))

    results = await asyncio.gather(
        InboxRepository.claim_next_event(pool),
        InboxRepository.claim_next_event(pool),
        InboxRepository.claim_next_event(pool),
    )

    claimed = [r for r in results if r is not None]
    rejected = [r for r in results if r is None]

    assert len(claimed) == 2
    assert len(rejected) == 1

    claimed_ids = sorted([r.event_id for r in claimed])
    assert claimed_ids == ["evt-1", "evt-2"]
    assert len(set(claimed_ids)) == 2

    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT COUNT(*) FROM notion_sync.sync_inbox WHERE status = 'processing'"
            )
            row = await cur.fetchone()
            assert row is not None and int(row[0]) == 2

    for cid in claimed_ids:
        row = await get_inbox_row(pool, cid)
        assert row is not None and row["attempts"] == 1


@pytest.mark.asyncio
async def test_inbox_repo_increments_attempts_on_claim_and_clears_locked_at_when_processed(
    pg_cluster,
):
    _, pool = pg_cluster
    await InboxRepository.enqueue_event(pool, sample_event("evt-1"))
    claimed = await InboxRepository.claim_next_event(pool)
    assert claimed is not None
    assert claimed.status == "processing"
    assert claimed.attempts == 1
    assert claimed.locked_at is not None

    async with pool.connection() as conn:
        await InboxRepository.settle_event_success(conn, "evt-1")

    row = await get_inbox_row(pool, "evt-1")
    assert row is not None
    assert row["status"] == "processed"
    assert row["attempts"] == 1
    assert row["locked_at"] is None
    assert row["processed_at"] is not None


@pytest.mark.asyncio
async def test_inbox_repo_schedules_retry_with_future_available_at_and_sanitized_error(pg_cluster):
    _, pool = pg_cluster
    await InboxRepository.enqueue_event(pool, sample_event("evt-1"))
    await InboxRepository.claim_next_event(pool)
    available_at = datetime.now(UTC) + timedelta(seconds=60)

    await InboxRepository.settle_event_retryable(pool, "evt-1", available_at, "try again")

    row = await get_inbox_row(pool, "evt-1")
    assert row is not None
    assert row["status"] == "pending"
    assert row["locked_at"] is None
    assert row["last_error"] == "try again"
    assert abs((row["available_at"] - available_at).total_seconds()) < 1.0


@pytest.mark.asyncio
async def test_inbox_repo_marks_permanent_failure_as_failed(pg_cluster):
    _, pool = pg_cluster
    await InboxRepository.enqueue_event(pool, sample_event("evt-1"))
    await InboxRepository.claim_next_event(pool)

    await InboxRepository.settle_event_failed(pool, "evt-1", "403 from Notion")

    row = await get_inbox_row(pool, "evt-1")
    assert row is not None
    assert row["status"] == "failed"
    assert row["last_error"] == "403 from Notion"

    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) FROM notion_sync.sync_inbox WHERE status = 'failed'")
            row_count = await cur.fetchone()
            assert row_count is not None and int(row_count[0]) == 1


@pytest.mark.asyncio
async def test_inbox_repo_recovers_stuck_lease(pg_cluster):
    _, pool = pg_cluster
    await InboxRepository.enqueue_event(pool, sample_event("evt-1"))
    await InboxRepository.claim_next_event(pool)
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE notion_sync.sync_inbox SET locked_at = NOW() - INTERVAL '10 minutes' WHERE event_id = 'evt-1'"
        )

    recovered = await InboxRepository.recover_stuck_events(pool, 300)
    assert recovered == 1

    row = await get_inbox_row(pool, "evt-1")
    assert row is not None
    assert row["status"] == "pending"
    assert row["locked_at"] is None
    assert row["attempts"] == 1


@pytest.mark.asyncio
async def test_inbox_repo_requeues_failed_events_for_operator(pg_cluster):
    _, pool = pg_cluster
    await InboxRepository.enqueue_event(pool, sample_event("evt-1"))
    await InboxRepository.claim_next_event(pool)
    await InboxRepository.settle_event_failed(pool, "evt-1", "old error")

    retried = await InboxRepository.retry_failed_events(pool)
    assert retried == 1

    row = await get_inbox_row(pool, "evt-1")
    assert row is not None
    assert row["status"] == "pending"
    assert row["attempts"] == 0
    assert row["last_error"] == "old error"


@pytest.mark.asyncio
async def test_inbox_repo_does_not_claim_future_available_at_events(pg_cluster):
    _, pool = pg_cluster
    await InboxRepository.enqueue_event(pool, sample_event("evt-1"))
    await InboxRepository.claim_next_event(pool)
    future_time = datetime.now(UTC) + timedelta(hours=1)
    await InboxRepository.settle_event_retryable(pool, "evt-1", future_time, "later")

    assert await InboxRepository.claim_next_event(pool) is None


# --- transaction boundary tests (2 tests) ---


@pytest.mark.asyncio
async def test_transaction_boundary_rolls_back_task_and_inbox_together(pg_cluster):
    _, pool = pg_cluster
    await InboxRepository.enqueue_event(
        pool, sample_event("evt-1", entity_id=sample_task().notion_page_id)
    )
    await InboxRepository.claim_next_event(pool)

    async def fail_fn(conn):
        await TasksRepository.upsert_task(conn, sample_task())
        await InboxRepository.settle_event_success(conn, "evt-1")
        raise RuntimeError("simulated crash before commit")

    with pytest.raises(Exception, match="simulated crash before commit"):
        await with_transaction(pool, fail_fn)

    assert await count_tasks(pool) == 0
    row = await get_inbox_row(pool, "evt-1")
    assert row is not None
    assert row["status"] == "processing"


@pytest.mark.asyncio
async def test_transaction_boundary_commits_task_and_inbox_together_on_success(pg_cluster):
    _, pool = pg_cluster
    await InboxRepository.enqueue_event(
        pool, sample_event("evt-1", entity_id=sample_task().notion_page_id)
    )
    await InboxRepository.claim_next_event(pool)

    async def ok_fn(conn):
        await TasksRepository.upsert_task(conn, sample_task())
        await InboxRepository.settle_event_success(conn, "evt-1")

    await with_transaction(pool, ok_fn)

    assert await count_tasks(pool) == 1
    row = await get_inbox_row(pool, "evt-1")
    assert row is not None
    assert row["status"] == "processed"


# --- runs-repo tests (3 tests) ---


@pytest.mark.asyncio
async def test_runs_repo_records_lifecycle_and_cursor(pg_cluster):
    _, pool = pg_cluster
    run_id = await RunsRepository.start_run(pool, "initial_backfill")
    assert isinstance(run_id, int)

    running = await get_run_row(pool, run_id)
    assert running is not None
    assert running["run_type"] == "initial_backfill"
    assert running["status"] == "running"

    await RunsRepository.finish_run(pool, run_id, "succeeded", 12, None, "cursor-final")

    finished = await get_run_row(pool, run_id)
    assert finished is not None
    assert finished["run_type"] == "initial_backfill"
    assert finished["status"] == "succeeded"
    assert finished["records_processed"] == 12
    assert finished["cursor_reached"] == "cursor-final"
    assert finished["finished_at"] is not None


@pytest.mark.asyncio
async def test_runs_repo_records_partial_and_failed_runs_truthfully(pg_cluster):
    _, pool = pg_cluster
    partial_id = await RunsRepository.start_run(pool, "reconciliation")
    await RunsRepository.finish_run(pool, partial_id, "partial", 4, "query_result_limit_reached")

    failed_id = await RunsRepository.start_run(pool, "manual_retry")
    await RunsRepository.finish_run(pool, failed_id, "failed", 0, "403 from Notion")

    row_partial = await get_run_row(pool, partial_id)
    row_failed = await get_run_row(pool, failed_id)
    assert row_partial is not None and row_partial["status"] == "partial"
    assert row_failed is not None and row_failed["status"] == "failed"
    assert row_failed["error_message"] == "403 from Notion"


@pytest.mark.asyncio
async def test_runs_repo_returns_most_recent_run_for_type(pg_cluster):
    _, pool = pg_cluster
    first = await RunsRepository.start_run(pool, "reconciliation")
    await RunsRepository.finish_run(pool, first, "succeeded", 1)
    await asyncio.sleep(0.02)
    second = await RunsRepository.start_run(pool, "reconciliation")
    await RunsRepository.finish_run(pool, second, "succeeded", 2)

    latest = await RunsRepository.get_latest_run(pool, "reconciliation")
    assert latest is not None
    assert latest.run_id == second
