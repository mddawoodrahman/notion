"""Unit tests for migration SQL structure and schema constraints."""

import re
from pathlib import Path

MIGRATION_PATH = Path(__file__).resolve().parent.parent.parent / "migrations" / "0001_init.sql"


def test_0001_init_sql_exists_and_is_non_empty() -> None:
    assert MIGRATION_PATH.exists()
    content = MIGRATION_PATH.read_text(encoding="utf-8")
    assert len(content) > 100


def test_contains_schema_notion_sync() -> None:
    sql = MIGRATION_PATH.read_text(encoding="utf-8")
    assert "CREATE SCHEMA IF NOT EXISTS notion_sync;" in sql


def test_contains_notion_tasks_with_all_canonical_v1_fields() -> None:
    sql = MIGRATION_PATH.read_text(encoding="utf-8")
    required_fields = [
        "notion_page_id",
        "title",
        "status",
        "list_name",
        "important",
        "in_my_day",
        "priority",
        "due_date",
        "due_at",
        "reminder_at",
        "user_archived",
        "notion_is_archived",
        "notion_in_trash",
        "is_in_source",
        "page_url",
        "notion_created_time",
        "notion_last_edited_time",
        "raw_properties",
        "page_content_json",
        "synced_at",
    ]
    for field in required_fields:
        assert field in sql


def test_enforces_type_contracts_date_for_due_date_timestamptz_for_due_at() -> None:
    sql = MIGRATION_PATH.read_text(encoding="utf-8")
    assert re.search(r"due_date\s+DATE", sql, re.IGNORECASE)
    assert re.search(r"due_at\s+TIMESTAMPTZ", sql, re.IGNORECASE)
    assert re.search(r"reminder_at\s+TIMESTAMPTZ", sql, re.IGNORECASE)


def test_contains_sync_inbox_with_status_check_constraint_and_indexes() -> None:
    sql = MIGRATION_PATH.read_text(encoding="utf-8")
    assert "CREATE TABLE IF NOT EXISTS notion_sync.sync_inbox" in sql
    assert "CHECK (status IN ('pending','processing','processed','failed'))" in sql
    assert "sync_inbox_claim_idx" in sql
    assert "sync_inbox_lease_idx" in sql
    assert "sync_inbox_failed_idx" in sql


def test_contains_sync_runs_with_status_and_run_type_check_constraints() -> None:
    sql = MIGRATION_PATH.read_text(encoding="utf-8")
    assert "CREATE TABLE IF NOT EXISTS notion_sync.sync_runs" in sql
    assert "CHECK (run_type IN ('initial_backfill','reconciliation','manual_retry'))" in sql
    assert "CHECK (status IN ('running','succeeded','partial','failed'))" in sql


def test_contains_schema_migrations_ledger_table() -> None:
    sql = MIGRATION_PATH.read_text(encoding="utf-8")
    assert "CREATE TABLE IF NOT EXISTS notion_sync.schema_migrations" in sql
