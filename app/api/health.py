from __future__ import annotations

import inspect
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse
from psycopg.rows import dict_row
from pydantic import BaseModel

from app.config import AppConfig, get_config
from app.db.runs_repo import RunsRepository

router = APIRouter()


class ServiceHealth(BaseModel):
    name: str = "TaskBridge"
    version: str = "0.1.0"
    environment: str
    uptime_seconds: float


class PoolStats(BaseModel):
    pool_min: int | None = None
    pool_max: int | None = None
    pool_size: int | None = None
    pool_available: int | None = None
    requests_waiting: int | None = None


class DatabaseHealth(BaseModel):
    status: Literal["connected", "disconnected", "error"]
    latency_ms: float | None = None
    pool: PoolStats | None = None
    error: str | None = None


class QueueHealth(BaseModel):
    pending: int = 0
    processing: int = 0
    failed: int = 0
    stuck_leases: int = 0


class TasksHealth(BaseModel):
    active: int = 0
    in_trash: int = 0
    out_of_source: int = 0


class LastRunHealth(BaseModel):
    run_id: int | None = None
    run_type: str | None = None
    status: str | None = None
    records_processed: int | None = None
    started_at: str | None = None
    finished_at: str | None = None


class SyncHealth(BaseModel):
    inbox_queue: QueueHealth
    tasks: TasksHealth
    last_run: LastRunHealth | None = None


class HealthMonitorResponse(BaseModel):
    status: Literal["healthy", "degraded", "unhealthy"]
    timestamp: str
    service: ServiceHealth
    database: DatabaseHealth
    sync: SyncHealth | None = None


@router.get("/health")
async def health_check() -> dict[str, str]:
    """Liveness probe. Returns 200 without checking external dependencies."""
    return {"status": "ok"}


@router.get("/ready")
async def readiness_check(request: Request) -> JSONResponse:
    """Readiness probe. Checks database connectivity using SELECT 1."""
    check_fn: Callable[[], Any] | None = getattr(request.app.state, "check_db_ready", None)

    try:
        if check_fn is not None:
            res = check_fn()
            if inspect.isawaitable(res):
                is_ready = await res
            else:
                is_ready = bool(res)
            if not is_ready:
                return JSONResponse(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    content={"status": "not_ready", "reason": "database_unavailable"},
                )
        else:
            pool = getattr(request.app.state, "pool", None)
            if pool is None:
                return JSONResponse(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    content={"status": "not_ready", "reason": "database_unavailable"},
                )
            async with pool.connection() as conn:
                await conn.execute("SELECT 1")

        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={
                "status": "ready",
                "timestamp": datetime.now(UTC).isoformat(),
            },
        )
    except Exception:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"status": "not_ready", "reason": "database_check_failed"},
        )


@router.get(
    "/health/monitor",
    response_model=HealthMonitorResponse,
    responses={
        200: {"description": "Service is healthy or degraded"},
        503: {"description": "Service is unhealthy (database unavailable)"},
    },
)
@router.get(
    "/monitor",
    response_model=HealthMonitorResponse,
    include_in_schema=False,
)
async def health_monitor(request: Request) -> JSONResponse:
    """Comprehensive health and telemetry probe.

    Reports uptime, database latency, connection pool utilization, sync queue metrics,
    and last synchronization run.
    """
    now = datetime.now(UTC)
    config: AppConfig = getattr(request.app.state, "config", None) or get_config()
    env = config.APP_ENV or config.NODE_ENV or "development"

    started_at: datetime | None = getattr(request.app.state, "started_at", None)
    uptime_seconds = round((now - started_at).total_seconds(), 2) if started_at is not None else 0.0

    service_info = ServiceHealth(
        name="TaskBridge",
        version="0.1.0",
        environment=env,
        uptime_seconds=uptime_seconds,
    )

    # 1. Database check & latency
    check_fn: Callable[[], Any] | None = getattr(request.app.state, "check_db_ready", None)
    pool = getattr(request.app.state, "pool", None)

    db_health: DatabaseHealth
    sync_health: SyncHealth | None = None
    is_db_connected = False

    if check_fn is not None:
        try:
            res = check_fn()
            is_ready = await res if inspect.isawaitable(res) else bool(res)
            if is_ready:
                is_db_connected = True
                db_health = DatabaseHealth(status="connected", latency_ms=0.1)
            else:
                db_health = DatabaseHealth(status="disconnected", error="database_unavailable")
        except Exception as e:
            db_health = DatabaseHealth(status="error", error=str(e))
    elif pool is not None:
        try:
            t0 = time.perf_counter()
            async with pool.connection() as conn:
                await conn.execute("SELECT 1")
                latency_ms = round((time.perf_counter() - t0) * 1000, 2)
            is_db_connected = True

            raw_stats = pool.get_stats() if hasattr(pool, "get_stats") else None
            pool_stats = PoolStats(**raw_stats) if raw_stats else None
            db_health = DatabaseHealth(
                status="connected",
                latency_ms=latency_ms,
                pool=pool_stats,
            )
        except Exception as e:
            db_health = DatabaseHealth(status="error", error=str(e))
    else:
        db_health = DatabaseHealth(status="disconnected", error="database_pool_uninitialized")

    if not is_db_connected:
        payload = HealthMonitorResponse(
            status="unhealthy",
            timestamp=now.isoformat(),
            service=service_info,
            database=db_health,
            sync=None,
        )
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content=payload.model_dump(),
        )

    # 2. Sync queue & task telemetry (when DB is connected and pool is available)
    stuck_leases_count = 0
    failed_events_count = 0

    if pool is not None:
        try:
            async with pool.connection() as conn:
                async with conn.cursor(row_factory=dict_row) as cur:
                    await cur.execute(
                        """
                        SELECT
                            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                            COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing,
                            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
                            COALESCE(SUM(CASE WHEN status = 'processing' AND locked_at < NOW() - INTERVAL '300 seconds' THEN 1 ELSE 0 END), 0) AS stuck
                        FROM notion_sync.sync_inbox;
                        """
                    )
                    inbox_counts = await cur.fetchone()

                    await cur.execute(
                        """
                        SELECT
                            COALESCE(SUM(CASE WHEN is_in_source = true AND notion_in_trash = false THEN 1 ELSE 0 END), 0) AS active,
                            COALESCE(SUM(CASE WHEN notion_in_trash = true THEN 1 ELSE 0 END), 0) AS in_trash,
                            COALESCE(SUM(CASE WHEN is_in_source = false THEN 1 ELSE 0 END), 0) AS out_of_source
                        FROM notion_sync.notion_tasks;
                        """
                    )
                    tasks_counts = await cur.fetchone()

            q_health = QueueHealth(
                pending=int(inbox_counts["pending"]) if inbox_counts else 0,
                processing=int(inbox_counts["processing"]) if inbox_counts else 0,
                failed=int(inbox_counts["failed"]) if inbox_counts else 0,
                stuck_leases=int(inbox_counts["stuck"]) if inbox_counts else 0,
            )
            t_health = TasksHealth(
                active=int(tasks_counts["active"]) if tasks_counts else 0,
                in_trash=int(tasks_counts["in_trash"]) if tasks_counts else 0,
                out_of_source=int(tasks_counts["out_of_source"]) if tasks_counts else 0,
            )

            stuck_leases_count = q_health.stuck_leases
            failed_events_count = q_health.failed

            latest_run = await RunsRepository.get_latest_run(pool)
            lr_health: LastRunHealth | None = None
            if latest_run:
                lr_health = LastRunHealth(
                    run_id=latest_run.run_id,
                    run_type=latest_run.run_type,
                    status=latest_run.status,
                    records_processed=latest_run.records_processed,
                    started_at=latest_run.started_at.isoformat() if latest_run.started_at else None,
                    finished_at=latest_run.finished_at.isoformat()
                    if latest_run.finished_at
                    else None,
                )

            sync_health = SyncHealth(
                inbox_queue=q_health,
                tasks=t_health,
                last_run=lr_health,
            )
        except Exception:
            # If schema not yet migrated, sync telemetry is unavailable but endpoint stays up
            sync_health = None

    # Evaluate overall status
    if stuck_leases_count > 0 or failed_events_count > 0:
        overall_status: Literal["healthy", "degraded", "unhealthy"] = "degraded"
    else:
        overall_status = "healthy"

    payload = HealthMonitorResponse(
        status=overall_status,
        timestamp=now.isoformat(),
        service=service_info,
        database=db_health,
        sync=sync_health,
    )

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content=payload.model_dump(),
    )
