from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool


@dataclass(frozen=True)
class InboxEventInput:
    event_id: str
    event_type: str
    payload: dict[str, Any]
    entity_type: str | None = None
    entity_id: str | None = None
    event_timestamp: str | datetime | None = None


@dataclass(frozen=True)
class EnqueueResult:
    is_duplicate: bool
    event_id: str


@dataclass(frozen=True)
class InboxEventRecord:
    event_id: str
    event_type: str
    entity_type: str | None
    entity_id: str | None
    event_timestamp: datetime | None
    payload: dict[str, Any]
    status: str
    attempts: int
    received_at: datetime
    available_at: datetime
    locked_at: datetime | None
    processed_at: datetime | None
    last_error: str | None


class InboxRepository:
    """Repository for managing durable webhook ingestion and processing lifecycle."""

    @staticmethod
    async def enqueue_event(
        db: AsyncConnectionPool | AsyncConnection,
        event: InboxEventInput,
    ) -> EnqueueResult:
        query = """
            INSERT INTO notion_sync.sync_inbox (
                event_id, event_type, entity_type, entity_id, event_timestamp, payload, status
            ) VALUES (
                %s, %s, %s, %s, %s, %s::jsonb, 'pending'
            )
            ON CONFLICT (event_id) DO NOTHING
            RETURNING event_id;
        """

        ts = event.event_timestamp
        if isinstance(ts, str):
            try:
                # Handle ISO timestamps with Z or offset
                ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except Exception:
                ts = None

        payload_json = json.dumps(event.payload)
        values = (
            event.event_id,
            event.event_type,
            event.entity_type,
            event.entity_id,
            ts,
            payload_json,
        )

        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(query, values)
                    row = await cur.fetchone()
                    is_dup = row is None
                    return EnqueueResult(is_duplicate=is_dup, event_id=event.event_id)
        else:
            async with cast(AsyncConnection, db).cursor() as cur:
                await cur.execute(query, values)
                row = await cur.fetchone()
                is_dup = row is None
                return EnqueueResult(is_duplicate=is_dup, event_id=event.event_id)

    @staticmethod
    async def claim_next_event(
        db: AsyncConnectionPool | AsyncConnection,
    ) -> InboxEventRecord | None:
        query = """
            WITH claimed AS (
                SELECT event_id
                  FROM notion_sync.sync_inbox
                 WHERE status = 'pending'
                   AND available_at <= NOW()
                 ORDER BY available_at ASC, received_at ASC
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1
            )
            UPDATE notion_sync.sync_inbox i
               SET status    = 'processing',
                   locked_at = NOW(),
                   attempts  = i.attempts + 1
              FROM claimed c
             WHERE i.event_id = c.event_id
            RETURNING i.event_id, i.event_type, i.entity_type, i.entity_id,
                      i.event_timestamp, i.payload, i.status, i.attempts,
                      i.received_at, i.available_at, i.locked_at,
                      i.processed_at, i.last_error;
        """

        async def _exec(conn: AsyncConnection) -> InboxEventRecord | None:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(query)
                row = await cur.fetchone()
                if not row:
                    return None
                payload = row["payload"]
                if isinstance(payload, str):
                    payload = json.loads(payload)
                return InboxEventRecord(
                    event_id=row["event_id"],
                    event_type=row["event_type"],
                    entity_type=row["entity_type"],
                    entity_id=row["entity_id"],
                    event_timestamp=row["event_timestamp"],
                    payload=payload,
                    status=row["status"],
                    attempts=row["attempts"],
                    received_at=row["received_at"],
                    available_at=row["available_at"],
                    locked_at=row["locked_at"],
                    processed_at=row["processed_at"],
                    last_error=row["last_error"],
                )

        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                return await _exec(conn)
        else:
            return await _exec(cast(AsyncConnection, db))

    @staticmethod
    async def settle_event_success(
        db: AsyncConnectionPool | AsyncConnection,
        event_id: str,
    ) -> None:
        query = """
            UPDATE notion_sync.sync_inbox
               SET status = 'processed',
                   processed_at = NOW(),
                   locked_at = NULL,
                   last_error = NULL
             WHERE event_id = %s
        """
        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                await conn.execute(query, (event_id,))
        else:
            await cast(AsyncConnection, db).execute(query, (event_id,))

    @staticmethod
    async def settle_event_retryable(
        db: AsyncConnectionPool | AsyncConnection,
        event_id: str,
        available_at: datetime,
        last_error: str,
    ) -> None:
        query = """
            UPDATE notion_sync.sync_inbox
               SET status = 'pending',
                   available_at = %s,
                   last_error = %s,
                   locked_at = NULL
             WHERE event_id = %s
        """
        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                await conn.execute(query, (available_at, last_error, event_id))
        else:
            await cast(AsyncConnection, db).execute(query, (available_at, last_error, event_id))

    @staticmethod
    async def settle_event_failed(
        db: AsyncConnectionPool | AsyncConnection,
        event_id: str,
        last_error: str,
    ) -> None:
        query = """
            UPDATE notion_sync.sync_inbox
               SET status = 'failed',
                   last_error = %s,
                   locked_at = NULL
             WHERE event_id = %s
        """
        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                await conn.execute(query, (last_error, event_id))
        else:
            await cast(AsyncConnection, db).execute(query, (last_error, event_id))

    @staticmethod
    async def recover_stuck_events(
        db: AsyncConnectionPool | AsyncConnection,
        lease_seconds: int = 300,
    ) -> int:
        query = """
            UPDATE notion_sync.sync_inbox
               SET status = 'pending',
                   locked_at = NULL,
                   available_at = NOW()
             WHERE status = 'processing'
               AND locked_at < NOW() - (%s || ' seconds')::interval
        """
        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                res = await conn.execute(query, (str(lease_seconds),))
                return res.rowcount
        else:
            res = await cast(AsyncConnection, db).execute(query, (str(lease_seconds),))
            return res.rowcount

    @staticmethod
    async def retry_failed_events(
        db: AsyncConnectionPool | AsyncConnection,
        limit: int = 100,
    ) -> int:
        query = """
            UPDATE notion_sync.sync_inbox
               SET status = 'pending',
                   attempts = 0,
                   available_at = NOW()
             WHERE event_id IN (
               SELECT event_id FROM notion_sync.sync_inbox
                WHERE status = 'failed'
                LIMIT %s
             )
        """
        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                res = await conn.execute(query, (limit,))
                return res.rowcount
        else:
            res = await cast(AsyncConnection, db).execute(query, (limit,))
            return res.rowcount
