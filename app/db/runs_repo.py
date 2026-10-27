from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

RunType = Literal["initial_backfill", "reconciliation", "manual_retry"]
RunStatus = Literal["running", "succeeded", "partial", "failed"]


@dataclass(frozen=True)
class SyncRunRecord:
    run_id: int
    run_type: RunType
    status: RunStatus
    started_at: datetime
    finished_at: datetime | None
    records_processed: int
    error_message: str | None
    cursor_reached: str | None


class RunsRepository:
    """Repository for managing operational runs ledger (sync_runs)."""

    @staticmethod
    async def start_run(
        db: AsyncConnectionPool | AsyncConnection,
        run_type: RunType,
    ) -> int:
        query = """
            INSERT INTO notion_sync.sync_runs (run_type, status, started_at)
            VALUES (%s, 'running', NOW())
            RETURNING run_id;
        """
        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(query, (run_type,))
                    row = await cur.fetchone()
                    if row is None:
                        raise RuntimeError("Failed to create sync run record")
                    return int(row[0])
        else:
            async with cast(AsyncConnection, db).cursor() as cur:
                await cur.execute(query, (run_type,))
                row = await cur.fetchone()
                if row is None:
                    raise RuntimeError("Failed to create sync run record")
                return int(row[0])

    @staticmethod
    async def finish_run(
        db: AsyncConnectionPool | AsyncConnection,
        run_id: int,
        status: RunStatus,
        records_processed: int,
        error_message: str | None = None,
        cursor_reached: str | None = None,
    ) -> None:
        query = """
            UPDATE notion_sync.sync_runs
               SET status = %s,
                   finished_at = NOW(),
                   records_processed = %s,
                   error_message = %s,
                   cursor_reached = %s
             WHERE run_id = %s;
        """
        values = (status, records_processed, error_message, cursor_reached, run_id)
        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                await conn.execute(query, values)
        else:
            await cast(AsyncConnection, db).execute(query, values)

    @staticmethod
    async def get_latest_run(
        db: AsyncConnectionPool | AsyncConnection,
        run_type: RunType | None = None,
    ) -> SyncRunRecord | None:
        query = (
            "SELECT * FROM notion_sync.sync_runs WHERE run_type = %s ORDER BY started_at DESC LIMIT 1"
            if run_type
            else "SELECT * FROM notion_sync.sync_runs ORDER BY started_at DESC LIMIT 1"
        )
        params = (run_type,) if run_type else ()

        async def _exec(conn: AsyncConnection) -> SyncRunRecord | None:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(query, params)
                row = await cur.fetchone()
                if not row:
                    return None
                return SyncRunRecord(
                    run_id=int(row["run_id"]),
                    run_type=row["run_type"],
                    status=row["status"],
                    started_at=row["started_at"],
                    finished_at=row["finished_at"],
                    records_processed=row["records_processed"],
                    error_message=row["error_message"],
                    cursor_reached=row["cursor_reached"],
                )

        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                return await _exec(conn)
        else:
            return await _exec(cast(AsyncConnection, db))
