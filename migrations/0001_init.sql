-- 0001_init.sql — Notion → PostgreSQL sync, V1 current-state schema.
-- Forward-only. There are no destructive down migrations.

CREATE SCHEMA IF NOT EXISTS notion_sync;

-- Migration ledger (the runner bootstraps this table before reading it, so
-- `IF NOT EXISTS` keeps the first run idempotent).
CREATE TABLE IF NOT EXISTS notion_sync.schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- tasks: one current-state row per Notion page. Never a history table.
-- ---------------------------------------------------------------------------
CREATE TABLE notion_sync.notion_tasks (
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
    user_archived           BOOLEAN     NOT NULL DEFAULT FALSE,
    notion_is_archived      BOOLEAN     NOT NULL DEFAULT FALSE,
    notion_in_trash         BOOLEAN     NOT NULL DEFAULT FALSE,
    is_in_source            BOOLEAN     NOT NULL DEFAULT TRUE,
    page_url                TEXT,
    notion_created_time     TIMESTAMPTZ,
    notion_last_edited_time TIMESTAMPTZ,
    raw_properties          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    page_content_json       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT notion_page_id_not_blank CHECK (length(notion_page_id) > 0),
    CONSTRAINT title_not_null CHECK (title IS NOT NULL),
    CONSTRAINT raw_properties_is_object CHECK (jsonb_typeof(raw_properties) = 'object'),
    CONSTRAINT page_content_is_array CHECK (jsonb_typeof(page_content_json) = 'array')
);

COMMENT ON COLUMN notion_sync.notion_tasks.user_archived IS
    'Custom task "Archived" checkbox. Independent of Notion page archival.';
COMMENT ON COLUMN notion_sync.notion_tasks.notion_is_archived IS
    'Notion page-level archived flag (is_archived).';
COMMENT ON COLUMN notion_sync.notion_tasks.notion_in_trash IS
    'Notion trash state or an event-derived tombstone. Never a hard delete.';
COMMENT ON COLUMN notion_sync.notion_tasks.is_in_source IS
    'Whether the page currently belongs to the configured task data source.';
COMMENT ON COLUMN notion_sync.notion_tasks.notion_last_edited_time IS
    'Source last-edit time. NOT a completion timestamp.';
COMMENT ON COLUMN notion_sync.notion_tasks.due_date IS
    'Date-only deadline. Stored as DATE so no timezone can shift the day.';

CREATE INDEX notion_tasks_in_scope_idx
    ON notion_sync.notion_tasks (is_in_source, notion_in_trash);
CREATE INDEX notion_tasks_synced_at_idx
    ON notion_sync.notion_tasks (synced_at);
CREATE INDEX notion_tasks_due_date_idx
    ON notion_sync.notion_tasks (due_date)
    WHERE due_date IS NOT NULL;
CREATE INDEX notion_tasks_status_idx
    ON notion_sync.notion_tasks (status)
    WHERE status IS NOT NULL;
CREATE INDEX notion_tasks_list_idx
    ON notion_sync.notion_tasks (list_name)
    WHERE list_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- inbox: durable webhook event queue. `event_id` is Notion's event ID.
-- ---------------------------------------------------------------------------
CREATE TABLE notion_sync.sync_inbox (
    event_id        TEXT PRIMARY KEY,
    event_type      TEXT        NOT NULL,
    entity_type     TEXT,
    entity_id       TEXT,
    event_timestamp TIMESTAMPTZ,
    payload         JSONB       NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    available_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at       TIMESTAMPTZ,
    processed_at    TIMESTAMPTZ,
    last_error      TEXT,

    CONSTRAINT event_id_not_blank CHECK (length(event_id) > 0),
    CONSTRAINT event_type_not_blank CHECK (length(event_type) > 0),
    CONSTRAINT inbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT inbox_processed_at_matches_status
        CHECK ((status = 'processed') = (processed_at IS NOT NULL))
);

COMMENT ON TABLE notion_sync.sync_inbox IS
    'Durable webhook queue. A 2xx webhook response is only sent after the row commits.';

-- Worker claim path: pending, due, ordered.
CREATE INDEX sync_inbox_claim_idx
    ON notion_sync.sync_inbox (available_at, received_at)
    WHERE status = 'pending';
-- Lease-expiry recovery path.
CREATE INDEX sync_inbox_lease_idx
    ON notion_sync.sync_inbox (locked_at)
    WHERE status = 'processing';
-- Operator triage of failures.
CREATE INDEX sync_inbox_failed_idx
    ON notion_sync.sync_inbox (received_at DESC)
    WHERE status = 'failed';
-- "Is this page already queued?" checks.
CREATE INDEX sync_inbox_entity_idx
    ON notion_sync.sync_inbox (entity_id)
    WHERE entity_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- runs: operational metadata for backfill/reconciliation. Not analytics.
-- ---------------------------------------------------------------------------
CREATE TABLE notion_sync.sync_runs (
    run_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_type          TEXT        NOT NULL
                      CHECK (run_type IN ('initial_backfill', 'reconciliation', 'manual_retry')),
    status            TEXT        NOT NULL
                      CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ,
    records_processed INTEGER     NOT NULL DEFAULT 0 CHECK (records_processed >= 0),
    error_message     TEXT,
    cursor_reached    TEXT,

    CONSTRAINT sync_runs_finished_after_start
        CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX sync_runs_type_started_idx
    ON notion_sync.sync_runs (run_type, started_at DESC);
