"""Unit tests for secure webhook receiver and durable inbox."""

import hashlib
import hmac
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.config import validate_config
from app.db.inbox_repo import EnqueueResult, InboxRepository
from app.main import create_app


def sign_payload(body: str | bytes, token: str) -> str:
    raw_bytes = body.encode("utf-8") if isinstance(body, str) else body
    digest = hmac.new(token.encode("utf-8"), raw_bytes, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


@pytest.mark.asyncio
async def test_handles_one_time_subscription_handshake_without_enqueuing() -> None:
    token = "my_super_secret_webhook_verification_token_1234567890"
    test_config = validate_config({"NODE_ENV": "test", "NOTION_WEBHOOK_VERIFICATION_TOKEN": token})
    mock_pool = AsyncMock()
    app = create_app(config=test_config, pool=mock_pool)

    with patch.object(InboxRepository, "enqueue_event", new_callable=AsyncMock) as enqueue_spy:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                "/webhooks/notion",
                json={"verification_token": "temp_handshake_secret_token_abc"},
            )
            assert res.status_code == 200
            assert res.json() == {"ok": True}
            enqueue_spy.assert_not_called()


@pytest.mark.asyncio
async def test_rejects_webhook_request_without_signature_with_401() -> None:
    token = "my_super_secret_webhook_verification_token_1234567890"
    test_config = validate_config({"NODE_ENV": "test", "NOTION_WEBHOOK_VERIFICATION_TOKEN": token})
    mock_pool = AsyncMock()
    app = create_app(config=test_config, pool=mock_pool)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/webhooks/notion",
            json={
                "id": "evt_1",
                "type": "page.created",
                "entity": {"type": "page", "id": "page_1"},
            },
        )
        assert res.status_code == 401
        assert res.json() == {"ok": False}


@pytest.mark.asyncio
async def test_rejects_invalid_signature_with_401() -> None:
    token = "my_super_secret_webhook_verification_token_1234567890"
    test_config = validate_config({"NODE_ENV": "test", "NOTION_WEBHOOK_VERIFICATION_TOKEN": token})
    mock_pool = AsyncMock()
    app = create_app(config=test_config, pool=mock_pool)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/webhooks/notion",
            headers={"x-notion-signature": "sha256=" + "0" * 64},
            json={
                "id": "evt_1",
                "type": "page.created",
                "entity": {"type": "page", "id": "page_1"},
            },
        )
        assert res.status_code == 401
        assert res.json() == {"ok": False}


@pytest.mark.asyncio
async def test_accepts_valid_signature_and_durably_stores_event() -> None:
    token = "my_super_secret_webhook_verification_token_1234567890"
    test_config = validate_config({"NODE_ENV": "test", "NOTION_WEBHOOK_VERIFICATION_TOKEN": token})
    mock_pool = AsyncMock()
    app = create_app(config=test_config, pool=mock_pool)

    payload_dict = {
        "id": "evt_valid_123",
        "type": "page.properties_updated",
        "entity": {"type": "page", "id": "page_abc"},
        "timestamp": "2026-10-21T12:00:00.000Z",
    }
    raw_payload = json.dumps(payload_dict)
    sig = sign_payload(raw_payload, token)

    with patch.object(
        InboxRepository,
        "enqueue_event",
        new_callable=AsyncMock,
        return_value=EnqueueResult(is_duplicate=False, event_id="evt_valid_123"),
    ) as enqueue_spy:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                "/webhooks/notion",
                content=raw_payload,
                headers={"content-type": "application/json", "x-notion-signature": sig},
            )
            assert res.status_code == 200
            assert res.json() == {"ok": True}
            assert enqueue_spy.call_count == 1


@pytest.mark.asyncio
async def test_returns_200_with_duplicate_true_for_repeated_deliveries() -> None:
    token = "my_super_secret_webhook_verification_token_1234567890"
    test_config = validate_config({"NODE_ENV": "test", "NOTION_WEBHOOK_VERIFICATION_TOKEN": token})
    mock_pool = AsyncMock()
    app = create_app(config=test_config, pool=mock_pool)

    payload_dict = {
        "id": "evt_dup_456",
        "type": "page.properties_updated",
        "entity": {"type": "page", "id": "page_abc"},
    }
    raw_payload = json.dumps(payload_dict)
    sig = sign_payload(raw_payload, token)

    with patch.object(
        InboxRepository,
        "enqueue_event",
        new_callable=AsyncMock,
        return_value=EnqueueResult(is_duplicate=True, event_id="evt_dup_456"),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                "/webhooks/notion",
                content=raw_payload,
                headers={"content-type": "application/json", "x-notion-signature": sig},
            )
            assert res.status_code == 200
            assert res.json() == {"ok": True, "duplicate": True}


@pytest.mark.asyncio
async def test_returns_400_for_malformed_payload_failing_envelope_schema() -> None:
    token = "my_super_secret_webhook_verification_token_1234567890"
    test_config = validate_config({"NODE_ENV": "test", "NOTION_WEBHOOK_VERIFICATION_TOKEN": token})
    mock_pool = AsyncMock()
    app = create_app(config=test_config, pool=mock_pool)

    raw_payload = json.dumps({"foo": "bar"})
    sig = sign_payload(raw_payload, token)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/webhooks/notion",
            content=raw_payload,
            headers={"content-type": "application/json", "x-notion-signature": sig},
        )
        assert res.status_code == 400
        assert res.json() == {"ok": False}


@pytest.mark.asyncio
async def test_returns_503_if_database_storage_fails_inv_3() -> None:
    token = "my_super_secret_webhook_verification_token_1234567890"
    test_config = validate_config({"NODE_ENV": "test", "NOTION_WEBHOOK_VERIFICATION_TOKEN": token})
    mock_pool = AsyncMock()
    app = create_app(config=test_config, pool=mock_pool)

    raw_payload = json.dumps(
        {
            "id": "evt_db_fail",
            "type": "page.created",
            "entity": {"type": "page", "id": "page_1"},
        }
    )
    sig = sign_payload(raw_payload, token)

    with patch.object(
        InboxRepository,
        "enqueue_event",
        new_callable=AsyncMock,
        side_effect=RuntimeError("PostgreSQL connection refused"),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                "/webhooks/notion",
                content=raw_payload,
                headers={"content-type": "application/json", "x-notion-signature": sig},
            )
            assert res.status_code == 503
            assert res.json() == {"ok": False}


def unsigned_development_config(overrides: dict[str, str] | None = None) -> Any:
    base = {
        "NODE_ENV": "development",
        "NOTION_API_KEY": "secret_dev_placeholder_1234567890",
        "NOTION_DATABASE_ID": "11111111-1111-1111-1111-111111111111",
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/devdb",
    }
    if overrides:
        base.update(overrides)
    return validate_config(base)


@pytest.mark.asyncio
async def test_fails_closed_with_503_when_no_verification_token_configured_sec_001() -> None:
    config = unsigned_development_config()
    mock_pool = AsyncMock()
    app = create_app(config=config, pool=mock_pool)

    with patch.object(InboxRepository, "enqueue_event", new_callable=AsyncMock) as enqueue_spy:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                "/webhooks/notion",
                json={
                    "id": "evt_unsigned_1",
                    "type": "page.created",
                    "entity": {"type": "page", "id": "page_unsigned_1"},
                },
            )
            assert res.status_code == 503
            assert res.json() == {"ok": False}
            enqueue_spy.assert_not_called()


@pytest.mark.asyncio
async def test_accepts_unsigned_deliveries_only_with_allow_unsigned_webhooks_true_sec_001() -> None:
    config = unsigned_development_config({"ALLOW_UNSIGNED_WEBHOOKS": "true"})
    assert config.ALLOW_UNSIGNED_WEBHOOKS is True
    mock_pool = AsyncMock()
    app = create_app(config=config, pool=mock_pool)

    with patch.object(
        InboxRepository,
        "enqueue_event",
        new_callable=AsyncMock,
        return_value=EnqueueResult(is_duplicate=False, event_id="evt_unsigned_ok"),
    ) as enqueue_spy:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                "/webhooks/notion",
                json={
                    "id": "evt_unsigned_ok",
                    "type": "page.created",
                    "entity": {"type": "page", "id": "page_unsigned_ok"},
                },
            )
            assert res.status_code == 200
            assert res.json() == {"ok": True}
            assert enqueue_spy.call_count == 1


@pytest.mark.asyncio
async def test_rejects_non_dict_json_payloads_with_400_bad_request() -> None:
    token = "my_super_secret_webhook_verification_token_1234567890"
    test_config = validate_config({"NODE_ENV": "test", "NOTION_WEBHOOK_VERIFICATION_TOKEN": token})
    mock_pool = AsyncMock()
    app = create_app(config=test_config, pool=mock_pool)

    # Test JSON list, primitive string, and primitive number
    for bad_content in ["[1, 2, 3]", '"just a primitive string"', "12345"]:
        sig = sign_payload(bad_content, token)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                "/webhooks/notion",
                content=bad_content,
                headers={"content-type": "application/json", "x-notion-signature": sig},
            )
            assert res.status_code == 400
            assert res.json() == {"ok": False}
