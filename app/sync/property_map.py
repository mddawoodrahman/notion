from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PropertyNameMapping:
    title: str = "Task"
    status: str = "Status"
    list: str = "List"
    important: str = "Important"
    in_my_day: str = "In My Day"
    priority: str = "Priority"
    due_date: str = "Due Date"
    reminder: str = "Reminder"
    user_archived: str = "Archived"


DEFAULT_PROPERTY_MAP = PropertyNameMapping()


def find_property(
    properties: dict[str, Any],
    preferred_name: str,
    alternatives: list[str] | None = None,
) -> dict[str, Any] | None:
    """Finds a property in the properties dictionary using candidate names (case-insensitive)."""
    candidates = [preferred_name.lower().strip()]
    if alternatives:
        candidates.extend(a.lower().strip() for a in alternatives)

    for key, value in properties.items():
        if key.lower().strip() in candidates:
            return {"name": key, "value": value}

    return None
