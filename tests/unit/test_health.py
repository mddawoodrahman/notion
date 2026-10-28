"""Unit tests for health, readiness, and monitoring endpoints."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from app.config import validate_config
from app.db.runs_repo import SyncRunRecord
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


@pytest.mark.asyncio
async def test_get_health_monitor_returns_200_healthy() -> None:
    test_config = validate_config({"NODE_ENV": "test", "PORT": "3000"})
    app = create_app(config=test_config, check_db_ready=lambda: True)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health/monitor")
        assert res.status_code == 200
        body = res.json()

        assert body["status"] == "healthy"
        assert "timestamp" in body

        service = body["service"]
        assert service["name"] == "TaskBridge"
        assert service["version"] == "0.1.0"
        assert service["environment"] == "test"
        assert service["uptime_seconds"] >= 0.0

        database = body["database"]
        assert database["status"] == "connected"
        assert database["latency_ms"] is not None


@pytest.mark.asyncio
async def test_get_health_monitor_returns_503_unhealthy_when_db_down() -> None:
    test_config = validate_config({"NODE_ENV": "test", "PORT": "3000"})
    app = create_app(config=test_config, check_db_ready=lambda: False)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health/monitor")
        assert res.status_code == 503
        body = res.json()

        assert body["status"] == "unhealthy"
        assert body["database"]["status"] == "disconnected"
        assert body["sync"] is None


@pytest.mark.asyncio
async def test_get_health_monitor_returns_pool_and_sync_metrics() -> None:
    test_config = validate_config({"NODE_ENV": "test", "PORT": "3000"})

    mock_pool = MagicMock()
    mock_pool.get_stats.return_value = {
        "pool_min": 2,
        "pool_max": 10,
        "pool_size": 4,
        "pool_available": 3,
        "requests_waiting": 0,
    }

    mock_cursor = AsyncMock()
    mock_cursor.fetchone.side_effect = [
        {"pending": 5, "processing": 1, "failed": 0, "stuck": 0},
        {"active": 42, "in_trash": 3, "out_of_source": 1},
    ]

    mock_conn = AsyncMock()
    mock_conn.cursor = MagicMock()
    mock_conn.cursor.return_value.__aenter__.return_value = mock_cursor
    mock_pool.connection.return_value.__aenter__.return_value = mock_conn

    # Also mock latest run
    mock_run = SyncRunRecord(
        run_id=101,
        run_type="reconciliation",
        status="succeeded",
        started_at=datetime(2026, 10, 28, 12, 0, 0, tzinfo=UTC),
        finished_at=datetime(2026, 10, 28, 12, 0, 2, tzinfo=UTC),
        records_processed=45,
        error_message=None,
        cursor_reached=None,
    )

    app = create_app(config=test_config, pool=mock_pool)

    # Patch RunsRepository.get_latest_run
    from unittest.mock import patch

    with patch("app.api.health.RunsRepository.get_latest_run", return_value=mock_run):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get("/health/monitor")
            assert res.status_code == 200
            body = res.json()

            assert body["status"] == "healthy"
            assert body["database"]["pool"]["pool_size"] == 4
            assert body["database"]["pool"]["pool_available"] == 3

            sync = body["sync"]
            assert sync is not None
            assert sync["inbox_queue"]["pending"] == 5
            assert sync["inbox_queue"]["processing"] == 1
            assert sync["inbox_queue"]["failed"] == 0
            assert sync["inbox_queue"]["stuck_leases"] == 0

            assert sync["tasks"]["active"] == 42
            assert sync["tasks"]["in_trash"] == 3
            assert sync["tasks"]["out_of_source"] == 1

            assert sync["last_run"]["run_id"] == 101
            assert sync["last_run"]["status"] == "succeeded"
            assert sync["last_run"]["records_processed"] == 45


@pytest.mark.asyncio
async def test_get_health_monitor_degraded_when_failed_or_stuck_leases() -> None:
    test_config = validate_config({"NODE_ENV": "test", "PORT": "3000"})

    mock_pool = MagicMock()
    mock_pool.get_stats.return_value = {
        "pool_min": 1,
        "pool_max": 5,
        "pool_size": 2,
        "pool_available": 1,
        "requests_waiting": 0,
    }

    mock_cursor = AsyncMock()
    mock_cursor.fetchone.side_effect = [
        {"pending": 2, "processing": 1, "failed": 3, "stuck": 1},
        {"active": 10, "in_trash": 0, "out_of_source": 0},
    ]

    mock_conn = AsyncMock()
    mock_conn.cursor = MagicMock()
    mock_conn.cursor.return_value.__aenter__.return_value = mock_cursor
    mock_pool.connection.return_value.__aenter__.return_value = mock_conn

    app = create_app(config=test_config, pool=mock_pool)

    from unittest.mock import patch

    with patch("app.api.health.RunsRepository.get_latest_run", return_value=None):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get("/health/monitor")
            assert res.status_code == 200
            body = res.json()

            assert body["status"] == "degraded"
            assert body["sync"]["inbox_queue"]["failed"] == 3
            assert body["sync"]["inbox_queue"]["stuck_leases"] == 1


@pytest.mark.asyncio
async def test_get_monitor_alias_route() -> None:
    test_config = validate_config({"NODE_ENV": "test", "PORT": "3000"})
    app = create_app(config=test_config, check_db_ready=lambda: True)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/monitor")
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "healthy"
        assert body["service"]["name"] == "TaskBridge"
