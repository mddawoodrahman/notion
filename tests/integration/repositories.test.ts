import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../db/migrate.js';
import { createPool, withTransaction } from '../../db/pool.js';
import { InboxRepository } from '../../db/inbox-repo.js';
import { RunsRepository } from '../../db/runs-repo.js';
import { TasksRepository } from '../../db/tasks-repo.js';
import type { NormalizedTaskRecord } from '../../sync/normalize.js';
import { startTestDatabase, type TestDatabase } from './helpers/test-database.js';

const migrationsDir = resolve(process.cwd(), 'migrations');

function task(overrides: Partial<NormalizedTaskRecord> = {}): NormalizedTaskRecord {
  return {
    notion_page_id: '11111111-1111-4111-8111-111111111111',
    title: 'Write the report',
    status: 'Todo',
    list_name: 'Work',
    important: false,
    in_my_day: false,
    priority: 'High',
    due_date: '2026-10-21',
    due_at: null,
    reminder_at: null,
    user_archived: false,
    notion_is_archived: false,
    notion_in_trash: false,
    is_in_source: true,
    page_url: 'https://www.notion.so/11111111111141118111111111111111',
    notion_created_time: '2026-10-01T08:00:00.000Z',
    notion_last_edited_time: '2026-10-20T12:00:00.000Z',
    raw_properties: {
      Name: { type: 'title', title: [{ plain_text: 'Write the report' }] },
      'Unknown Future': { type: 'future_widget', future_widget: { hard: 'to map' } },
    },
    page_content_json: [],
    synced_at: new Date().toISOString(),
    ...overrides,
  };
}

async function countTasks(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM notion_sync.notion_tasks',
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function getTaskRow(pool: Pool, pageId: string): Promise<Record<string, any> | undefined> {
  const result = await pool.query('SELECT * FROM notion_sync.notion_tasks WHERE notion_page_id = $1', [
    pageId,
  ]);
  return result.rows[0];
}

async function getInboxRow(pool: Pool, eventId: string): Promise<Record<string, any> | undefined> {
  const result = await pool.query('SELECT * FROM notion_sync.sync_inbox WHERE event_id = $1', [eventId]);
  return result.rows[0];
}

async function getRunRow(pool: Pool, runId: number): Promise<Record<string, any> | undefined> {
  const result = await pool.query('SELECT * FROM notion_sync.sync_runs WHERE run_id = $1', [runId]);
  return result.rows[0];
}

function event(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId,
    eventType: 'page.properties_updated',
    entityType: 'page',
    entityId: `page-${eventId}`,
    eventTimestamp: '2026-10-21T10:00:00.000Z',
    payload: { id: eventId, type: 'page.properties_updated' },
    ...overrides,
  };
}

describe.sequential('repositories (real PostgreSQL)', () => {
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

  describe('tasks-repo', () => {
    it('inserts once and updates the same row on repeat (I-02, INV-1)', async () => {
      const first = await TasksRepository.upsertTask(pool, task());
      const second = await TasksRepository.upsertTask(
        pool,
        task({ title: 'Write the final report', status: 'Done', priority: 'Low' }),
      );

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(await countTasks(pool)).toBe(1);

      const row = await getTaskRow(pool, task().notion_page_id);
      expect(row).toMatchObject({
        title: 'Write the final report',
        status: 'Done',
        priority: 'Low',
      });
    });

    it('preserves unknown JSON properties verbatim', async () => {
      await TasksRepository.upsertTask(pool, task());
      const row = await getTaskRow(pool, task().notion_page_id);

      expect(row?.raw_properties['Unknown Future']).toEqual({
        type: 'future_widget',
        future_widget: { hard: 'to map' },
      });
    });

    it('does not regress to an older notion_last_edited_time (I-03, INV-4)', async () => {
      await TasksRepository.upsertTask(pool, task({ title: 'Newest' }));
      const stale = await TasksRepository.upsertTask(
        pool,
        task({ title: 'Older', notion_last_edited_time: '2026-10-19T00:00:00.000Z' }),
      );

      expect(stale).toBeNull();
      expect((await getTaskRow(pool, task().notion_page_id))?.title).toBe('Newest');
    });

    it('applies an equal timestamp and refreshes synced_at (I-04, INV-4)', async () => {
      await TasksRepository.upsertTask(pool, task());
      const before = await getTaskRow(pool, task().notion_page_id);

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      const equal = await TasksRepository.upsertTask(pool, task({ title: 'Same version, new title' }));
      const after = await getTaskRow(pool, task().notion_page_id);

      expect(equal).not.toBeNull();
      expect(after?.title).toBe('Same version, new title');
      expect((after?.synced_at as Date).getTime()).toBeGreaterThan((before?.synced_at as Date).getTime());
    });

    it('tombstones a trashed page without deleting it, and a restore clears the flag', async () => {
      await TasksRepository.upsertTask(pool, task());

      expect(await TasksRepository.markTaskInTrash(pool, task().notion_page_id)).toBe(true);

      const afterTrash = await getTaskRow(pool, task().notion_page_id);
      expect(afterTrash?.notion_in_trash).toBe(true);
      expect(afterTrash?.user_archived).toBe(false);
      expect(await countTasks(pool)).toBe(1);

      await TasksRepository.upsertTask(pool, task({ notion_in_trash: false, title: 'Restored' }));
      const afterRestore = await getTaskRow(pool, task().notion_page_id);
      expect(afterRestore?.notion_in_trash).toBe(false);
      expect(afterRestore?.title).toBe('Restored');
    });

    it('keeps an out-of-scope page as a row with is_in_source=false (INV-5)', async () => {
      await TasksRepository.upsertTask(pool, task({ is_in_source: false, notion_is_archived: true }));

      const row = await getTaskRow(pool, task().notion_page_id);
      expect(row?.is_in_source).toBe(false);
      expect(row?.notion_is_archived).toBe(true);
      expect(await countTasks(pool)).toBe(1);
    });

    it('flags pages missing from a completed scan without touching kept pages (I-14)', async () => {
      await TasksRepository.upsertTask(pool, task({ notion_page_id: 'page-keep' }));
      await TasksRepository.upsertTask(pool, task({ notion_page_id: 'page-gone' }));

      expect(await TasksRepository.markTasksOutOfSource(pool, ['page-keep'])).toBe(1);

      expect((await getTaskRow(pool, 'page-keep'))?.is_in_source).toBe(true);
      expect((await getTaskRow(pool, 'page-gone'))?.is_in_source).toBe(false);
      expect(await countTasks(pool)).toBe(2);
    });

    it('refuses to mass-tombstone when a scan produced no active ids (INV-5)', async () => {
      await TasksRepository.upsertTask(pool, task({ notion_page_id: 'page-keep' }));

      expect(await TasksRepository.markTasksOutOfSource(pool, [])).toBe(0);
      expect((await getTaskRow(pool, 'page-keep'))?.is_in_source).toBe(true);
    });

    it('never issues a DELETE against notion_tasks (I-16)', async () => {
      const directories = ['db', 'sync'].map((dir) => resolve(process.cwd(), dir));
      const sources: string[] = [];

      for (const directory of directories) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.ts')) {
            sources.push(await readFile(join(directory, entry.name), 'utf8'));
          }
        }
      }

      for (const source of sources) {
        expect(source).not.toMatch(/DELETE\s+FROM\s+notion_sync\.notion_tasks/i);
      }
    });
  });

  describe('inbox-repo', () => {
    it('stores events idempotently by event_id (I-05, INV-1)', async () => {
      const first = await InboxRepository.enqueueEvent(pool, event('evt-1'));
      const duplicate = await InboxRepository.enqueueEvent(pool, event('evt-1'));

      expect(first.isDuplicate).toBe(false);
      expect(duplicate.isDuplicate).toBe(true);

      const pending = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM notion_sync.sync_inbox WHERE status = 'pending'`,
      );
      expect(Number(pending.rows[0]?.count)).toBe(1);
    });

    it('claims due events atomically with SKIP LOCKED (I-07, INV-1)', async () => {
      await InboxRepository.enqueueEvent(pool, event('evt-1'));
      await InboxRepository.enqueueEvent(pool, event('evt-2'));

      const [first, second, third] = await Promise.all([
        InboxRepository.claimNextEvent(pool),
        InboxRepository.claimNextEvent(pool),
        InboxRepository.claimNextEvent(pool),
      ]);

      expect(first?.event_id).toBeDefined();
      expect(second?.event_id).toBeDefined();
      expect(first?.event_id).not.toBe(second?.event_id);
      expect(third).toBeNull();

      const processing = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM notion_sync.sync_inbox WHERE status = 'processing'`,
      );
      expect(Number(processing.rows[0]?.count)).toBe(2);
      expect((await getInboxRow(pool, first?.event_id ?? ''))?.attempts).toBe(1);
    });

    it('increments attempts on claim and clears locked_at when processed (I-09)', async () => {
      await InboxRepository.enqueueEvent(pool, event('evt-1'));
      const claimed = await InboxRepository.claimNextEvent(pool);
      expect(claimed).toMatchObject({ status: 'processing', attempts: 1 });
      expect(claimed?.locked_at).toBeInstanceOf(Date);

      const client = await pool.connect();
      try {
        await InboxRepository.settleEventSuccess(client, 'evt-1');
      } finally {
        client.release();
      }

      const row = await getInboxRow(pool, 'evt-1');
      expect(row).toMatchObject({ status: 'processed', attempts: 1, locked_at: null });
      expect(row?.processed_at).toBeInstanceOf(Date);
    });

    it('schedules a retry with a future available_at and a sanitized error', async () => {
      await InboxRepository.enqueueEvent(pool, event('evt-1'));
      await InboxRepository.claimNextEvent(pool);
      const availableAt = new Date(Date.now() + 60_000);

      await InboxRepository.settleEventRetryable(pool, 'evt-1', availableAt, 'try again');

      const row = await getInboxRow(pool, 'evt-1');
      expect(row?.status).toBe('pending');
      expect(row?.locked_at).toBeNull();
      expect(row?.last_error).toBe('try again');
      expect((row?.available_at as Date).getTime()).toBe(availableAt.getTime());
    });

    it('marks a permanent failure as failed', async () => {
      await InboxRepository.enqueueEvent(pool, event('evt-1'));
      await InboxRepository.claimNextEvent(pool);

      await InboxRepository.settleEventFailed(pool, 'evt-1', '403 from Notion');

      expect(await getInboxRow(pool, 'evt-1')).toMatchObject({
        status: 'failed',
        last_error: '403 from Notion',
      });

      const failed = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM notion_sync.sync_inbox WHERE status = 'failed'`,
      );
      expect(Number(failed.rows[0]?.count)).toBe(1);
    });

    it('recovers a lease that outlived the configured lease time (I-08)', async () => {
      await InboxRepository.enqueueEvent(pool, event('evt-1'));
      await InboxRepository.claimNextEvent(pool);
      await pool.query(
        `UPDATE notion_sync.sync_inbox SET locked_at = NOW() - INTERVAL '10 minutes'
          WHERE event_id = 'evt-1'`,
      );

      expect(await InboxRepository.recoverStuckEvents(pool, 300)).toBe(1);

      const row = await getInboxRow(pool, 'evt-1');
      expect(row?.status).toBe('pending');
      expect(row?.locked_at).toBeNull();
      expect(row?.attempts).toBe(1);
    });

    it('requeues failed events for an operator and preserves last_error until the next attempt', async () => {
      await InboxRepository.enqueueEvent(pool, event('evt-1'));
      await InboxRepository.claimNextEvent(pool);
      await InboxRepository.settleEventFailed(pool, 'evt-1', 'old error');

      expect(await InboxRepository.retryFailedEvents(pool)).toBe(1);

      const row = await getInboxRow(pool, 'evt-1');
      expect(row).toMatchObject({ status: 'pending', attempts: 0, last_error: 'old error' });
    });

    it('does not claim events whose available_at is in the future', async () => {
      await InboxRepository.enqueueEvent(pool, event('evt-1'));
      await InboxRepository.claimNextEvent(pool);
      await InboxRepository.settleEventRetryable(
        pool,
        'evt-1',
        new Date(Date.now() + 3_600_000),
        'later',
      );

      expect(await InboxRepository.claimNextEvent(pool)).toBeNull();
    });
  });

  describe('transaction boundary', () => {
    it('rolls back both the task write and the inbox settle together (I-06, INV-6)', async () => {
      await InboxRepository.enqueueEvent(pool, event('evt-1', { entityId: task().notion_page_id }));
      await InboxRepository.claimNextEvent(pool);

      await expect(
        withTransaction(pool, async (client) => {
          await TasksRepository.upsertTask(client, task());
          await InboxRepository.settleEventSuccess(client, 'evt-1');
          throw new Error('simulated crash before commit');
        }),
      ).rejects.toThrow(/simulated crash before commit/);

      expect(await countTasks(pool)).toBe(0);
      expect(await getInboxRow(pool, 'evt-1')).toMatchObject({ status: 'processing' });
    });

    it('commits the task and the inbox state together on success', async () => {
      await InboxRepository.enqueueEvent(pool, event('evt-1', { entityId: task().notion_page_id }));
      await InboxRepository.claimNextEvent(pool);

      await withTransaction(pool, async (client) => {
        await TasksRepository.upsertTask(client, task());
        await InboxRepository.settleEventSuccess(client, 'evt-1');
      });

      expect(await countTasks(pool)).toBe(1);
      expect((await getInboxRow(pool, 'evt-1'))?.status).toBe('processed');
    });
  });

  describe('runs-repo', () => {
    it('records a run from running to succeeded with a cursor', async () => {
      const runId = await RunsRepository.startRun(pool, 'initial_backfill');
      expect(Number.isInteger(runId)).toBe(true);

      const running = await getRunRow(pool, runId);
      expect(running).toMatchObject({ run_type: 'initial_backfill', status: 'running' });

      await RunsRepository.finishRun(pool, runId, 'succeeded', 12, null, 'cursor-final');

      const finished = await getRunRow(pool, runId);
      expect(finished).toMatchObject({
        run_type: 'initial_backfill',
        status: 'succeeded',
        records_processed: 12,
        cursor_reached: 'cursor-final',
      });
      expect(finished?.finished_at).toBeInstanceOf(Date);
    });

    it('records partial and failed runs truthfully', async () => {
      const partialId = await RunsRepository.startRun(pool, 'reconciliation');
      await RunsRepository.finishRun(pool, partialId, 'partial', 4, 'query_result_limit_reached');

      const failedId = await RunsRepository.startRun(pool, 'manual_retry');
      await RunsRepository.finishRun(pool, failedId, 'failed', 0, '403 from Notion');

      expect((await getRunRow(pool, partialId))?.status).toBe('partial');
      expect((await getRunRow(pool, failedId))?.status).toBe('failed');
      expect((await getRunRow(pool, failedId))?.error_message).toBe('403 from Notion');
    });

    it('returns the most recent run for a given type', async () => {
      const first = await RunsRepository.startRun(pool, 'reconciliation');
      await RunsRepository.finishRun(pool, first, 'succeeded', 1);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      const second = await RunsRepository.startRun(pool, 'reconciliation');
      await RunsRepository.finishRun(pool, second, 'succeeded', 2);

      const latest = await RunsRepository.getLatestRun(pool, 'reconciliation');
      expect(Number(latest?.run_id)).toBe(second);
    });
  });
});
