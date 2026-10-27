"""Unit tests for health and readiness endpoints."""

import httpx
import pytest

from app.config import validate_config
from app.main import create_app


@pytest.mark.asyncio
async def test_get_health_returns_200_ok() -> None:
    test_config = validate_config({"NODE_ENV": "test", "PORT": "3000"})
    app = create_app(config=test_config, check_db_ready=lambda: True)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health")
        assert res.status_code == 200
        assert res.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_get_ready_returns_200_ready_when_database_is_available() -> None:
    test_config = validate_config({"NODE_ENV": "test", "PORT": "3000"})
    app = create_app(config=test_config, check_db_ready=lambda: True)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/ready")
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "ready"
        assert "timestamp" in body


@pytest.mark.asyncio
async def test_get_ready_returns_503_not_ready_when_database_is_unavailable() -> None:
    test_config = validate_config({"NODE_ENV": "test", "PORT": "3000"})
    app = create_app(config=test_config, check_db_ready=lambda: False)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/ready")
        assert res.status_code == 503
        body = res.json()
        assert body["status"] == "not_ready"
        assert body["reason"] == "database_unavailable"


@pytest.mark.asyncio
async def test_app_metadata_title_and_description() -> None:
    test_config = validate_config({"NODE_ENV": "test", "PORT": "3000"})
    app = create_app(config=test_config, check_db_ready=lambda: True)
    assert app.title == "TaskBridge API"
    assert app.description == "Reliable Notion-to-PostgreSQL synchronization API"

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/openapi.json")
        assert res.status_code == 200
        data = res.json()
        assert data["info"]["title"] == "TaskBridge API"
        assert data["info"]["description"] == "Reliable Notion-to-PostgreSQL synchronization API"
