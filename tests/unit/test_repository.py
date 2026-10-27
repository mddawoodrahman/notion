"""Unit tests for idempotent repository SQL and query logic."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.db.inbox_repo import InboxEventInput, InboxRepository
from app.db.runs_repo import RunsRepository
from app.db.tasks_repo import NormalizedTaskRecord, TasksRepository


@pytest.fixture
def sample_task() -> NormalizedTaskRecord:
    return NormalizedTaskRecord(
        notion_page_id="test-page-1234",
        title="Verify Idempotency",
        status="Done",
        list_name="QA",
        important=True,
        in_my_day=False,
        priority="Urgent",
        due_date="2026-10-25",
        due_at=None,
        reminder_at=None,
        user_archived=False,
        notion_is_archived=False,
        notion_in_trash=False,
        is_in_source=True,
        page_url="https://notion.so/test",
        notion_created_time="2026-10-21T10:00:00.000Z",
        notion_last_edited_time="2026-10-21T12:00:00.000Z",
        raw_properties={"foo": "bar"},
        page_content_json=[{"type": "paragraph"}],
        synced_at="2026-10-21T12:05:00.000Z",
    )


def test_upsert_task_sql_contains_inv_4_guard_and_coalesce_safeguards() -> None:
    query = TasksRepository.UPSERT_QUERY

    assert "INSERT INTO notion_sync.notion_tasks" in query
    assert "ON CONFLICT (notion_page_id) DO UPDATE SET" in query
    assert (
        "EXCLUDED.notion_last_edited_time >= notion_sync.notion_tasks.notion_last_edited_time"
        in query
    )

    # BUG-004: null incoming content must never wipe stored content
    assert "COALESCE(%(page_content_json)s::jsonb, '[]'::jsonb)" in query
    assert (
        "page_content_json       = COALESCE(%(page_content_json)s::jsonb, notion_sync.notion_tasks.page_content_json)"
        in query
    )
    # BUG-008: a null incoming timestamp must not be an unconditional overwrite
    assert "OR EXCLUDED.notion_last_edited_time IS NULL" not in query


def test_prepare_params_passes_none_for_unfetched_page_content_bug_004(sample_task) -> None:
    # 1. Un-fetched content: None -> None in prepared dict
    sample_dict = sample_task.__dict__.copy()
    sample_dict["page_content_json"] = None
    params1 = TasksRepository._prepare_params(sample_dict)
    assert params1["page_content_json"] is None

    # 2. Fetched empty list: [] -> "[]" in prepared dict
    sample_dict["page_content_json"] = []
    params2 = TasksRepository._prepare_params(sample_dict)
    assert params2["page_content_json"] == "[]"


@pytest.mark.asyncio
async def test_enqueue_event_detects_duplicates_idempotently() -> None:
    # 1. First delivery (inserted)
    cursor_mock_1 = AsyncMock()
    cursor_mock_1.rowcount = 1
    cursor_mock_1.fetchone.return_value = {"event_id": "evt_123"}
    conn_mock_1 = MagicMock()
    conn_mock_1.cursor.return_value.__aenter__.return_value = cursor_mock_1

    res1 = await InboxRepository.enqueue_event(
        conn_mock_1,
        InboxEventInput(
            event_id="evt_123",
            event_type="page.properties_updated",
            payload={"hello": "world"},
        ),
    )
    assert res1.is_duplicate is False

    # 2. Duplicate delivery (rowcount 0)
    cursor_mock_2 = AsyncMock()
    cursor_mock_2.rowcount = 0
    cursor_mock_2.fetchone.return_value = None
    conn_mock_2 = MagicMock()
    conn_mock_2.cursor.return_value.__aenter__.return_value = cursor_mock_2

    res2 = await InboxRepository.enqueue_event(
        conn_mock_2,
        InboxEventInput(
            event_id="evt_123",
            event_type="page.properties_updated",
            payload={"hello": "world"},
        ),
    )
    assert res2.is_duplicate is True


@pytest.mark.asyncio
async def test_claim_next_event_uses_for_update_skip_locked() -> None:
    captured_query = ""

    async def _execute(query, *args, **kwargs):
        nonlocal captured_query
        captured_query = str(query)

    cursor_mock = AsyncMock()
    cursor_mock.execute = _execute
    cursor_mock.fetchone.return_value = {
        "event_id": "evt_claim_1",
        "event_type": "page.created",
        "entity_type": "page",
        "entity_id": "page_1",
        "event_timestamp": None,
        "payload": {},
        "status": "processing",
        "attempts": 1,
        "received_at": None,
        "available_at": None,
        "locked_at": None,
        "processed_at": None,
        "last_error": None,
    }

    conn_mock = MagicMock()
    conn_mock.cursor.return_value.__aenter__.return_value = cursor_mock

    event = await InboxRepository.claim_next_event(conn_mock)
    assert event is not None
    assert event.event_id == "evt_claim_1"
    assert "FOR UPDATE SKIP LOCKED" in captured_query
    assert "attempts  = i.attempts + 1" in captured_query


@pytest.mark.asyncio
async def test_runs_repository_records_lifecycle_correctly() -> None:
    cursor_mock = AsyncMock()
    cursor_mock.fetchone.return_value = (42,)

    conn_mock = MagicMock()
    conn_mock.cursor.return_value.__aenter__.return_value = cursor_mock
    conn_mock.execute = AsyncMock()

    run_id = await RunsRepository.start_run(conn_mock, "initial_backfill")
    assert run_id == 42

    await RunsRepository.finish_run(conn_mock, run_id, "succeeded", 150)
    assert conn_mock.execute.call_count == 1
