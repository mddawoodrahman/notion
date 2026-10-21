-- 0001_init.sql
-- Notion Tasks to PostgreSQL Synchronization Service V1 Schema

CREATE SCHEMA IF NOT EXISTS notion_sync;

-- ---------------------------------------------------------------- tasks
CREATE TABLE IF NOT EXISTS notion_sync.notion_tasks (
    notion_page_id          TEXT PRIMARY KEY,
    title                   TEXT        NOT NULL DEFAULT '',
    status                  TEXT,
    list_name               TEXT,
    important               BOOLEAN     NOT NULL DEFAULT FALSE,
    in_my_day               BOOLEAN     NOT NULL DEFAULT FALSE,
    priority                TEXT,
    due_date                DATE,
    due_at                  TIMESTAMPTZ,
    reminder_at             TIMESTAMPTZ,
    user_archived           BOOLEAN     NOT NULL DEFAULT FALSE,   -- custom "Archived" property
    notion_is_archived      BOOLEAN     NOT NULL DEFAULT FALSE,   -- Notion page archived
    notion_in_trash         BOOLEAN     NOT NULL DEFAULT FALSE,   -- Notion trash / event tombstone
    is_in_source            BOOLEAN     NOT NULL DEFAULT TRUE,    -- belongs to configured data source
    page_url                TEXT,
    notion_created_time     TIMESTAMPTZ,
    notion_last_edited_time TIMESTAMPTZ,
    raw_properties          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    page_content_json       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT notion_page_id_not_blank CHECK (length(notion_page_id) > 0)
);

COMMENT ON COLUMN notion_sync.notion_tasks.user_archived IS
    'Custom task "Archived" checkbox. Independent of Notion page archival.';
COMMENT ON COLUMN notion_sync.notion_tasks.notion_is_archived IS
    'Notion page-level archived flag.';
COMMENT ON COLUMN notion_sync.notion_tasks.notion_in_trash IS
    'Notion trash state, or an event-derived tombstone. Never a hard delete.';
COMMENT ON COLUMN notion_sync.notion_tasks.notion_last_edited_time IS
    'Source last-edit time. NOT a completion timestamp.';

-- Active-task queries and stale-record sweeps
CREATE INDEX IF NOT EXISTS notion_tasks_in_scope_idx
    ON notion_sync.notion_tasks (is_in_source, notion_in_trash);
CREATE INDEX IF NOT EXISTS notion_tasks_synced_at_idx
    ON notion_sync.notion_tasks (synced_at);
CREATE INDEX IF NOT EXISTS notion_tasks_due_date_idx
    ON notion_sync.notion_tasks (due_date)
    WHERE due_date IS NOT NULL;

-- ---------------------------------------------------------------- inbox
CREATE TABLE IF NOT EXISTS notion_sync.sync_inbox (
    event_id        TEXT PRIMARY KEY,
    event_type      TEXT        NOT NULL,
    entity_type     TEXT,
    entity_id       TEXT,
    event_timestamp TIMESTAMPTZ,
    payload         JSONB       NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','processed','failed')),
    attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    available_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at       TIMESTAMPTZ,
    processed_at    TIMESTAMPTZ,
    last_error      TEXT
);

-- Worker claim path: pending, due, ordered
CREATE INDEX IF NOT EXISTS sync_inbox_claim_idx
    ON notion_sync.sync_inbox (available_at, received_at)
    WHERE status = 'pending';
-- Lease-expiry recovery path
CREATE INDEX IF NOT EXISTS sync_inbox_lease_idx
    ON notion_sync.sync_inbox (locked_at)
    WHERE status = 'processing';
-- Operator triage of failures
CREATE INDEX IF NOT EXISTS sync_inbox_failed_idx
    ON notion_sync.sync_inbox (received_at DESC)
    WHERE status = 'failed';
-- Entity lookups
CREATE INDEX IF NOT EXISTS sync_inbox_entity_idx
    ON notion_sync.sync_inbox (entity_id)
    WHERE entity_id IS NOT NULL;

-- ---------------------------------------------------------------- runs
CREATE TABLE IF NOT EXISTS notion_sync.sync_runs (
    run_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_type          TEXT        NOT NULL
                      CHECK (run_type IN ('initial_backfill','reconciliation','manual_retry')),
    status            TEXT        NOT NULL
                      CHECK (status IN ('running','succeeded','partial','failed')),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ,
    records_processed INTEGER     NOT NULL DEFAULT 0 CHECK (records_processed >= 0),
    error_message     TEXT,
    cursor_reached    TEXT,
    CONSTRAINT sync_runs_finished_after_start
        CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS sync_runs_type_started_idx
    ON notion_sync.sync_runs (run_type, started_at DESC);

-- ---------------------------------------------------------------- migration ledger
CREATE TABLE IF NOT EXISTS notion_sync.schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum    TEXT NOT NULL
);
