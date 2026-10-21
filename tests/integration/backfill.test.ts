import { resolve } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../db/migrate.js';
import { createPool } from '../../db/pool.js';
import { TasksRepository } from '../../db/tasks-repo.js';
import { validateConfig } from '../../src/config.js';
import { runBackfill } from '../../sync/backfill.js';
import type { NotionSyncClient } from '../../sync/notion-client.js';
import { startTestDatabase, type TestDatabase } from './helpers/test-database.js';

const migrationsDir = resolve(process.cwd(), 'migrations');
const DATA_SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const DATABASE_ID = '22222222-2222-4222-8222-222222222222';
const CONFIG = validateConfig({
  NODE_ENV: 'test',
  NOTION_DATABASE_ID: DATABASE_ID,
  SYNC_PAGE_SIZE: '2',
  SYNC_SYNC_BODY_CONTENT: 'false',
});

interface FakePage {
  id: string;
  properties: Record<string, unknown>;
  parent?: Record<string, unknown>;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
}

function title(text: string) {
  return { type: 'title', title: [{ plain_text: text }] };
}

function page(id: string, text: string, overrides: Partial<FakePage> = {}): FakePage {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    created_time: '2026-10-01T00:00:00.000Z',
    last_edited_time: '2026-10-20T00:00:00.000Z',
    in_trash: false,
    archived: false,
    parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
    properties: { Task: title(text) },
    ...overrides,
  };
}

interface PageBatch {
  results: FakePage[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Minimal stand-in for the two Notion calls `runBackfill` makes. Everything
 * else (SQL, constraints, upserts, runs ledger) hits real PostgreSQL.
 */
function fakeClient(batches: PageBatch[]) {
  const queryDataSourcePages = vi.fn();
  for (const batch of batches) {
    queryDataSourcePages.mockResolvedValueOnce(batch);
  }

  return {
    client: {
      resolveDataSource: vi.fn().mockResolvedValue(DATA_SOURCE_ID),
      queryDataSourcePages,
    } as unknown as NotionSyncClient,
    queryDataSourcePages,
  };
}

async function count(pool: Pool, table: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notion_sync.${table}`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function taskRow(pool: Pool, pageId: string): Promise<Record<string, any> | undefined> {
  const result = await pool.query('SELECT * FROM notion_sync.notion_tasks WHERE notion_page_id = $1', [
    pageId,
  ]);
  return result.rows[0];
}

async function runRow(pool: Pool, runId: number): Promise<Record<string, any> | undefined> {
  const result = await pool.query('SELECT * FROM notion_sync.sync_runs WHERE run_id = $1', [runId]);
  return result.rows[0];
}

describe.sequential('initial backfill (real PostgreSQL, mocked Notion)', () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await startTestDatabase();
    pool = createPool(database.url);
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.stop();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE notion_sync.notion_tasks, notion_sync.sync_inbox, notion_sync.sync_runs RESTART IDENTITY',
    );
  });

  it('imports every page across cursor pages and records a succeeded run', async () => {
    const { client, queryDataSourcePages } = fakeClient([
      {
        results: [page('p1', 'One'), page('p2', 'Two')],
        next_cursor: 'cursor-2',
        has_more: true,
      },
      { results: [page('p3', 'Three')], next_cursor: null, has_more: false },
    ]);

    const result = await runBackfill({ client, pool, config: CONFIG });

    expect(result).toMatchObject({
      status: 'succeeded',
      recordsProcessed: 3,
      pageFailures: 0,
      dataSourceId: DATA_SOURCE_ID,
    });
    expect(result.runId).not.toBeNull();

    expect(queryDataSourcePages).toHaveBeenNthCalledWith(1, DATA_SOURCE_ID, {
      startCursor: undefined,
      pageSize: 2,
    });
    expect(queryDataSourcePages).toHaveBeenNthCalledWith(2, DATA_SOURCE_ID, {
      startCursor: 'cursor-2',
      pageSize: 2,
    });

    expect(await count(pool, 'notion_tasks')).toBe(3);
    expect((await taskRow(pool, 'p1'))?.title).toBe('One');

    const run = await runRow(pool, result.runId as number);
    expect(run).toMatchObject({
      run_type: 'initial_backfill',
      status: 'succeeded',
      records_processed: 3,
    });
    expect(run?.finished_at).toBeInstanceOf(Date);
  });

  it('is re-runnable without creating duplicates (AT-02)', async () => {
    const batches: PageBatch[] = [
      { results: [page('p1', 'One'), page('p2', 'Two')], next_cursor: null, has_more: false },
    ];

    const first = fakeClient(batches);
    await runBackfill({ client: first.client, pool, config: CONFIG });
    const before = await taskRow(pool, 'p1');

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));

    const second = fakeClient(batches);
    const result = await runBackfill({ client: second.client, pool, config: CONFIG });
    const after = await taskRow(pool, 'p1');

    expect(result).toMatchObject({ status: 'succeeded', recordsProcessed: 2 });
    expect(await count(pool, 'notion_tasks')).toBe(2);
    expect((after?.synced_at as Date).getTime()).toBeGreaterThan((before?.synced_at as Date).getTime());
  });

  it('keeps pages that moved out of the source as out-of-scope rows', async () => {
    const { client } = fakeClient([
      {
        results: [
          page('p1', 'In source'),
          page('p2', 'Moved', {
            parent: { type: 'data_source_id', data_source_id: '99999999-9999-4999-8999-999999999999' },
          }),
        ],
        next_cursor: null,
        has_more: false,
      },
    ]);

    await runBackfill({ client, pool, config: CONFIG });

    expect((await taskRow(pool, 'p1'))?.is_in_source).toBe(true);
    expect((await taskRow(pool, 'p2'))?.is_in_source).toBe(false);
    expect(await count(pool, 'notion_tasks')).toBe(2);
  });

  it('supports a dry run that writes neither tasks nor a run row', async () => {
    const { client, queryDataSourcePages } = fakeClient([
      {
        results: [page('p1', 'One'), page('p2', 'Two')],
        next_cursor: null,
        has_more: false,
      },
    ]);

    const result = await runBackfill({ client, pool, config: CONFIG, dryRun: true });

    expect(result).toMatchObject({
      status: 'succeeded',
      recordsProcessed: 2,
      pageFailures: 0,
      runId: null,
    });
    expect(queryDataSourcePages).toHaveBeenCalledTimes(1);
    expect(await count(pool, 'notion_tasks')).toBe(0);
    expect(await count(pool, 'sync_runs')).toBe(0);
  });

  it('records a per-page failure as a partial run with a sanitized error', async () => {
    const { client } = fakeClient([
      { results: [page('p1', 'Good'), page('p2', 'Bad')], next_cursor: null, has_more: false },
    ]);

    const originalUpsert = TasksRepository.upsertTask;
    const upsertSpy = vi
      .spyOn(TasksRepository, 'upsertTask')
      .mockImplementation(async (db, record) => {
        if (record.notion_page_id === 'p2') {
          throw new Error(
            'write failed for secret_abcdef1234567890 via postgresql://user:topsecret@db.example/app',
          );
        }
        return originalUpsert(db, record);
      });

    try {
      const result = await runBackfill({ client, pool, config: CONFIG });

      expect(result).toMatchObject({ status: 'partial', recordsProcessed: 1, pageFailures: 1 });
      expect(await count(pool, 'notion_tasks')).toBe(1);

      const run = await runRow(pool, result.runId as number);
      expect(run?.status).toBe('partial');
      expect(run?.records_processed).toBe(1);
      expect(run?.error_message).not.toContain('secret_abcdef1234567890');
      expect(run?.error_message).not.toContain('topsecret');
      expect(run?.error_message).toContain('[REDACTED_NOTION_KEY]');
    } finally {
      upsertSpy.mockRestore();
    }
  });

  it('records an aborted scan as failed and keeps the cursor reached', async () => {
    const queryDataSourcePages = vi
      .fn()
      .mockResolvedValueOnce({
        results: [page('p1', 'One')],
        next_cursor: 'cursor-1',
        has_more: true,
      })
      .mockRejectedValueOnce(new Error('Notion outage for secret_abcdef1234567890'));

    const client = {
      resolveDataSource: vi.fn().mockResolvedValue(DATA_SOURCE_ID),
      queryDataSourcePages,
    } as unknown as NotionSyncClient;

    await expect(runBackfill({ client, pool, config: CONFIG })).rejects.toThrow(/Notion outage/);

   expect(await count(pool, 'notion_tasks')).toBe(1);

    const run = await runRow(pool, 1);
    expect(run).toMatchObject({
      status: 'failed',
      records_processed: 1,
      cursor_reached: 'cursor-1',
    });
    expect(run?.error_message).not.toContain('secret_abcdef1234567890');
    expect(run?.error_message).toContain('[REDACTED_NOTION_KEY]');
  });
});
