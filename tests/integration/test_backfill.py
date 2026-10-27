"""Integration tests for initial backfill against real PostgreSQL (mocked Notion)."""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from psycopg.rows import dict_row

from app.config import validate_config
from app.db.migrate import run_migrations
from app.db.pool import close_pool, create_pool
from app.db.tasks_repo import TasksRepository
from app.sync.backfill import BackfillOptions, run_backfill
from app.sync.notion_client import DataSourcePageBatch
from tests.integration.helpers.test_database import start_test_database

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent.parent / "migrations"
DATA_SOURCE_ID = "11111111-1111-4111-8111-111111111111"
DATABASE_ID = "22222222-2222-4222-8222-222222222222"

CONFIG = validate_config(
    {
        "NODE_ENV": "test",
        "NOTION_DATABASE_ID": DATABASE_ID,
        "SYNC_PAGE_SIZE": "2",
        "SYNC_SYNC_BODY_CONTENT": "false",
    }
)


def make_page(page_id: str, text: str, **overrides: Any) -> dict[str, Any]:
    defaults = {
        "id": page_id,
        "url": f"https://www.notion.so/{page_id}",
        "created_time": "2026-10-01T00:00:00.000Z",
        "last_edited_time": "2026-10-20T00:00:00.000Z",
        "in_trash": False,
        "archived": False,
        "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
        "properties": {"Task": {"type": "title", "title": [{"plain_text": text}]}},
    }
    defaults.update(overrides)
    return defaults


def create_fake_client(batches: list[DataSourcePageBatch]):
    mock_client = AsyncMock()
    mock_client.resolve_data_source.return_value = DATA_SOURCE_ID
    mock_client.query_data_source_pages.side_effect = batches
    return mock_client


async def count_table(pool, table: str) -> int:
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(f"SELECT COUNT(*) FROM notion_sync.{table}")
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


@pytest.mark.asyncio
async def test_imports_every_page_across_cursor_pages(pg_cluster):
    _, pool = pg_cluster
    fake_client = create_fake_client(
        [
            DataSourcePageBatch(
                results=[make_page("p1", "One"), make_page("p2", "Two")],
                next_cursor="cursor-2",
                has_more=True,
            ),
            DataSourcePageBatch(
                results=[make_page("p3", "Three")],
                next_cursor=None,
                has_more=False,
            ),
        ]
    )

    result = await run_backfill(BackfillOptions(client=fake_client, pool=pool, config=CONFIG))

    assert result.status == "succeeded"
    assert result.records_processed == 3
    assert result.page_failures == 0
    assert result.data_source_id == DATA_SOURCE_ID
    assert result.run_id is not None

    assert fake_client.query_data_source_pages.call_count == 2
    assert await count_table(pool, "notion_tasks") == 3

    p1 = await get_task_row(pool, "p1")
    assert p1 is not None and p1["title"] == "One"

    run = await get_run_row(pool, result.run_id)
    assert run is not None
    assert run["run_type"] == "initial_backfill"
    assert run["status"] == "succeeded"
    assert run["records_processed"] == 3
    assert isinstance(run["finished_at"], datetime)


@pytest.mark.asyncio
async def test_backfill_is_rerunnable_without_duplicates_at_02(pg_cluster):
    _, pool = pg_cluster
    batches = [
        DataSourcePageBatch(
            results=[make_page("p1", "One"), make_page("p2", "Two")],
            next_cursor=None,
            has_more=False,
        )
    ]

    client1 = create_fake_client(batches)
    await run_backfill(BackfillOptions(client=client1, pool=pool, config=CONFIG))
    before = await get_task_row(pool, "p1")

    await asyncio.sleep(0.02)

    client2 = create_fake_client(batches)
    result2 = await run_backfill(BackfillOptions(client=client2, pool=pool, config=CONFIG))
    after = await get_task_row(pool, "p1")

    assert result2.status == "succeeded"
    assert result2.records_processed == 2
    assert await count_table(pool, "notion_tasks") == 2
    assert after["synced_at"] > before["synced_at"]


@pytest.mark.asyncio
async def test_keeps_pages_moved_out_of_source_as_out_of_scope(pg_cluster):
    _, pool = pg_cluster
    batches = [
        DataSourcePageBatch(
            results=[
                make_page("p1", "In source"),
                make_page(
                    "p2",
                    "Moved",
                    parent={
                        "type": "data_source_id",
                        "data_source_id": "99999999-9999-4999-8999-999999999999",
                    },
                ),
            ],
            next_cursor=None,
            has_more=False,
        )
    ]

    client = create_fake_client(batches)
    await run_backfill(BackfillOptions(client=client, pool=pool, config=CONFIG))

    p1 = await get_task_row(pool, "p1")
    p2 = await get_task_row(pool, "p2")
    assert p1 is not None and p1["is_in_source"] is True
    assert p2 is not None and p2["is_in_source"] is False
    assert await count_table(pool, "notion_tasks") == 2


@pytest.mark.asyncio
async def test_supports_dry_run_writing_no_tasks_nor_run_row(pg_cluster):
    _, pool = pg_cluster
    batches = [
        DataSourcePageBatch(
            results=[make_page("p1", "One"), make_page("p2", "Two")],
            next_cursor=None,
            has_more=False,
        )
    ]

    client = create_fake_client(batches)
    result = await run_backfill(
        BackfillOptions(client=client, pool=pool, config=CONFIG, dry_run=True)
    )

    assert result.status == "succeeded"
    assert result.records_processed == 2
    assert result.page_failures == 0
    assert result.run_id is None
    assert client.query_data_source_pages.call_count == 1
    assert await count_table(pool, "notion_tasks") == 0
    assert await count_table(pool, "sync_runs") == 0


@pytest.mark.asyncio
async def test_records_per_page_failure_as_partial_with_sanitized_error(pg_cluster):
    _, pool = pg_cluster
    batches = [
        DataSourcePageBatch(
            results=[make_page("p1", "Good"), make_page("p2", "Bad")],
            next_cursor=None,
            has_more=False,
        )
    ]
    client = create_fake_client(batches)

    orig_upsert = TasksRepository.upsert_task

    async def mock_upsert(db, record):
        if record.notion_page_id == "p2":
            raise RuntimeError(
                "write failed for secret_abcdef1234567890 via postgresql://user:topsecret@db.example/app"
            )
        return await orig_upsert(db, record)

    with patch.object(TasksRepository, "upsert_task", side_effect=mock_upsert):
        result = await run_backfill(BackfillOptions(client=client, pool=pool, config=CONFIG))

    assert result.status == "partial"
    assert result.records_processed == 1
    assert result.page_failures == 1
    assert await count_table(pool, "notion_tasks") == 1

    run = await get_run_row(pool, result.run_id)
    assert run is not None
    assert run["status"] == "partial"
    assert run["records_processed"] == 1
    assert "secret_abcdef1234567890" not in (run["error_message"] or "")
    assert "topsecret" not in (run["error_message"] or "")
    assert "[REDACTED_NOTION_KEY]" in (run["error_message"] or "")


@pytest.mark.asyncio
async def test_records_aborted_scan_as_failed_and_keeps_cursor_reached(pg_cluster):
    _, pool = pg_cluster
    mock_client = AsyncMock()
    mock_client.resolve_data_source.return_value = DATA_SOURCE_ID
    mock_client.query_data_source_pages.side_effect = [
        DataSourcePageBatch(
            results=[make_page("p1", "One")],
            next_cursor="cursor-1",
            has_more=True,
        ),
        RuntimeError("Notion outage for secret_abcdef1234567890"),
    ]

    with pytest.raises(RuntimeError, match=r"Notion outage"):
        await run_backfill(BackfillOptions(client=mock_client, pool=pool, config=CONFIG))

    assert await count_table(pool, "notion_tasks") == 1

    run = await get_run_row(pool, 1)
    assert run is not None
    assert run["status"] == "failed"
    assert run["records_processed"] == 1
    assert run["cursor_reached"] == "cursor-1"
    assert "secret_abcdef1234567890" not in (run["error_message"] or "")
    assert "[REDACTED_NOTION_KEY]" in (run["error_message"] or "")
