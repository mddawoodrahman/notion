from __future__ import annotations

import inspect
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

router = APIRouter()


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
