"""Integration tests for database migrations against real PostgreSQL."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path

import pytest
from psycopg.errors import CheckViolation, UniqueViolation
from psycopg.rows import dict_row

from app.db.migrate import get_migration_status, run_migrations
from app.db.pool import close_pool, create_pool
from app.errors import DatabaseError
from tests.integration.helpers.test_database import start_test_database

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent.parent / "migrations"


@pytest.fixture(scope="module")
async def pg_cluster():
    database = await start_test_database()
    pool = create_pool(database.url, open_pool=False)
    await pool.open()
    first_run = await run_migrations(pool, MIGRATIONS_DIR)
    try:
        yield database, pool, first_run
    finally:
        await close_pool(pool)
        await database.stop()


@pytest.mark.asyncio
async def test_applies_0001_init_and_records_checksum(pg_cluster):
    _, _, first_run = pg_cluster
    assert len(first_run) == 1
    assert first_run[0].version == "0001_init.sql"
    assert first_run[0].applied is True
    assert re.match(r"^[0-9a-f]{64}$", first_run[0].checksum)


@pytest.mark.asyncio
async def test_reports_applied_migration_with_timestamp(pg_cluster):
    _, pool, _ = pg_cluster
    status = await get_migration_status(pool, MIGRATIONS_DIR)

    assert len(status) == 1
    assert status[0].version == "0001_init.sql"
    assert status[0].applied is True
    assert isinstance(status[0].applied_at, datetime)


@pytest.mark.asyncio
async def test_creates_v1_tables_and_ledger_only(pg_cluster):
    _, pool, _ = pg_cluster
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT table_name FROM information_schema.tables
                   WHERE table_schema = 'notion_sync' ORDER BY table_name"""
            )
            tables = [row[0] for row in await cur.fetchall()]
            assert tables == [
                "notion_tasks",
                "schema_migrations",
                "sync_inbox",
                "sync_runs",
            ]

            await cur.execute(
                """SELECT table_name FROM information_schema.tables
                   WHERE table_schema = 'notion_sync'
                     AND table_name IN ('task_events','daily_task_snapshots','task_analytics')"""
            )
            forbidden = await cur.fetchall()
            assert forbidden == []


@pytest.mark.asyncio
async def test_uses_date_for_date_only_and_jsonb_for_raw_properties(pg_cluster):
    _, pool, _ = pg_cluster
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT column_name, data_type FROM information_schema.columns
                   WHERE table_schema = 'notion_sync' AND table_name = 'notion_tasks'"""
            )
            by_name = {row[0]: row[1] for row in await cur.fetchall()}

    assert by_name["due_date"] == "date"
    assert by_name["due_at"] == "timestamp with time zone"
    assert by_name["reminder_at"] == "timestamp with time zone"
    assert by_name["raw_properties"] == "jsonb"
    assert by_name["page_content_json"] == "jsonb"
    assert by_name["notion_page_id"] == "text"


@pytest.mark.asyncio
async def test_creates_queue_and_lookup_indexes(pg_cluster):
    _, pool, _ = pg_cluster
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT indexname FROM pg_indexes
                   WHERE schemaname = 'notion_sync' ORDER BY indexname"""
            )
            names = [row[0] for row in await cur.fetchall()]

    for expected in [
        "notion_tasks_in_scope_idx",
        "notion_tasks_synced_at_idx",
        "notion_tasks_due_date_idx",
        "sync_inbox_claim_idx",
        "sync_inbox_lease_idx",
        "sync_inbox_failed_idx",
        "sync_inbox_entity_idx",
        "sync_runs_type_started_idx",
    ]:
        assert expected in names


@pytest.mark.asyncio
async def test_rejects_illegal_states_at_database_layer(pg_cluster):
    _, pool, _ = pg_cluster
    async with pool.connection() as conn:
        # Invalid status check violation
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    """INSERT INTO notion_sync.sync_inbox (event_id, event_type, payload, status)
                       VALUES ('evt-bad-status', 'page.created', '{}'::jsonb, 'bogus')"""
                )

        # Negative attempts check violation
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    """INSERT INTO notion_sync.sync_inbox (event_id, event_type, payload, attempts)
                       VALUES ('evt-negative', 'page.created', '{}'::jsonb, -1)"""
                )

        # Duplicate event_id unique violation
        with pytest.raises(UniqueViolation):
            async with conn.transaction():
                await conn.execute(
                    """INSERT INTO notion_sync.sync_inbox (event_id, event_type, payload)
                       VALUES ('evt-dup', 'page.created', '{}'::jsonb),
                              ('evt-dup', 'page.created', '{}'::jsonb)"""
                )

        # Illegal run_type check violation
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    """INSERT INTO notion_sync.sync_runs (run_type, status)
                       VALUES ('productivity_report', 'succeeded')"""
                )

        # Empty notion_page_id check violation
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    "INSERT INTO notion_sync.notion_tasks (notion_page_id) VALUES ('')"
                )


@pytest.mark.asyncio
async def test_keeps_date_only_deadline_as_unshifted_date(pg_cluster):
    _, pool, _ = pg_cluster
    async with pool.connection() as conn:
        await conn.execute(
            """INSERT INTO notion_sync.notion_tasks (notion_page_id, title, due_date)
               VALUES ('page-date', 'Date task', %s::date)
               ON CONFLICT (notion_page_id) DO UPDATE SET due_date = EXCLUDED.due_date""",
            ("2026-10-21",),
        )

        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT to_char(due_date, 'YYYY-MM-DD') AS due_date
                   FROM notion_sync.notion_tasks WHERE notion_page_id = 'page-date'"""
            )
            row = await cur.fetchone()
            assert row is not None and row[0] == "2026-10-21"


@pytest.mark.asyncio
async def test_stores_time_bearing_timestamps_and_unknown_json_losslessly(pg_cluster):
    _, pool, _ = pg_cluster
    raw = {
        "Name": {"type": "title", "title": [{"plain_text": "Task"}]},
        "Some New Property": {"type": "verification", "verification": {"state": "verified"}},
        "Numbers": {"type": "number", "number": 42.5},
    }

    async with pool.connection() as conn:
        await conn.execute(
            """INSERT INTO notion_sync.notion_tasks
                 (notion_page_id, title, due_at, raw_properties, page_content_json)
               VALUES ('page-json', 'JSON task', %s::timestamptz, %s::jsonb, %s::jsonb)
               ON CONFLICT (notion_page_id) DO UPDATE SET
                 due_at = EXCLUDED.due_at,
                 raw_properties = EXCLUDED.raw_properties,
                 page_content_json = EXCLUDED.page_content_json""",
            (
                "2026-10-21T23:30:00+14:00",
                json.dumps(raw),
                json.dumps([{"type": "paragraph"}]),
            ),
        )

        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """SELECT due_at, raw_properties, page_content_json
                   FROM notion_sync.notion_tasks WHERE notion_page_id = 'page-json'"""
            )
            row = await cur.fetchone()
            assert row is not None
            assert row["due_at"] == datetime(2026, 10, 21, 9, 30, tzinfo=UTC)
            assert row["raw_properties"] == raw
            assert row["page_content_json"] == [{"type": "paragraph"}]


@pytest.mark.asyncio
async def test_rerunning_migrations_is_noop(pg_cluster):
    _, pool, first_run = pg_cluster
    second = await run_migrations(pool, MIGRATIONS_DIR)

    assert len(second) == 1
    assert second[0].version == "0001_init.sql"
    assert second[0].applied is False
    assert second[0].checksum == first_run[0].checksum

    status = await get_migration_status(pool, MIGRATIONS_DIR)
    applied = [s for s in status if s.applied]
    assert len(applied) == 1


@pytest.mark.asyncio
async def test_detects_checksum_drift_instead_of_silently_reapplying(pg_cluster):
    _, pool, _ = pg_cluster
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE notion_sync.schema_migrations SET checksum = 'deadbeef' WHERE version = '0001_init.sql'"
        )

    with pytest.raises(DatabaseError, match=r"checksum mismatch"):
        await run_migrations(pool, MIGRATIONS_DIR)
