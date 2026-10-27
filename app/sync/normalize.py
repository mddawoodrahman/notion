from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from app.db.tasks_repo import NormalizedTaskRecord
from app.sync.property_map import DEFAULT_PROPERTY_MAP, PropertyNameMapping, find_property

DEFAULT_TIMEZONE = "Asia/Kolkata"


@dataclass
class NormalizeOptions:
    configured_data_source_id: str | None = None
    configured_database_id: str | None = None
    timezone: str = DEFAULT_TIMEZONE
    property_map: PropertyNameMapping | None = None
    body_blocks: list[Any] | None = None


def _format_utc_iso(dt: datetime) -> str:
    utc_dt = dt.astimezone(UTC)
    # Output format matching JS toISOString (e.g. 2026-10-21T10:00:00.000Z)
    millis = int(utc_dt.microsecond / 1000)
    return utc_dt.strftime(f"%Y-%m-%dT%H:%M:%S.{millis:03d}Z")


def _parse_iso(raw_str: str) -> datetime | None:
    try:
        clean = raw_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except Exception:
        return None


def normalize_page(
    page: dict[str, Any] | None,
    options: NormalizeOptions | None = None,
    *,
    configured_data_source_id: str | None = None,
    configured_database_id: str | None = None,
    timezone_str: str | None = None,
    property_map: PropertyNameMapping | None = None,
    body_blocks: list[Any] | None = None,
) -> NormalizedTaskRecord:
    if page is None or not isinstance(page, dict):
        page = {}

    if options is not None:
        opts = options
    else:
        opts = NormalizeOptions(
            configured_data_source_id=configured_data_source_id,
            configured_database_id=configured_database_id,
            timezone=timezone_str or DEFAULT_TIMEZONE,
            property_map=property_map,
            body_blocks=body_blocks,
        )

    raw_props = page.get("properties")
    properties: dict[str, Any] = raw_props if isinstance(raw_props, dict) else {}
    prop_map = opts.property_map or DEFAULT_PROPERTY_MAP
    target_tz_str = opts.timezone or DEFAULT_TIMEZONE

    # 1. Title
    title = ""
    title_prop = find_property(properties, prop_map.title, ["Title", "Name", "Task Name"])
    if not title_prop:
        for val in properties.values():
            if isinstance(val, dict) and val.get("type") == "title":
                title_prop = {"name": "", "value": val}
                break

    if title_prop:
        val = title_prop.get("value")
        if (
            isinstance(val, dict)
            and val.get("type") == "title"
            and isinstance(val.get("title"), list)
        ):
            title = "".join(
                t.get("plain_text", "") for t in val["title"] if isinstance(t, dict)
            ).strip()

    # 2. Status
    status: str | None = None
    status_prop = find_property(properties, prop_map.status, ["State", "Status"])
    if not status_prop:
        for val in properties.values():
            if isinstance(val, dict) and val.get("type") in ("status", "select"):
                status_prop = {"name": "", "value": val}
                break

    if status_prop:
        val = status_prop.get("value")
        if isinstance(val, dict):
            if val.get("type") == "status" and isinstance(val.get("status"), dict):
                status = val["status"].get("name")
            elif val.get("type") == "select" and isinstance(val.get("select"), dict):
                status = val["select"].get("name")

    # 3. List
    list_name: str | None = None
    list_prop = find_property(properties, prop_map.list, ["Category", "Lists"])
    if list_prop:
        val = list_prop.get("value")
        if (
            isinstance(val, dict)
            and val.get("type") == "select"
            and isinstance(val.get("select"), dict)
        ):
            list_name = val["select"].get("name")

    # 4. Important
    important = False
    important_prop = find_property(
        properties, prop_map.important, ["Star", "Starred", "Importance"]
    )
    if important_prop:
        val = important_prop.get("value")
        if isinstance(val, dict) and val.get("type") == "checkbox":
            important = bool(val.get("checkbox"))

    # 5. In My Day
    in_my_day = False
    in_my_day_prop = find_property(properties, prop_map.in_my_day, ["My Day", "MyDay"])
    if in_my_day_prop:
        val = in_my_day_prop.get("value")
        if isinstance(val, dict) and val.get("type") == "checkbox":
            in_my_day = bool(val.get("checkbox"))

    # 6. Priority
    priority: str | None = None
    priority_prop = find_property(properties, prop_map.priority, ["Urgency", "Level"])
    if priority_prop:
        val = priority_prop.get("value")
        if isinstance(val, dict):
            if val.get("type") == "select" and isinstance(val.get("select"), dict):
                priority = val["select"].get("name")
            elif val.get("type") == "status" and isinstance(val.get("status"), dict):
                priority = val["status"].get("name")

    # 7. Due Date & Due At
    due_date: str | None = None
    due_at: str | None = None
    due_prop = find_property(properties, prop_map.due_date, ["Due", "Deadline", "Date"])
    if due_prop:
        val = due_prop.get("value")
        if (
            isinstance(val, dict)
            and val.get("type") == "date"
            and isinstance(val.get("date"), dict)
        ):
            raw_start = val["date"].get("start")
            if isinstance(raw_start, str):
                if "T" in raw_start:
                    date_obj = _parse_iso(raw_start)
                    if date_obj is not None:
                        due_at = _format_utc_iso(date_obj)
                        try:
                            tz = ZoneInfo(target_tz_str)
                            due_date = date_obj.astimezone(tz).strftime("%Y-%m-%d")
                        except Exception:
                            due_date = raw_start.split("T")[0]
                else:
                    due_date = raw_start
                    due_at = None

    # 8. Reminder
    reminder_at: str | None = None
    reminder_prop = find_property(properties, prop_map.reminder, ["Remind", "Reminder Date"])
    if reminder_prop:
        val = reminder_prop.get("value")
        if (
            isinstance(val, dict)
            and val.get("type") == "date"
            and isinstance(val.get("date"), dict)
        ):
            raw_start = val["date"].get("start")
            if isinstance(raw_start, str):
                date_obj = _parse_iso(raw_start)
                if date_obj is not None:
                    reminder_at = _format_utc_iso(date_obj)

    # 9. User Archived (custom checkbox)
    user_archived = False
    user_archived_prop = find_property(
        properties, prop_map.user_archived, ["User Archived", "Archived Task"]
    )
    if user_archived_prop:
        val = user_archived_prop.get("value")
        if isinstance(val, dict) and val.get("type") == "checkbox":
            user_archived = bool(val.get("checkbox"))

    # 10. Notion Page Archival & Trash
    notion_is_archived = bool(page.get("archived", False))
    notion_in_trash = bool(page.get("in_trash", False))

    # 11. Source Membership
    is_in_source = True
    parent = page.get("parent")
    if isinstance(parent, dict):
        parent_id = parent.get("data_source_id") or parent.get("database_id")
        if parent_id:
            clean_parent = str(parent_id).replace("-", "").lower()
            clean_source = (
                opts.configured_data_source_id.replace("-", "").lower()
                if opts.configured_data_source_id
                else None
            )
            clean_db = (
                opts.configured_database_id.replace("-", "").lower()
                if opts.configured_database_id
                else None
            )

            if clean_source or clean_db:
                is_in_source = (clean_parent == clean_source if clean_source else False) or (
                    clean_parent == clean_db if clean_db else False
                )

    created_time_str = None
    if page.get("created_time"):
        dt = _parse_iso(str(page["created_time"]))
        if dt:
            created_time_str = _format_utc_iso(dt)

    last_edited_time_str = None
    if page.get("last_edited_time"):
        dt = _parse_iso(str(page["last_edited_time"]))
        if dt:
            last_edited_time_str = _format_utc_iso(dt)

    return NormalizedTaskRecord(
        notion_page_id=str(page.get("id", "")),
        title=title,
        status=status,
        list_name=list_name,
        important=important,
        in_my_day=in_my_day,
        priority=priority,
        due_date=due_date,
        due_at=due_at,
        reminder_at=reminder_at,
        user_archived=user_archived,
        notion_is_archived=notion_is_archived,
        notion_in_trash=notion_in_trash,
        is_in_source=is_in_source,
        page_url=str(page["url"]) if page.get("url") else None,
        notion_created_time=created_time_str,
        notion_last_edited_time=last_edited_time_str,
        raw_properties=properties,
        # BUG-004: None means "not fetched" (preserve stored content), [] means "genuinely empty page"
        page_content_json=opts.body_blocks if isinstance(opts.body_blocks, list) else None,
        synced_at=_format_utc_iso(datetime.now(UTC)),
    )
