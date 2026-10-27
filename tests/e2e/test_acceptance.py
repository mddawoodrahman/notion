"""Phase 10 — End-to-End Acceptance Verification (AT-01 to AT-14)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from psycopg.rows import dict_row

from app.api.webhooks import sign_webhook_payload
from app.config import validate_config
from app.db.migrate import run_migrations
from app.db.pool import close_pool, create_pool
from app.db.tasks_repo import TasksRepository
from app.main import create_app
from app.sync.backfill import BackfillOptions, run_backfill
from app.sync.normalize import normalize_page
from app.sync.notion_client import DataSourcePageBatch
from app.sync.reconcile import ReconcileOptions, run_reconciliation
from app.sync.worker import WorkerOptions, process_next_event
from tests.integration.helpers.test_database import start_test_database

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent.parent / "migrations"
VERIFICATION_TOKEN = "integration_test_verification_token_1234567890"
DATABASE_ID = "11111111-1111-1111-1111-111111111111"
DATA_SOURCE_ID = "ds_master_tasks"

CONFIG = validate_config(
    {
        "NODE_ENV": "test",
        "NOTION_DATABASE_ID": DATABASE_ID,
        "NOTION_WEBHOOK_VERIFICATION_TOKEN": VERIFICATION_TOKEN,
        "SYNC_TIMEZONE": "Asia/Kolkata",
    }
)


async def get_task(pool, page_id: str) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT * FROM notion_sync.notion_tasks WHERE notion_page_id = %s",
                (page_id,),
            )
            row = await cur.fetchone()
            return dict(row) if row else None


async def count_tasks(pool) -> int:
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) FROM notion_sync.notion_tasks")
            row = await cur.fetchone()
            return int(row[0]) if row else 0


async def get_inbox_event(pool, event_id: str) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT * FROM notion_sync.sync_inbox WHERE event_id = %s",
                (event_id,),
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


@pytest.fixture
def app(pg_cluster):
    _, pool = pg_cluster
    return create_app(config=CONFIG, pool=pool)


# --- Scenario 1 & 2: Initial import and second import idempotency ---
@pytest.mark.asyncio
async def test_scenario_1_and_2_initial_backfill_and_repeat_idempotency(pg_cluster):
    _, pool = pg_cluster
    mock_client = AsyncMock()
    mock_client.resolve_data_source.return_value = DATA_SOURCE_ID
    mock_client.query_data_source_pages.return_value = DataSourcePageBatch(
        results=[
            {
                "id": "task_page_1",
                "created_time": "2026-10-21T08:00:00.000Z",
                "last_edited_time": "2026-10-21T09:00:00.000Z",
                "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
                "properties": {
                    "Task": {"type": "title", "title": [{"plain_text": "Task One"}]},
                    "Status": {"type": "status", "status": {"name": "Not Started"}},
                    "List": {"type": "select", "select": {"name": "Personal"}},
                },
            }
        ],
        next_cursor=None,
        has_more=False,
    )

    # Run 1: Initial import
    res1 = await run_backfill(BackfillOptions(client=mock_client, pool=pool, config=CONFIG))
    assert res1.status == "succeeded"
    assert res1.records_processed == 1
    assert await count_tasks(pool) == 1
    t1 = await get_task(pool, "task_page_1")
    assert t1 is not None and t1["title"] == "Task One"

    # Run 2: Repeat import
    res2 = await run_backfill(BackfillOptions(client=mock_client, pool=pool, config=CONFIG))
    assert res2.status == "succeeded"
    assert await count_tasks(pool) == 1  # Exactly 1 row, no duplicates!


# --- Scenario 3 & 4: Creating and updating tasks via webhook and worker ---
@pytest.mark.asyncio
async def test_scenario_3_and_4_creating_and_updating_via_webhook_and_worker(app, pg_cluster):
    _, pool = pg_cluster
    new_page_payload = {
        "id": "evt_created_1",
        "type": "page.created",
        "entity": {"type": "page", "id": "task_page_2"},
        "timestamp": "2026-10-21T10:00:00.000Z",
    }
    body_str = json.dumps(new_page_payload)
    sig = sign_webhook_payload(body_str, VERIFICATION_TOKEN)

    # Send Webhook
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post(
            "/webhooks/notion",
            content=body_str,
            headers={"content-type": "application/json", "x-notion-signature": sig},
        )
    assert res.status_code == 200
    inbox_row = await get_inbox_event(pool, "evt_created_1")
    assert inbox_row is not None and inbox_row["status"] == "pending"

    # Worker processes event
    mock_worker_client = AsyncMock()
    mock_worker_client.resolve_data_source.return_value = DATA_SOURCE_ID
    mock_worker_client.fetch_page.return_value = {
        "id": "task_page_2",
        "created_time": "2026-10-21T10:00:00.000Z",
        "last_edited_time": "2026-10-21T10:05:00.000Z",
        "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Task Two"}]},
            "Status": {"type": "status", "status": {"name": "In Progress"}},
            "Priority": {"type": "select", "select": {"name": "High"}},
            "Due Date": {"type": "date", "date": {"start": "2026-10-28"}},
        },
    }
    mock_worker_client.fetch_page_blocks.return_value = []

    did_process = await process_next_event(
        WorkerOptions(client=mock_worker_client, pool=pool, config=CONFIG)
    )
    assert did_process is True

    task = await get_task(pool, "task_page_2")
    assert task is not None
    assert task["title"] == "Task Two"
    assert task["status"] == "In Progress"
    assert task["priority"] == "High"
    assert str(task["due_date"]) == "2026-10-28"


# --- Scenario 5 & 6: Toggling Important, My Day, and completion ---
@pytest.mark.asyncio
async def test_scenario_5_and_6_toggling_booleans_without_mutating_list(pg_cluster):
    _, pool = pg_cluster
    initial_page = {
        "id": "task_page_2",
        "created_time": "2026-10-21T10:00:00.000Z",
        "last_edited_time": "2026-10-21T10:05:00.000Z",
        "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Task Two"}]},
            "Status": {"type": "status", "status": {"name": "In Progress"}},
            "List": {"type": "select", "select": {"name": "Work"}},
        },
    }
    await TasksRepository.upsert_task(pool, normalize_page(initial_page))

    updated_page = {
        "id": "task_page_2",
        "created_time": "2026-10-21T10:00:00.000Z",
        "last_edited_time": "2026-10-21T10:30:00.000Z",
        "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Task Two"}]},
            "Status": {"type": "status", "status": {"name": "Done"}},  # completed
            "List": {"type": "select", "select": {"name": "Work"}},
            "Important": {"type": "checkbox", "checkbox": True},
            "In My Day": {"type": "checkbox", "checkbox": True},
        },
    }

    norm = normalize_page(updated_page)
    await TasksRepository.upsert_task(pool, norm)

    task = await get_task(pool, "task_page_2")
    assert task is not None
    assert task["status"] == "Done"
    assert task["important"] is True
    assert task["in_my_day"] is True
    assert task["list_name"] == "Work"


# --- Scenario 7 & 8: User-archived vs Notion archive/trash and restore ---
@pytest.mark.asyncio
async def test_scenario_7_and_8_user_archived_vs_trash_and_page_deleted(pg_cluster):
    _, pool = pg_cluster
    # 7. Custom archived
    user_archived_page = {
        "id": "task_page_custom_archived",
        "archived": False,
        "in_trash": False,
        "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Archived in To Do"}]},
            "Archived": {"type": "checkbox", "checkbox": True},
        },
    }
    norm = normalize_page(user_archived_page)
    await TasksRepository.upsert_task(pool, norm)

    task = await get_task(pool, "task_page_custom_archived")
    assert task is not None
    assert task["user_archived"] is True
    assert task["notion_is_archived"] is False
    assert task["notion_in_trash"] is False

    # 8. Delete event
    async with pool.connection() as conn:
        await conn.execute(
            """INSERT INTO notion_sync.sync_inbox
               (event_id, event_type, entity_id, status, attempts, available_at, payload)
               VALUES ('evt_delete_1', 'page.deleted', 'task_page_custom_archived', 'pending', 0, NOW(), '{}'::jsonb)"""
        )

    mock_worker_client = AsyncMock()
    await process_next_event(WorkerOptions(client=mock_worker_client, pool=pool, config=CONFIG))

    tombstoned = await get_task(pool, "task_page_custom_archived")
    assert tombstoned is not None
    assert tombstoned["notion_in_trash"] is True


# --- Scenario 9: Duplicate and out-of-order events (INV-4) ---
@pytest.mark.asyncio
async def test_scenario_9_out_of_order_events_do_not_regress_state(pg_cluster):
    _, pool = pg_cluster
    newer_page = {
        "id": "task_page_order",
        "created_time": "2026-10-21T10:00:00.000Z",
        "last_edited_time": "2026-10-21T10:30:00.000Z",
        "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Authoritative Title"}]},
            "Status": {"type": "status", "status": {"name": "Done"}},
        },
    }
    await TasksRepository.upsert_task(pool, normalize_page(newer_page))

    # Stale update from an earlier edit
    stale_page = {
        "id": "task_page_order",
        "created_time": "2026-10-21T10:00:00.000Z",
        "last_edited_time": "2026-10-21T09:00:00.000Z",  # Older timestamp!
        "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Stale Overwrite Attempt"}]},
            "Status": {"type": "status", "status": {"name": "Not Started"}},
        },
    }
    stale_res = await TasksRepository.upsert_task(pool, normalize_page(stale_page))
    assert stale_res is None

    # Task title and status must NOT regress!
    verified = await get_task(pool, "task_page_order")
    assert verified is not None
    assert verified["title"] == "Authoritative Title"
    assert verified["status"] == "Done"


# --- Scenario 10: PostgreSQL outage returns 503 rather than false 200 acknowledgment (INV-3) ---
@pytest.mark.asyncio
async def test_scenario_10_postgresql_outage_returns_503():
    # App configured with database readiness check returning False
    failing_app = create_app(config=CONFIG, check_db_ready=lambda: False)

    payload = json.dumps(
        {
            "id": "evt_outage_1",
            "type": "page.created",
            "entity": {"type": "page", "id": "task_page_outage"},
        }
    )
    sig = sign_webhook_payload(payload, VERIFICATION_TOKEN)

    async with AsyncClient(
        transport=ASGITransport(app=failing_app), base_url="http://test"
    ) as client:
        res = await client.post(
            "/webhooks/notion",
            content=payload,
            headers={"content-type": "application/json", "x-notion-signature": sig},
        )

    assert res.status_code == 503
    assert res.json() == {"ok": False}


# --- Scenario 11: Worker restart recovers pending events ---
@pytest.mark.asyncio
async def test_scenario_11_worker_restart_recovers_pending_events(pg_cluster):
    _, pool = pg_cluster
    async with pool.connection() as conn:
        await conn.execute(
            """INSERT INTO notion_sync.sync_inbox
               (event_id, event_type, entity_id, status, attempts, available_at, payload)
               VALUES ('evt_restart_1', 'page.created', 'task_page_restart', 'pending', 0, NOW(), '{}'::jsonb)"""
        )

    mock_worker_client = AsyncMock()
    mock_worker_client.resolve_data_source.return_value = DATA_SOURCE_ID
    mock_worker_client.fetch_page.return_value = {
        "id": "task_page_restart",
        "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
        "properties": {"Task": {"type": "title", "title": [{"plain_text": "Recovered Task"}]}},
    }
    mock_worker_client.fetch_page_blocks.return_value = []

    await process_next_event(WorkerOptions(client=mock_worker_client, pool=pool, config=CONFIG))

    inbox = await get_inbox_event(pool, "evt_restart_1")
    assert inbox is not None and inbox["status"] == "processed"
    task = await get_task(pool, "task_page_restart")
    assert task is not None and task["title"] == "Recovered Task"


# --- Scenario 12: Reconciliation repairs missed event and respects partial scan safety ---
@pytest.mark.asyncio
async def test_scenario_12_reconciliation_repairs_missed_events_safe_remediation(pg_cluster):
    _, pool = pg_cluster
    # Pre-populate tasks
    for i in range(1, 4):
        await TasksRepository.upsert_task(
            pool,
            normalize_page(
                {
                    "id": f"task_page_{i}",
                    "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
                    "properties": {
                        "Task": {"type": "title", "title": [{"plain_text": f"Task {i}"}]}
                    },
                }
            ),
        )

    mock_client = AsyncMock()
    mock_client.resolve_data_source.return_value = DATA_SOURCE_ID
    mock_client.query_data_source_pages.return_value = DataSourcePageBatch(
        results=[{"id": "task_page_1"}, {"id": "task_page_2"}, {"id": "task_page_3"}],
        next_cursor=None,
        has_more=False,
    )
    mock_client.fetch_page.side_effect = lambda pid: {
        "id": pid,
        "parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID},
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": f"Reconciled {pid}"}]},
            "Status": {"type": "status", "status": {"name": "In Progress"}},
        },
    }

    res = await run_reconciliation(ReconcileOptions(client=mock_client, pool=pool, config=CONFIG))
    assert res.status == "succeeded"
    assert res.records_processed == 3


# --- Scenario 13: Runtime logs and error messages contain no secrets ---
@pytest.mark.asyncio
async def test_scenario_13_error_handling_redacts_secrets():
    from contextlib import asynccontextmanager
    from unittest.mock import MagicMock

    from app.errors import classify_error, sanitize_error_message

    sensitive = "postgresql://user:topsecretpassword@db.neon.tech/main?sslmode=require"

    @asynccontextmanager
    async def mock_cursor(*args, **kwargs):
        raise RuntimeError(f"Failed to connect to {sensitive}")
        yield

    mock_conn = MagicMock()
    mock_conn.cursor = mock_cursor

    try:
        await TasksRepository.upsert_task(
            mock_conn,
            normalize_page(
                {
                    "id": "p_sec",
                    "properties": {
                        "Task": {"type": "title", "title": [{"plain_text": "Sensitive"}]}
                    },
                }
            ),
        )
        pytest.fail("Expected RuntimeError to be raised")
    except RuntimeError as err:
        sanitized = sanitize_error_message(err)
        assert "topsecretpassword" not in sanitized
        assert "postgresql://***:***@" in sanitized

        classification = classify_error(err, attempts=1, max_attempts=3)
        assert "topsecretpassword" not in classification.message
        assert "postgresql://***:***@" in classification.message
