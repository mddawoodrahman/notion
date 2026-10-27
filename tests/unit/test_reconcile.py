"""Unit tests for reconciliation and operations (INV-5 protection)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import validate_config
from app.db.runs_repo import RunsRepository
from app.db.tasks_repo import TasksRepository
from app.sync.notion_client import DataSourcePageBatch
from app.sync.reconcile import ReconcileOptions, run_reconciliation


@pytest.fixture
def test_config():
    return validate_config(
        {
            "NODE_ENV": "test",
            "NOTION_DATABASE_ID": "11111111-1111-1111-1111-111111111111",
        }
    )


@pytest.mark.asyncio
async def test_complete_scan_with_0_failures_updates_tasks_and_remediates(test_config) -> None:
    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds_rec_1")
    mock_client.query_data_source_pages = AsyncMock(
        return_value=DataSourcePageBatch(
            results=[{"id": "page_active_1"}, {"id": "page_active_2"}],
            next_cursor=None,
            has_more=False,
        )
    )
    mock_client.fetch_page = AsyncMock(
        side_effect=lambda pid: {
            "id": pid,
            "properties": {"Task": {"type": "title", "title": [{"plain_text": f"Task {pid}"}]}},
        }
    )

    mock_pool = MagicMock()

    with (
        patch.object(TasksRepository, "upsert_task", new_callable=AsyncMock) as upsert_spy,
        patch.object(
            TasksRepository, "mark_tasks_out_of_source", new_callable=AsyncMock, return_value=1
        ) as out_of_source_spy,
        patch.object(RunsRepository, "start_run", new_callable=AsyncMock, return_value=201),
        patch.object(RunsRepository, "finish_run", new_callable=AsyncMock) as finish_run_spy,
    ):
        result = await run_reconciliation(
            ReconcileOptions(
                client=mock_client,
                pool=mock_pool,
                config=test_config,
                dry_run=False,
            )
        )

        assert result.status == "succeeded"
        assert result.records_processed == 2
        assert result.page_failures == 0
        assert result.remediated_outdated == 1

        assert upsert_spy.call_count == 2
        out_of_source_spy.assert_called_once()
        passed_ids = set(out_of_source_spy.call_args[0][1])
        assert passed_ids == {"page_active_1", "page_active_2"}
        finish_run_spy.assert_called_once_with(mock_pool, 201, "succeeded", 2, None, None)


@pytest.mark.asyncio
async def test_partial_scan_with_page_failure_never_triggers_remediation_inv_5(test_config) -> None:
    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds_rec_1")
    mock_client.query_data_source_pages = AsyncMock(
        return_value=DataSourcePageBatch(
            results=[{"id": "page_good"}, {"id": "page_bad"}],
            next_cursor=None,
            has_more=False,
        )
    )

    async def _fetch(pid: str):
        if pid == "page_bad":
            raise RuntimeError("Temporary network timeout")
        return {
            "id": pid,
            "properties": {"Task": {"type": "title", "title": [{"plain_text": "Good Task"}]}},
        }

    mock_client.fetch_page = AsyncMock(side_effect=_fetch)
    mock_pool = MagicMock()

    with (
        patch.object(TasksRepository, "upsert_task", new_callable=AsyncMock),
        patch.object(
            TasksRepository, "mark_tasks_out_of_source", new_callable=AsyncMock
        ) as out_of_source_spy,
        patch.object(RunsRepository, "start_run", new_callable=AsyncMock, return_value=202),
        patch.object(RunsRepository, "finish_run", new_callable=AsyncMock) as finish_run_spy,
    ):
        result = await run_reconciliation(
            ReconcileOptions(
                client=mock_client,
                pool=mock_pool,
                config=test_config,
                dry_run=False,
            )
        )

        assert result.status == "partial"
        assert result.records_processed == 1
        assert result.page_failures == 1
        # Crucial invariant: out-of-source remediation MUST NOT RUN on partial scan!
        out_of_source_spy.assert_not_called()

        finish_run_spy.assert_called_once()
        args = finish_run_spy.call_args[0]
        assert args[1] == 202
        assert args[2] == "partial"
        assert args[3] == 1
        assert "Temporary network timeout" in args[4]


@pytest.mark.asyncio
async def test_incomplete_notion_query_result_set_never_remediates_bug_002_inv_5(
    test_config,
) -> None:
    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds_rec_1")
    mock_client.query_data_source_pages = AsyncMock(
        return_value=DataSourcePageBatch(
            results=[{"id": "page_active_1"}],
            next_cursor=None,
            has_more=False,
            is_incomplete=True,
            incomplete_reason="query_result_limit_reached",
        )
    )
    mock_client.fetch_page = AsyncMock(
        return_value={
            "id": "page_active_1",
            "properties": {"Task": {"type": "title", "title": [{"plain_text": "Task 1"}]}},
        }
    )
    mock_pool = MagicMock()

    with (
        patch.object(TasksRepository, "upsert_task", new_callable=AsyncMock) as upsert_spy,
        patch.object(
            TasksRepository, "mark_tasks_out_of_source", new_callable=AsyncMock
        ) as out_of_source_spy,
        patch.object(RunsRepository, "start_run", new_callable=AsyncMock, return_value=203),
        patch.object(RunsRepository, "finish_run", new_callable=AsyncMock) as finish_run_spy,
    ):
        result = await run_reconciliation(
            ReconcileOptions(
                client=mock_client,
                pool=mock_pool,
                config=test_config,
                dry_run=False,
            )
        )

        assert result.status == "partial"
        assert result.is_incomplete is True
        assert result.incomplete_reason == "query_result_limit_reached"
        assert result.records_processed == 1
        assert upsert_spy.call_count == 1

        # Crucial invariant: a capped scan proves nothing about vanished pages
        out_of_source_spy.assert_not_called()

        finish_run_spy.assert_called_once()
        args = finish_run_spy.call_args[0]
        assert args[1] == 203
        assert args[2] == "partial"
        assert args[3] == 1
        assert "query_result_limit_reached" in args[4]
