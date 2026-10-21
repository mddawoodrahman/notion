import { resolve } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, getMigrationStatus, withMigrationClient } from '../../db/migrate.js';
import { createPool } from '../../db/pool.js';
import { startTestDatabase, type TestDatabase } from './helpers/test-database.js';

const migrationsDir = resolve(process.cwd(), 'migrations');

describe.sequential('database migrations (real PostgreSQL)', () => {
  let database: TestDatabase;
  let pool: Pool;
  let firstRun: Awaited<ReturnType<typeof applyMigrations>>;

  beforeAll(async () => {
    database = await startTestDatabase();
    firstRun = await applyMigrations(database.url, { migrationsDir });
    pool = createPool(database.url, { max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.stop();
  });

  it('applies 0001_init.sql from an empty database and records the ledger', () => {
    expect(firstRun.appliedNow).toEqual(['0001_init.sql']);
    expect(firstRun.status.applied).toHaveLength(1);
    expect(firstRun.status.pending).toEqual([]);
    expect(firstRun.status.drifted).toEqual([]);
  });

  it('creates the three V1 tables only — no analytics, events or snapshots', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'notion_sync' ORDER BY table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'notion_tasks',
      'schema_migrations',
      'sync_inbox',
      'sync_runs',
    ]);

    const forbidden = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'notion_sync'
          AND table_name IN ('task_events','daily_task_snapshots','task_analytics')`,
    );
    expect(forbidden.rows).toEqual([]);
  });

  it('uses DATE for date-only deadlines and JSONB for raw properties', async () => {
    const columns = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'notion_sync' AND table_name = 'notion_tasks'`,
    );
    const byName = new Map(columns.rows.map((row) => [row.column_name, row.data_type]));

    expect(byName.get('due_date')).toBe('date');
    expect(byName.get('due_at')).toBe('timestamp with time zone');
    expect(byName.get('reminder_at')).toBe('timestamp with time zone');
    expect(byName.get('raw_properties')).toBe('jsonb');
    expect(byName.get('page_content_json')).toBe('jsonb');
    expect(byName.get('notion_page_id')).toBe('text');
  });

  it('creates the queue and lookup indexes', async () => {
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'notion_sync' ORDER BY indexname`,
    );
    const names = indexes.rows.map((row) => row.indexname);
    for (const expected of [
      'notion_tasks_in_scope_idx',
      'notion_tasks_synced_at_idx',
      'notion_tasks_due_date_idx',
      'sync_inbox_claim_idx',
      'sync_inbox_lease_idx',
      'sync_inbox_failed_idx',
      'sync_inbox_entity_idx',
      'sync_runs_type_started_idx',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('rejects illegal queue/task states at the database layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO notion_sync.sync_inbox (event_id, event_type, payload, status)
         VALUES ('evt-bad-status', 'page.created', '{}'::jsonb, 'bogus')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      pool.query(
        `INSERT INTO notion_sync.sync_inbox (event_id, event_type, payload, attempts)
         VALUES ('evt-negative', 'page.created', '{}'::jsonb, -1)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      pool.query(
        `INSERT INTO notion_sync.sync_inbox (event_id, event_type, payload)
         VALUES ('evt-dup', 'page.created', '{}'::jsonb),
                ('evt-dup', 'page.created', '{}'::jsonb)`,
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await expect(
      pool.query(
        `INSERT INTO notion_sync.sync_runs (run_type, status)
         VALUES ('productivity_report', 'succeeded')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      pool.query(
        `INSERT INTO notion_sync.notion_tasks (notion_page_id, title, raw_properties)
         VALUES ('page-bad-json', 'x', '[]'::jsonb)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps a date-only deadline as an unshifted YYYY-MM-DD string', async () => {
    await pool.query(
      `INSERT INTO notion_sync.notion_tasks (notion_page_id, title, due_date)
       VALUES ('page-date', 'Date task', $1::date)`,
      ['2026-10-21'],
    );
    const result = await pool.query<{ due_date: string }>(
      `SELECT due_date FROM notion_sync.notion_tasks WHERE notion_page_id = 'page-date'`,
    );
    expect(result.rows[0]?.due_date).toBe('2026-10-21');
    expect(typeof result.rows[0]?.due_date).toBe('string');
  });

  it('stores time-bearing timestamps and unknown JSON properties losslessly', async () => {
    const raw = {
      Name: { type: 'title', title: [{ plain_text: 'Task' }] },
      'Some New Property': { type: 'verification', verification: { state: 'verified' } },
      Numbers: { type: 'number', number: 42.5 },
    };

    await pool.query(
      `INSERT INTO notion_sync.notion_tasks
         (notion_page_id, title, due_at, raw_properties, page_content_json)
       VALUES ('page-json', 'JSON task', $1::timestamptz, $2::jsonb, $3::jsonb)`,
      ['2026-10-21T23:30:00+14:00', JSON.stringify(raw), JSON.stringify([{ type: 'paragraph' }])],
    );

    const result = await pool.query<{
      due_at: Date;
      raw_properties: unknown;
      page_content_json: unknown;
    }>(
      `SELECT due_at, raw_properties, page_content_json
         FROM notion_sync.notion_tasks WHERE notion_page_id = 'page-json'`,
    );

    expect(result.rows[0]?.due_at.toISOString()).toBe('2026-10-21T09:30:00.000Z');
    expect(result.rows[0]?.raw_properties).toEqual(raw);
    expect(result.rows[0]?.page_content_json).toEqual([{ type: 'paragraph' }]);
  });

  it('re-running migrations is a no-op', async () => {
    const second = await applyMigrations(database.url, { migrationsDir });
    expect(second.appliedNow).toEqual([]);
    expect(second.status.applied).toHaveLength(1);
    expect(second.status.pending).toEqual([]);
  });

  it('reports status and detects checksum drift without re-applying', async () => {
    const status = await withMigrationClient(database.url, (client) =>
      getMigrationStatus(client, migrationsDir),
    );
    expect(status.applied).toHaveLength(1);
    expect(status.pending).toEqual([]);

    await pool.query(
      `UPDATE notion_sync.schema_migrations SET checksum = 'deadbeef' WHERE version = '0001_init.sql'`,
    );

    await expect(applyMigrations(database.url, { migrationsDir })).rejects.toThrow(
      /checksum mismatch/i,
    );
  });
});
