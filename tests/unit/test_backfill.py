"""Unit tests for initial backfill command and cursor pagination."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import validate_config
from app.db.runs_repo import RunsRepository
from app.db.tasks_repo import TasksRepository
from app.sync.backfill import BackfillOptions, run_backfill
from app.sync.notion_client import DataSourcePageBatch


@pytest.fixture
def test_config():
    return validate_config(
        {
            "NODE_ENV": "test",
            "NOTION_DATABASE_ID": "11111111-1111-1111-1111-111111111111",
            "SYNC_PAGE_SIZE": "2",
        }
    )


@pytest.mark.asyncio
async def test_paginates_across_multiple_cursor_pages_until_has_more_is_false(test_config) -> None:
    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds_test_123")
    mock_client.query_data_source_pages = AsyncMock(
        side_effect=[
            DataSourcePageBatch(
                results=[
                    {
                        "id": "page_1",
                        "properties": {
                            "Task": {"type": "title", "title": [{"plain_text": "Task 1"}]}
                        },
                    },
                    {
                        "id": "page_2",
                        "properties": {
                            "Task": {"type": "title", "title": [{"plain_text": "Task 2"}]}
                        },
                    },
                ],
                next_cursor="cursor_page_2",
                has_more=True,
            ),
            DataSourcePageBatch(
                results=[
                    {
                        "id": "page_3",
                        "properties": {
                            "Task": {"type": "title", "title": [{"plain_text": "Task 3"}]}
                        },
                    },
                ],
                next_cursor=None,
                has_more=False,
            ),
        ]
    )

    mock_pool = MagicMock()

    with (
        patch.object(TasksRepository, "upsert_task", new_callable=AsyncMock) as upsert_spy,
        patch.object(
            RunsRepository, "start_run", new_callable=AsyncMock, return_value=101
        ) as start_run_spy,
        patch.object(RunsRepository, "finish_run", new_callable=AsyncMock) as finish_run_spy,
    ):
        result = await run_backfill(
            BackfillOptions(
                client=mock_client,
                pool=mock_pool,
                config=test_config,
                dry_run=False,
            )
        )

        assert result.status == "succeeded"
        assert result.records_processed == 3
        assert result.page_failures == 0
        assert result.run_id == 101

        assert mock_client.query_data_source_pages.call_count == 2
        mock_client.query_data_source_pages.assert_any_call(
            "ds_test_123", start_cursor=None, page_size=2
        )
        mock_client.query_data_source_pages.assert_any_call(
            "ds_test_123", start_cursor="cursor_page_2", page_size=2
        )

        assert upsert_spy.call_count == 3
        start_run_spy.assert_called_once_with(mock_pool, "initial_backfill")
        finish_run_spy.assert_called_once_with(mock_pool, 101, "succeeded", 3, None, None)


@pytest.mark.asyncio
async def test_dry_run_mode_normalizes_and_counts_records_without_db_writes(test_config) -> None:
    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds_test_123")
    mock_client.query_data_source_pages = AsyncMock(
        return_value=DataSourcePageBatch(
            results=[
                {
                    "id": "page_dry_1",
                    "properties": {"Task": {"type": "title", "title": [{"plain_text": "Dry 1"}]}},
                },
            ],
            next_cursor=None,
            has_more=False,
        )
    )

    with (
        patch.object(TasksRepository, "upsert_task", new_callable=AsyncMock) as upsert_spy,
        patch.object(RunsRepository, "start_run", new_callable=AsyncMock) as start_run_spy,
    ):
        result = await run_backfill(
            BackfillOptions(
                client=mock_client,
                pool=MagicMock(),
                config=test_config,
                dry_run=True,
            )
        )

        assert result.status == "succeeded"
        assert result.records_processed == 1
        assert result.run_id is None
        upsert_spy.assert_not_called()
        start_run_spy.assert_not_called()


@pytest.mark.asyncio
async def test_detects_infinite_cursor_cycle_and_aborts_safely(test_config) -> None:
    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds_test_123")
    mock_client.query_data_source_pages = AsyncMock(
        return_value=DataSourcePageBatch(
            results=[],
            next_cursor="stuck_cursor",
            has_more=True,
        )
    )

    with (
        patch.object(RunsRepository, "start_run", new_callable=AsyncMock, return_value=102),
        patch.object(RunsRepository, "finish_run", new_callable=AsyncMock) as finish_run_spy,
    ):
        with pytest.raises(RuntimeError, match=r"Infinite pagination cycle detected"):
            await run_backfill(
                BackfillOptions(
                    client=mock_client,
                    pool=MagicMock(),
                    config=test_config,
                    dry_run=False,
                )
            )

        finish_run_spy.assert_called_once()
        args = finish_run_spy.call_args[0]
        assert args[1] == 102
        assert args[2] == "failed"
        assert args[3] == 0
        assert "Infinite pagination cycle detected" in args[4]
        assert args[5] == "stuck_cursor"


@pytest.mark.asyncio
async def test_marks_run_partial_when_notion_reports_incomplete_result_set_bug_002(
    test_config,
) -> None:
    mock_client = MagicMock()
    mock_client.resolve_data_source = AsyncMock(return_value="ds_test_123")
    mock_client.query_data_source_pages = AsyncMock(
        return_value=DataSourcePageBatch(
            results=[
                {
                    "id": "page_cap_1",
                    "properties": {
                        "Task": {"type": "title", "title": [{"plain_text": "Capped 1"}]}
                    },
                },
            ],
            next_cursor=None,
            has_more=False,
            is_incomplete=True,
            incomplete_reason="query_result_limit_reached",
        )
    )

    mock_pool = MagicMock()

    with (
        patch.object(TasksRepository, "upsert_task", new_callable=AsyncMock) as upsert_spy,
        patch.object(RunsRepository, "start_run", new_callable=AsyncMock, return_value=103),
        patch.object(RunsRepository, "finish_run", new_callable=AsyncMock) as finish_run_spy,
    ):
        result = await run_backfill(
            BackfillOptions(
                client=mock_client,
                pool=mock_pool,
                config=test_config,
                dry_run=False,
            )
        )

        assert result.status == "partial"
        assert result.is_incomplete is True
        assert result.incomplete_reason == "query_result_limit_reached"
        assert upsert_spy.call_count == 1

        finish_run_spy.assert_called_once()
        args = finish_run_spy.call_args[0]
        assert args[0] == mock_pool
        assert args[1] == 103
        assert args[2] == "partial"
        assert args[3] == 1
        assert "query_result_limit_reached" in args[4]
