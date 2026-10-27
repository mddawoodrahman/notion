"""Unit tests for pure, I/O-free property normalization."""

from app.sync.normalize import NormalizeOptions, normalize_page


def test_normalizes_complete_notion_task_with_all_typed_properties() -> None:
    mock_page = {
        "id": "9e5c468a-6bb2-4a0b-8d69-cb1477123456",
        "created_time": "2026-10-21T10:00:00.000Z",
        "last_edited_time": "2026-10-21T11:30:00.000Z",
        "url": "https://www.notion.so/Test-Task-9e5c468a6bb24a0b8d69cb1477123456",
        "archived": False,
        "in_trash": False,
        "parent": {
            "type": "data_source_id",
            "data_source_id": "ds_tasks_12345678",
        },
        "properties": {
            "Task": {
                "type": "title",
                "title": [{"plain_text": "Deploy Notion "}, {"plain_text": "Sync Service"}],
            },
            "Status": {
                "type": "status",
                "status": {"name": "In Progress"},
            },
            "List": {
                "type": "select",
                "select": {"name": "Work"},
            },
            "Important": {
                "type": "checkbox",
                "checkbox": True,
            },
            "In My Day": {
                "type": "checkbox",
                "checkbox": True,
            },
            "Priority": {
                "type": "select",
                "select": {"name": "High"},
            },
            "Due Date": {
                "type": "date",
                "date": {"start": "2026-10-25"},
            },
            "Reminder": {
                "type": "date",
                "date": {"start": "2026-10-25T09:00:00.000Z"},
            },
            "Archived": {
                "type": "checkbox",
                "checkbox": False,
            },
            "Custom Unknown Prop": {
                "type": "rollup",
                "rollup": {"number": 42},
            },
        },
    }

    record = normalize_page(
        mock_page,
        options=NormalizeOptions(configured_data_source_id="ds_tasks_12345678"),
    )

    assert record.notion_page_id == "9e5c468a-6bb2-4a0b-8d69-cb1477123456"
    assert record.title == "Deploy Notion Sync Service"
    assert record.status == "In Progress"
    assert record.list_name == "Work"
    assert record.important is True
    assert record.in_my_day is True
    assert record.priority == "High"
    assert record.due_date == "2026-10-25"
    assert record.due_at is None
    assert record.reminder_at == "2026-10-25T09:00:00.000Z"
    assert record.user_archived is False
    assert record.notion_is_archived is False
    assert record.notion_in_trash is False
    assert record.is_in_source is True
    assert "Custom Unknown Prop" in record.raw_properties


def test_distinguishes_date_only_from_timed_due_dates() -> None:
    # 1. Date-only
    date_only_page = {
        "id": "task-date-only",
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Date only task"}]},
            "Due Date": {"type": "date", "date": {"start": "2026-11-01"}},
        },
    }
    date_only_rec = normalize_page(date_only_page)
    assert date_only_rec.due_date == "2026-11-01"
    assert date_only_rec.due_at is None

    # 2. Timed instant
    timed_page = {
        "id": "task-timed",
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Timed task"}]},
            "Due Date": {"type": "date", "date": {"start": "2026-11-01T15:30:00.000Z"}},
        },
    }
    timed_rec = normalize_page(timed_page)
    assert timed_rec.due_date == "2026-11-01"
    assert timed_rec.due_at == "2026-11-01T15:30:00.000Z"


def test_handles_missing_null_or_empty_properties_gracefully() -> None:
    empty_page = {
        "id": "task-empty",
        "properties": {
            "Task": {"type": "title", "title": []},
            "Status": {"type": "status", "status": None},
            "List": {"type": "select", "select": None},
            "Important": {"type": "checkbox", "checkbox": False},
            "Due Date": {"type": "date", "date": None},
        },
    }

    record = normalize_page(empty_page)
    assert record.title == ""
    assert record.status is None
    assert record.list_name is None
    assert record.important is False
    assert record.in_my_day is False
    assert record.due_date is None
    assert record.due_at is None


def test_distinguishes_custom_task_archived_checkbox_from_notion_page_archival_and_trash() -> None:
    archived_task_page = {
        "id": "task-archived",
        "archived": True,
        "in_trash": False,
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Archived Task"}]},
            "Archived": {"type": "checkbox", "checkbox": False},
        },
    }

    rec1 = normalize_page(archived_task_page)
    assert rec1.notion_is_archived is True
    assert rec1.user_archived is False
    assert rec1.notion_in_trash is False

    user_archived_page = {
        "id": "task-user-archived",
        "archived": False,
        "in_trash": False,
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "User Archived Task"}]},
            "Archived": {"type": "checkbox", "checkbox": True},
        },
    }

    rec2 = normalize_page(user_archived_page)
    assert rec2.notion_is_archived is False
    assert rec2.user_archived is True
    assert rec2.notion_in_trash is False


def test_marks_is_in_source_false_when_page_moves_outside_configured_data_source() -> None:
    moved_page = {
        "id": "task-moved",
        "parent": {
            "type": "data_source_id",
            "data_source_id": "other_datasource_999",
        },
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Moved task"}]},
        },
    }

    record = normalize_page(
        moved_page,
        options=NormalizeOptions(configured_data_source_id="expected_datasource_111"),
    )

    assert record.is_in_source is False


def test_derives_due_date_for_timed_due_dates_in_the_configured_iana_timezone_doc_001() -> None:
    timed_page = {
        "id": "task-timezone",
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Timezone task"}]},
            "Due Date": {"type": "date", "date": {"start": "2026-03-11T02:00:00+05:30"}},
        },
    }

    # 02:00 IST on Mar 11 == 2026-03-10T20:30Z
    kolkata = normalize_page(timed_page, options=NormalizeOptions(timezone="Asia/Kolkata"))
    assert kolkata.due_at == "2026-03-10T20:30:00.000Z"
    assert kolkata.due_date == "2026-03-11"

    # ...which is still the evening of Mar 10 in New York
    new_york = normalize_page(timed_page, options=NormalizeOptions(timezone="America/New_York"))
    assert new_york.due_date == "2026-03-10"

    # Unset timezone falls back to Asia/Kolkata (SYNC_TIMEZONE default)
    defaulted = normalize_page(timed_page)
    assert defaulted.due_date == "2026-03-11"


def test_keeps_date_only_due_dates_verbatim_regardless_of_timezone_doc_001() -> None:
    date_only_page = {
        "id": "task-date-only-tz",
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Calendar date task"}]},
            "Due Date": {"type": "date", "date": {"start": "2026-03-11"}},
        },
    }

    record = normalize_page(date_only_page, options=NormalizeOptions(timezone="America/New_York"))
    assert record.due_date == "2026-03-11"
    assert record.due_at is None


def test_distinguishes_fetched_but_empty_content_from_content_never_fetched_bug_004() -> None:
    page = {
        "id": "task-content",
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Content task"}]},
        },
    }

    # Fetched and empty: the page genuinely has no body blocks
    empty = normalize_page(page, options=NormalizeOptions(body_blocks=[]))
    assert empty.page_content_json == []

    # Not fetched: null instructs upsert to preserve any stored content
    not_fetched = normalize_page(page)
    assert not_fetched.page_content_json is None

    fetched = normalize_page(page, options=NormalizeOptions(body_blocks=[{"type": "paragraph"}]))
    assert fetched.page_content_json == [{"type": "paragraph"}]
