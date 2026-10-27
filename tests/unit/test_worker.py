"""Unit tests for background worker and event processing."""

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import validate_config
from app.db.inbox_repo import InboxEventRecord, InboxRepository
from app.db.tasks_repo import TasksRepository
from app.errors import NotionApiError
from app.sync.worker import WorkerOptions, process_next_event


class MockConnection:
    def __init__(self) -> None:
        self.statements: list[str] = []
        self.execute = AsyncMock(side_effect=self._record_execute)

    async def _record_execute(self, query: str, *args, **kwargs) -> MagicMock:
        self.statements.append(str(query))
        return MagicMock()

    @asynccontextmanager
    async def transaction(self):
        self.statements.append("BEGIN")
        try:
            yield self
            self.statements.append("COMMIT")
        except Exception:
            self.statements.append("ROLLBACK")
            raise


class MockPool:
    def __init__(self, mock_conn: MockConnection | None = None) -> None:
        self.mock_conn = mock_conn or MockConnection()

    @asynccontextmanager
    async def connection(self):
        yield self.mock_conn


def make_event(
    event_id: str = "evt_default",
    event_type: str = "page.properties_updated",
    entity_id: str | None = "page_default",
    attempts: int = 1,
) -> InboxEventRecord:
    now = datetime.now(UTC)
    return InboxEventRecord(
        event_id=event_id,
        event_type=event_type,
        entity_id=entity_id,
        entity_type="page",
        event_timestamp=now,
        payload={},
        status="processing",
        attempts=attempts,
        received_at=now,
        available_at=now,
        locked_at=now,
        processed_at=None,
        last_error=None,
    )


@pytest.fixture
def test_config():
    return validate_config(
        {
            "NODE_ENV": "test",
            "SYNC_MAX_ATTEMPTS": "3",
        }
    )


@pytest.mark.asyncio
async def test_processes_page_properties_updated_event(test_config) -> None:
    event = make_event("evt_prop_1", "page.properties_updated", "page_123", attempts=1)

    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds_test_123")
    mock_client.fetch_page = AsyncMock(
        return_value={
            "id": "page_123",
            "properties": {"Task": {"type": "title", "title": [{"plain_text": "Updated Title"}]}},
        }
    )
    mock_client.fetch_page_blocks = AsyncMock(return_value=[])

    pool = MockPool()

    with (
        patch.object(
            InboxRepository, "claim_next_event", new_callable=AsyncMock, return_value=event
        ),
        patch.object(TasksRepository, "upsert_task", new_callable=AsyncMock) as upsert_spy,
        patch.object(InboxRepository, "settle_event_success", new_callable=AsyncMock) as settle_spy,
    ):
        result = await process_next_event(
            WorkerOptions(client=mock_client, pool=pool, config=test_config)  # type: ignore
        )

        assert result is True
        mock_client.fetch_page.assert_called_once_with("page_123")
        assert upsert_spy.call_count == 1
        record = upsert_spy.call_args[0][1]
        assert record.page_content_json == []
        settle_spy.assert_called_once()
        assert settle_spy.call_args[0][1] == "evt_prop_1"


@pytest.mark.asyncio
async def test_processes_page_deleted_event_without_fetch_page(test_config) -> None:
    event = make_event("evt_del_1", "page.deleted", "page_deleted_123", attempts=1)

    mock_client = MagicMock()
    mock_client.fetch_page = AsyncMock()

    pool = MockPool()

    with (
        patch.object(
            InboxRepository, "claim_next_event", new_callable=AsyncMock, return_value=event
        ),
        patch.object(TasksRepository, "mark_task_in_trash", new_callable=AsyncMock) as trash_spy,
        patch.object(InboxRepository, "settle_event_success", new_callable=AsyncMock) as settle_spy,
    ):
        result = await process_next_event(
            WorkerOptions(client=mock_client, pool=pool, config=test_config)  # type: ignore
        )

        assert result is True
        mock_client.fetch_page.assert_not_called()
        trash_spy.assert_called_once()
        assert trash_spy.call_args[0][1] == "page_deleted_123"
        settle_spy.assert_called_once()
        assert settle_spy.call_args[0][1] == "evt_del_1"


@pytest.mark.asyncio
async def test_handles_transient_failure_by_settling_as_retryable(test_config) -> None:
    event = make_event("evt_transient_1", "page.properties_updated", "page_err", attempts=1)

    mock_client = MagicMock()
    mock_client.fetch_page = AsyncMock(
        side_effect=NotionApiError("Notion rate limited", status=429, retry_after_seconds=5)
    )

    pool = MockPool()

    with (
        patch.object(
            InboxRepository, "claim_next_event", new_callable=AsyncMock, return_value=event
        ),
        patch.object(
            InboxRepository, "settle_event_retryable", new_callable=AsyncMock
        ) as retry_spy,
    ):
        result = await process_next_event(
            WorkerOptions(client=mock_client, pool=pool, config=test_config)  # type: ignore
        )

        assert result is True
        assert retry_spy.call_count == 1
        args = retry_spy.call_args[0]
        assert args[1] == "evt_transient_1"
        assert "rate limited" in args[3]


@pytest.mark.asyncio
async def test_handles_permanent_failure_by_settling_as_failed(test_config) -> None:
    event = make_event("evt_perm_1", "page.properties_updated", "page_bad", attempts=1)

    mock_client = MagicMock()
    mock_client.fetch_page = AsyncMock(side_effect=NotionApiError("Invalid query", status=400))

    pool = MockPool()

    with (
        patch.object(
            InboxRepository, "claim_next_event", new_callable=AsyncMock, return_value=event
        ),
        patch.object(InboxRepository, "settle_event_failed", new_callable=AsyncMock) as failed_spy,
    ):
        result = await process_next_event(
            WorkerOptions(client=mock_client, pool=pool, config=test_config)  # type: ignore
        )

        assert result is True
        assert failed_spy.call_count == 1
        args = failed_spy.call_args[0]
        assert args[1] == "evt_perm_1"
        assert "Invalid query" in args[2]


@pytest.mark.asyncio
async def test_marks_event_failed_when_attempts_reach_max_attempts_exhausted(test_config) -> None:
    event = make_event("evt_exhausted_1", "page.properties_updated", "page_err", attempts=3)

    mock_client = MagicMock()
    mock_client.fetch_page = AsyncMock(
        side_effect=NotionApiError("Service unavailable", status=503)
    )

    pool = MockPool()

    with (
        patch.object(
            InboxRepository, "claim_next_event", new_callable=AsyncMock, return_value=event
        ),
        patch.object(InboxRepository, "settle_event_failed", new_callable=AsyncMock) as failed_spy,
    ):
        result = await process_next_event(
            WorkerOptions(client=mock_client, pool=pool, config=test_config)  # type: ignore
        )

        assert result is True
        assert failed_spy.call_count == 1
        args = failed_spy.call_args[0]
        assert args[1] == "evt_exhausted_1"
        assert "Exhausted after 3 attempts" in args[2]


@pytest.mark.asyncio
async def test_resolves_data_source_once_and_computes_is_in_source_bug_001() -> None:
    config = validate_config(
        {
            "NODE_ENV": "test",
            "NOTION_DATABASE_ID": "11111111-1111-1111-1111-111111111111",
            "NOTION_DATA_SOURCE_ID": "",
            "SYNC_MAX_ATTEMPTS": "3",
        }
    )

    event1 = make_event("evt_ds_1", "page.properties_updated", "page_ds_1")
    event2 = make_event("evt_ds_2", "page.properties_updated", "page_ds_2")

    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds-123")
    mock_client.fetch_page = AsyncMock(
        side_effect=lambda pid: {
            "id": pid,
            "parent": {"type": "data_source_id", "data_source_id": "ds-123"},
            "properties": {"Task": {"type": "title", "title": [{"plain_text": f"Task {pid}"}]}},
        }
    )
    mock_client.fetch_page_blocks = AsyncMock(return_value=[])

    pool = MockPool()
    options = WorkerOptions(client=mock_client, pool=pool, config=config)  # type: ignore

    with (
        patch.object(
            InboxRepository,
            "claim_next_event",
            new_callable=AsyncMock,
            side_effect=[event1, event2],
        ),
        patch.object(TasksRepository, "upsert_task", new_callable=AsyncMock) as upsert_spy,
        patch.object(InboxRepository, "settle_event_success", new_callable=AsyncMock),
    ):
        assert await process_next_event(options) is True
        assert await process_next_event(options) is True

        assert mock_client.resolve_data_source.call_count == 1
        assert upsert_spy.call_count == 2
        r1 = upsert_spy.call_args_list[0][0][1]
        r2 = upsert_spy.call_args_list[1][0][1]
        assert r1.is_in_source is True
        assert r2.is_in_source is True


@pytest.mark.asyncio
async def test_keeps_page_content_json_null_when_block_fetch_fails_bug_004(test_config) -> None:
    event = make_event("evt_blocks_1", "page.content_updated", "page_blocks_1")

    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds_test_123")
    mock_client.fetch_page = AsyncMock(
        return_value={
            "id": "page_blocks_1",
            "in_trash": False,
            "properties": {"Task": {"type": "title", "title": [{"plain_text": "Content task"}]}},
        }
    )
    mock_client.fetch_page_blocks = AsyncMock(
        side_effect=RuntimeError("blocks endpoint unavailable")
    )

    pool = MockPool()

    with (
        patch.object(
            InboxRepository, "claim_next_event", new_callable=AsyncMock, return_value=event
        ),
        patch.object(TasksRepository, "upsert_task", new_callable=AsyncMock) as upsert_spy,
        patch.object(InboxRepository, "settle_event_success", new_callable=AsyncMock) as settle_spy,
    ):
        result = await process_next_event(
            WorkerOptions(client=mock_client, pool=pool, config=test_config)  # type: ignore
        )

        assert result is True
        mock_client.fetch_page_blocks.assert_called_once_with("page_blocks_1")
        assert upsert_spy.call_count == 1
        record = upsert_spy.call_args[0][1]
        assert record.page_content_json is None
        settle_spy.assert_called_once()
        assert settle_spy.call_args[0][1] == "evt_blocks_1"


@pytest.mark.asyncio
async def test_treats_status_less_network_failures_as_retryable_bug_003(test_config) -> None:
    event = make_event("evt_net_1", "page.properties_updated", "page_net_1")

    net_err = ConnectionResetError("connect ECONNREFUSED 127.0.0.1:443")
    net_err.code = "ECONNREFUSED"  # type: ignore[attr-defined]

    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds_test_123")
    mock_client.fetch_page = AsyncMock(side_effect=net_err)

    pool = MockPool()

    with (
        patch.object(
            InboxRepository, "claim_next_event", new_callable=AsyncMock, return_value=event
        ),
        patch.object(
            InboxRepository, "settle_event_retryable", new_callable=AsyncMock
        ) as retry_spy,
        patch.object(InboxRepository, "settle_event_failed", new_callable=AsyncMock) as failed_spy,
    ):
        result = await process_next_event(
            WorkerOptions(client=mock_client, pool=pool, config=test_config)  # type: ignore
        )

        assert result is True
        assert retry_spy.call_count == 1
        args = retry_spy.call_args[0]
        assert args[1] == "evt_net_1"
        assert "ECONNREFUSED" in args[3]
        failed_spy.assert_not_called()


@pytest.mark.asyncio
async def test_rolls_back_when_event_settlement_fails_bug_007_inv_6(test_config) -> None:
    event = make_event("evt_info_1", "database.schema_updated", None)

    mock_client = MagicMock()
    pool = MockPool()

    with (
        patch.object(
            InboxRepository, "claim_next_event", new_callable=AsyncMock, return_value=event
        ),
        patch.object(
            InboxRepository,
            "settle_event_success",
            new_callable=AsyncMock,
            side_effect=RuntimeError("inbox write failed"),
        ),
        patch.object(InboxRepository, "settle_event_failed", new_callable=AsyncMock) as failed_spy,
    ):
        result = await process_next_event(
            WorkerOptions(client=mock_client, pool=pool, config=test_config)  # type: ignore
        )

        assert result is True
        stmts = pool.mock_conn.statements
        assert "BEGIN" in stmts
        assert "ROLLBACK" in stmts
        assert "COMMIT" not in stmts
        assert failed_spy.call_count == 1
        assert failed_spy.call_args[0][1] == "evt_info_1"
        assert "inbox write failed" in failed_spy.call_args[0][2]
