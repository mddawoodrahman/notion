"""Unit tests for Notion API client and retry policy."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import validate_config
from app.errors import ConfigurationError, NotionApiError
from app.sync.notion_client import NotionSyncClient


@pytest.fixture
def test_config():
    return validate_config(
        {
            "NODE_ENV": "test",
            "NOTION_API_KEY": "secret_test_key",
            "NOTION_DATABASE_ID": "11111111-1111-1111-1111-111111111111",
            "SYNC_MAX_ATTEMPTS": "3",
        }
    )


@pytest.mark.asyncio
async def test_resolves_single_data_source_from_database_metadata(test_config) -> None:
    mock_client = MagicMock()
    mock_client.databases.retrieve = AsyncMock(
        return_value={
            "id": "db_123",
            "data_sources": [{"id": "ds_456", "name": "Tasks Data Source"}],
        }
    )

    sync_client = NotionSyncClient(test_config, client_override=mock_client)
    resolved = await sync_client.resolve_data_source("db_123")
    assert resolved == "ds_456"


@pytest.mark.asyncio
async def test_fails_to_resolve_when_multiple_data_sources_and_notion_data_source_id_missing(
    test_config,
) -> None:
    mock_client = MagicMock()
    mock_client.databases.retrieve = AsyncMock(
        return_value={
            "id": "db_123",
            "data_sources": [
                {"id": "ds_1", "name": "Tasks"},
                {"id": "ds_2", "name": "Archive"},
            ],
        }
    )

    sync_client = NotionSyncClient(test_config, client_override=mock_client)
    with pytest.raises(ConfigurationError):
        await sync_client.resolve_data_source("db_123")


@pytest.mark.asyncio
async def test_retries_on_transient_429_and_eventually_succeeds(test_config) -> None:
    call_count = 0

    async def _retrieve(**_kwargs):
        nonlocal call_count
        call_count += 1
        if call_count < 2:
            err = RuntimeError("Rate limit exceeded")
            err.status = 429
            err.headers = {"retry-after": "0"}
            raise err
        return {"id": "page_123", "properties": {}}

    mock_client = MagicMock()
    mock_client.pages.retrieve = AsyncMock(side_effect=_retrieve)

    sync_client = NotionSyncClient(test_config, client_override=mock_client)
    with patch("asyncio.sleep", new_callable=AsyncMock):
        page = await sync_client.fetch_page("page_123")

    assert page["id"] == "page_123"
    assert call_count == 2


@pytest.mark.asyncio
async def test_does_not_retry_permanent_404_or_403_errors(test_config) -> None:
    call_count = 0

    async def _retrieve(**_kwargs):
        nonlocal call_count
        call_count += 1
        err = RuntimeError("Page not found")
        err.status = 404
        raise err

    mock_client = MagicMock()
    mock_client.pages.retrieve = AsyncMock(side_effect=_retrieve)

    sync_client = NotionSyncClient(test_config, client_override=mock_client)
    with pytest.raises(NotionApiError):
        await sync_client.fetch_page("page_not_found")

    assert call_count == 1  # No retries on 404


@pytest.mark.asyncio
async def test_redacts_secret_tokens_from_error_messages(test_config) -> None:
    sensitive_key = "secret_my_sensitive_notion_key_value"

    async def _retrieve(**_kwargs):
        raise RuntimeError(f"Failed with authorization header using {sensitive_key}")

    mock_client = MagicMock()
    mock_client.pages.retrieve = AsyncMock(side_effect=_retrieve)

    sync_client = NotionSyncClient(test_config, client_override=mock_client)
    try:
        await sync_client.fetch_page("page_secret")
        pytest.fail("Expected NotionApiError")
    except NotionApiError as err:
        assert sensitive_key not in str(err)
        assert "[REDACTED_NOTION_KEY]" in str(err)


@pytest.mark.asyncio
async def test_surfaces_notion_request_status_as_is_incomplete(test_config) -> None:
    mock_client = MagicMock()
    mock_client.dataSources.query = AsyncMock(
        side_effect=[
            {
                "results": [{"id": "page_capped_1"}],
                "next_cursor": None,
                "has_more": False,
                "request_status": {
                    "type": "incomplete",
                    "incomplete_reason": "query_result_limit_reached",
                },
            },
            {
                "results": [{"id": "page_ok_1"}],
                "next_cursor": "cursor_next",
                "has_more": True,
            },
        ]
    )

    sync_client = NotionSyncClient(test_config, client_override=mock_client)

    capped = await sync_client.query_data_source_pages("ds_123")
    assert capped.has_more is False
    assert capped.is_incomplete is True
    assert capped.incomplete_reason == "query_result_limit_reached"
    assert len(capped.results) == 1

    complete = await sync_client.query_data_source_pages("ds_123")
    assert complete.has_more is True
    assert complete.next_cursor == "cursor_next"
    assert complete.is_incomplete is False
    assert complete.incomplete_reason is None


@pytest.mark.asyncio
async def test_retries_status_less_request_timeout_error_up_to_max_attempts(test_config) -> None:
    call_count = 0

    async def _retrieve(**_kwargs):
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            err = TimeoutError("Request timed out after 60000ms")
            err.code = "notionhq_client_request_timeout"
            raise err
        return {"id": "page_timeout_ok", "properties": {}}

    mock_client = MagicMock()
    mock_client.pages.retrieve = AsyncMock(side_effect=_retrieve)

    sync_client = NotionSyncClient(test_config, client_override=mock_client)
    with patch("asyncio.sleep", new_callable=AsyncMock):
        page = await sync_client.fetch_page("page_timeout_ok")

    assert page["id"] == "page_timeout_ok"
    assert call_count == 3


@pytest.mark.asyncio
async def test_retries_status_less_econnreset_network_failures_bug_003(test_config) -> None:
    call_count = 0

    async def _retrieve(**_kwargs):
        nonlocal call_count
        call_count += 1
        err = ConnectionResetError("socket hang up")
        err.code = "ECONNRESET"
        raise err

    mock_client = MagicMock()
    mock_client.pages.retrieve = AsyncMock(side_effect=_retrieve)

    sync_client = NotionSyncClient(test_config, client_override=mock_client)
    with patch("asyncio.sleep", new_callable=AsyncMock):
        with pytest.raises(NotionApiError) as exc_info:
            await sync_client.fetch_page("page_reset")

    err = exc_info.value
    assert err.is_retryable is True
    assert "network" in str(err)
    assert call_count == 3  # SYNC_MAX_ATTEMPTS attempts
