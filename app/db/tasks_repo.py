from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool


@dataclass
class NormalizedTaskRecord:
    notion_page_id: str
    title: str
    status: str | None
    list_name: str | None
    important: bool
    in_my_day: bool
    priority: str | None
    due_date: str | None
    due_at: str | None
    reminder_at: str | None
    user_archived: bool
    notion_is_archived: bool
    notion_in_trash: bool
    is_in_source: bool
    page_url: str | None
    notion_created_time: str | None
    notion_last_edited_time: str | None
    raw_properties: dict[str, Any]
    page_content_json: list[Any] | None
    synced_at: str


class TasksRepository:
    """Repository for upserting and querying normalized Notion task rows."""

    UPSERT_QUERY = """
      INSERT INTO notion_sync.notion_tasks (
        notion_page_id, title, status, list_name, important, in_my_day, priority,
        due_date, due_at, reminder_at, user_archived, notion_is_archived,
        notion_in_trash, is_in_source, page_url, notion_created_time,
        notion_last_edited_time, raw_properties, page_content_json, synced_at
      ) VALUES (
        %(notion_page_id)s, %(title)s, %(status)s, %(list_name)s, %(important)s, %(in_my_day)s, %(priority)s,
        %(due_date)s, %(due_at)s, %(reminder_at)s, %(user_archived)s, %(notion_is_archived)s,
        %(notion_in_trash)s, %(is_in_source)s, %(page_url)s, %(notion_created_time)s,
        %(notion_last_edited_time)s, %(raw_properties)s::jsonb, COALESCE(%(page_content_json)s::jsonb, '[]'::jsonb), NOW()
      )
      ON CONFLICT (notion_page_id) DO UPDATE SET
        title                   = EXCLUDED.title,
        status                  = EXCLUDED.status,
        list_name               = EXCLUDED.list_name,
        important               = EXCLUDED.important,
        in_my_day               = EXCLUDED.in_my_day,
        priority                = EXCLUDED.priority,
        due_date                = EXCLUDED.due_date,
        due_at                  = EXCLUDED.due_at,
        reminder_at             = EXCLUDED.reminder_at,
        user_archived           = EXCLUDED.user_archived,
        notion_is_archived      = EXCLUDED.notion_is_archived,
        notion_in_trash         = EXCLUDED.notion_in_trash,
        is_in_source            = EXCLUDED.is_in_source,
        page_url                = EXCLUDED.page_url,
        notion_created_time     = EXCLUDED.notion_created_time,
        notion_last_edited_time = EXCLUDED.notion_last_edited_time,
        raw_properties          = EXCLUDED.raw_properties,
        page_content_json       = COALESCE(%(page_content_json)s::jsonb, notion_sync.notion_tasks.page_content_json),
        synced_at               = NOW()
      WHERE notion_sync.notion_tasks.notion_last_edited_time IS NULL
         OR EXCLUDED.notion_last_edited_time >= notion_sync.notion_tasks.notion_last_edited_time
      RETURNING *;
    """

    @classmethod
    def _prepare_params(cls, task: NormalizedTaskRecord | dict[str, Any]) -> dict[str, Any]:
        if isinstance(task, dict):
            notion_page_id = task.get("notion_page_id")
            title = task.get("title", "")
            status = task.get("status")
            list_name = task.get("list_name")
            important = bool(task.get("important", False))
            in_my_day = bool(task.get("in_my_day", False))
            priority = task.get("priority")
            due_date = task.get("due_date")
            due_at = task.get("due_at")
            reminder_at = task.get("reminder_at")
            user_archived = bool(task.get("user_archived", False))
            notion_is_archived = bool(task.get("notion_is_archived", False))
            notion_in_trash = bool(task.get("notion_in_trash", False))
            is_in_source = bool(task.get("is_in_source", True))
            page_url = task.get("page_url")
            notion_created_time = task.get("notion_created_time")
            notion_last_edited_time = task.get("notion_last_edited_time")
            raw_properties = task.get("raw_properties", {})
            page_content_json = task.get("page_content_json")
        else:
            notion_page_id = task.notion_page_id
            title = task.title
            status = task.status
            list_name = task.list_name
            important = task.important
            in_my_day = task.in_my_day
            priority = task.priority
            due_date = task.due_date
            due_at = task.due_at
            reminder_at = task.reminder_at
            user_archived = task.user_archived
            notion_is_archived = task.notion_is_archived
            notion_in_trash = task.notion_in_trash
            is_in_source = task.is_in_source
            page_url = task.page_url
            notion_created_time = task.notion_created_time
            notion_last_edited_time = task.notion_last_edited_time
            raw_properties = task.raw_properties
            page_content_json = task.page_content_json

        # Parse timestamps into datetime objects if strings
        def to_dt(v: str | datetime | None) -> datetime | None:
            if v is None:
                return None
            if isinstance(v, datetime):
                return v
            try:
                return datetime.fromisoformat(v.replace("Z", "+00:00"))
            except Exception:
                return None

        content_json_str = None
        if page_content_json is not None:
            content_json_str = json.dumps(page_content_json)

        return {
            "notion_page_id": notion_page_id,
            "title": title,
            "status": status,
            "list_name": list_name,
            "important": important,
            "in_my_day": in_my_day,
            "priority": priority,
            "due_date": due_date,
            "due_at": to_dt(due_at),
            "reminder_at": to_dt(reminder_at),
            "user_archived": user_archived,
            "notion_is_archived": notion_is_archived,
            "notion_in_trash": notion_in_trash,
            "is_in_source": is_in_source,
            "page_url": page_url,
            "notion_created_time": to_dt(notion_created_time),
            "notion_last_edited_time": to_dt(notion_last_edited_time),
            "raw_properties": json.dumps(raw_properties or {}),
            "page_content_json": content_json_str,
        }

    @classmethod
    async def upsert_task(
        cls,
        db: AsyncConnectionPool | AsyncConnection,
        task: NormalizedTaskRecord | dict[str, Any],
    ) -> dict[str, Any] | None:
        params = cls._prepare_params(task)

        async def _exec(conn: AsyncConnection) -> dict[str, Any] | None:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(cls.UPSERT_QUERY, params)
                return await cur.fetchone()

        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                return await _exec(conn)
        else:
            return await _exec(cast(AsyncConnection, db))

    @classmethod
    async def get_task_by_id(
        cls,
        db: AsyncConnectionPool | AsyncConnection,
        page_id: str,
    ) -> dict[str, Any] | None:
        query = "SELECT * FROM notion_sync.notion_tasks WHERE notion_page_id = %s"

        async def _exec(conn: AsyncConnection) -> dict[str, Any] | None:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(query, (page_id,))
                return await cur.fetchone()

        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                return await _exec(conn)
        else:
            return await _exec(cast(AsyncConnection, db))

    @classmethod
    async def mark_task_in_trash(
        cls,
        db: AsyncConnectionPool | AsyncConnection,
        page_id: str,
    ) -> bool:
        query = """
            UPDATE notion_sync.notion_tasks
               SET notion_in_trash = TRUE, synced_at = NOW()
              WHERE notion_page_id = %s
        """
        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                res = await conn.execute(query, (page_id,))
                return res.rowcount > 0
        else:
            res = await cast(AsyncConnection, db).execute(query, (page_id,))
            return res.rowcount > 0

    @classmethod
    async def list_in_scope_task_ids(
        cls,
        db: AsyncConnectionPool | AsyncConnection,
    ) -> list[str]:
        query = """
            SELECT notion_page_id
              FROM notion_sync.notion_tasks
             WHERE is_in_source = TRUE AND notion_in_trash = FALSE
        """

        async def _exec(conn: AsyncConnection) -> list[str]:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(query)
                rows = await cur.fetchall()
                return [r["notion_page_id"] for r in rows]

        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                return await _exec(conn)
        else:
            return await _exec(cast(AsyncConnection, db))

    @classmethod
    async def mark_tasks_out_of_source(
        cls,
        db: AsyncConnectionPool | AsyncConnection,
        active_page_ids: list[str],
    ) -> int:
        if not active_page_ids:
            return 0

        query = """
            UPDATE notion_sync.notion_tasks
               SET is_in_source = FALSE, synced_at = NOW()
              WHERE is_in_source = TRUE AND NOT (notion_page_id = ANY(%s))
        """
        if hasattr(db, "connection") and not hasattr(db, "cursor"):
            async with cast(AsyncConnectionPool, db).connection() as conn:
                res = await conn.execute(query, (active_page_ids,))
                return res.rowcount
        else:
            res = await cast(AsyncConnection, db).execute(query, (active_page_ids,))
            return res.rowcount
