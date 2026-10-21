import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations } from '../../db/migrate.js';
import { createPool } from '../../db/pool.js';
import {
  claimNextEvent,
  countInboxByStatus,
  enqueueEvent,
  getInboxEvent,
  recoverStuckEvents,
  requeueFailedEvents,
  settleEvent,
} from '../../db/inbox-repo.js';
import { finishRun, getRun, startRun } from '../../db/runs-repo.js';
import {
  countTasks,
  getTask,
  markPageTrashed,
  markPagesOutOfScope,
  upsertTask,
} from '../../db/tasks-repo.js';
import { withTransaction } from '../../db/transaction.js';
import type { NormalizedTask } from '../../sync/normalize.js';
import { startTestDatabase, type TestDatabase } from './helpers/test-database.js';

const migrationsDir = resolve(process.cwd(), 'migrations');

function task(overrides: Partial<NormalizedTask> = {}): NormalizedTask {
  return {
    notionPageId: '11111111-1111-4111-8111-111111111111',
    title: 'Write the report',
    status: 'Todo',
    listName: 'Work',
    important: false,
    inMyDay: false,
    priority: 'High',
    dueDate: '2026-10-21',
    dueAt: null,
    reminderAt: null,
    userArchived: false,
    notionIsArchived: false,
    notionInTrash: false,
    isInSource: true,
    pageUrl: 'https://www.notion.so/11111111111141118111111111111111',
    notionCreatedTime: new Date('2026-10-01T08:00:00.000Z'),
    notionLastEditedTime: new Date('2026-10-20T12:00:00.000Z'),
    rawProperties: {
      Name: { type: 'title', title: [{ plain_text: 'Write the report' }] },
      'Unknown Future': { type: 'future_widget', future_widget: { hard: 'to map' } },
    },
    ...overrides,
  };
}

describe.sequential('repositories (real PostgreSQL)', () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.url, { migrationsDir });
    pool = createPool(database.url, { max: 8 });
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
      const first = await upsertTask(pool, task());
      const second = await upsertTask(
        pool,
        task({ title: 'Write the final report', status: 'Done', priority: 'Low' }),
      );

      expect(first).toMatchObject({ applied: true, inserted: true });
      expect(second).toMatchObject({ applied: true, inserted: false });
      expect(await countTasks(pool)).toBe(1);

      const row = await getTask(pool, task().notionPageId);
      expect(row).toMatchObject({
        title: 'Write the final report',
        status: 'Done',
        priority: 'Low',
      });
    });

    it('preserves unknown JSON properties verbatim', async () => {
      await upsertTask(pool, task());
      const row = await getTask(pool, task().notionPageId);

      expect(row?.rawProperties['Unknown Future']).toEqual({
        type: 'future_widget',
        future_widget: { hard: 'to map' },
      });
    });

    it('does not regress to an older notion_last_edited_time (I-03, INV-4)', async () => {
      await upsertTask(pool, task({ title: 'Newest' }));
      const stale = await upsertTask(
        pool,
        task({
          title: 'Older',
          notionLastEditedTime: new Date('2026-10-19T00:00:00.000Z'),
        }),
      );

      expect(stale).toMatchObject({ applied: false, inserted: false });
      expect((await getTask(pool, task().notionPageId))?.title).toBe('Newest');
    });

    it('applies an equal timestamp and refreshes synced_at (I-04, INV-4)', async () => {
      await upsertTask(pool, task());
      const before = await getTask(pool, task().notionPageId);

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      const equal = await upsertTask(pool, task({ title: 'Same version, new title' }));
      const after = await getTask(pool, task().notionPageId);

      expect(equal.applied).toBe(true);
      expect(after?.title).toBe('Same version, new title');
      expect(after?.syncedAt.getTime() ?? 0).toBeGreaterThan(before?.syncedAt.getTime() ?? 0);
    });

    it('keeps page content when a properties-only write omits it, and updates it when present', async () => {
      await upsertTask(pool, task(), { pageContentJson: [{ id: 'block-1', type: 'paragraph' }] });
      await upsertTask(pool, task({ title: 'Properties only' }));

      const preserved = await getTask(pool, task().notionPageId);
      expect(preserved?.pageContentJson).toEqual([{ id: 'block-1', type: 'paragraph' }]);

      await upsertTask(pool, task({ title: 'Content too' }), {
        pageContentJson: [{ id: 'block-2', type: 'paragraph' }],
      });
      const updated = await getTask(pool, task().notionPageId);
      expect(updated?.pageContentJson).toEqual([{ id: 'block-2', type: 'paragraph' }]);
    });

    it('tombstones a trashed page without deleting it, and a restore clears the flag', async () => {
      await upsertTask(pool, task());

      const trashed = await markPageTrashed(pool, task().notionPageId);
      expect(trashed).toBe(true);

      const afterTrash = await getTask(pool, task().notionPageId);
      expect(afterTrash?.notionInTrash).toBe(true);
      expect(afterTrash?.userArchived).toBe(false);
      expect(await countTasks(pool)).toBe(1);

      await upsertTask(pool, task({ notionInTrash: false, title: 'Restored' }));
      const afterRestore = await getTask(pool, task().notionPageId);
      expect(afterRestore?.notionInTrash).toBe(false);
      expect(afterRestore?.title).toBe('Restored');
    });

    it('keeps an out-of-scope page as a row with is_in_source=false (INV-5)', async () => {
      await upsertTask(pool, task({ isInSource: false, notionIsArchived: true }));

      const row = await getTask(pool, task().notionPageId);
      expect(row?.isInSource).toBe(false);
      expect(row?.notionIsArchived).toBe(true);
      expect(await countTasks(pool)).toBe(1);
    });

    it('flags pages missing from a completed scan without touching kept pages (I-14)', async () => {
      await upsertTask(pool, task({ notionPageId: 'page-keep' }));
      await upsertTask(pool, task({ notionPageId: 'page-gone' }));

      const updated = await markPagesOutOfScope(pool, ['page-keep']);

      expect(updated).toBe(1);
      expect((await getTask(pool, 'page-keep'))?.isInSource).toBe(true);
      expect((await getTask(pool, 'page-gone'))?.isInSource).toBe(false);
      expect(await countTasks(pool)).toBe(2);
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
    const event = (eventId: string, overrides: Record<string, unknown> = {}) => ({
      eventId,
      eventType: 'page.properties_updated',
      entityType: 'page',
      entityId: `page-${eventId}`,
      eventTimestamp: new Date('2026-10-21T10:00:00.000Z'),
      payload: { id: eventId, type: 'page.properties_updated' },
      ...overrides,
    });

    it('stores events idempotently by event_id (I-05, INV-1)', async () => {
      const first = await enqueueEvent(pool, event('evt-1'));
      const duplicate = await enqueueEvent(pool, event('evt-1'));

      expect(first).toBe(true);
      expect(duplicate).toBe(false);
      expect((await countInboxByStatus(pool)).pending).toBe(1);
    });

    it('claims due events atomically with SKIP LOCKED (I-07, INV-1)', async () => {
      await enqueueEvent(pool, event('evt-1'));
      await enqueueEvent(pool, event('evt-2'));

      const [first, second, third] = await Promise.all([
        claimNextEvent(pool),
        claimNextEvent(pool),
        claimNextEvent(pool),
      ]);

      expect(first?.eventId).toBeDefined();
      expect(second?.eventId).toBeDefined();
      expect(first?.eventId).not.toBe(second?.eventId);
      expect(third).toBeNull();

      expect((await countInboxByStatus(pool)).processing).toBe(2);
      expect((await getInboxEvent(pool, first?.eventId ?? ''))?.attempts).toBe(1);
    });

    it('increments attempts on claim and clears locked_at when processed (I-09)', async () => {
      await enqueueEvent(pool, event('evt-1'));
      const claimed = await claimNextEvent(pool);
      expect(claimed).toMatchObject({ status: 'processing', attempts: 1, lockedAt: expect.any(Date) });

      const settled = await settleEvent(pool, { eventId: 'evt-1', outcome: 'processed' });
      expect(settled).toBe(true);

      const row = await getInboxEvent(pool, 'evt-1');
      expect(row).toMatchObject({ status: 'processed', attempts: 1, lockedAt: null });
      expect(row?.processedAt).toBeInstanceOf(Date);
    });

    it('schedules a retry with a future available_at and a sanitized error', async () => {
      await enqueueEvent(pool, event('evt-1'));
      await claimNextEvent(pool);
      const availableAt = new Date(Date.now() + 60_000);

      await settleEvent(pool, {
        eventId: 'evt-1',
        outcome: 'retry',
        availableAt,
        lastError: 'try again',
      });

      const row = await getInboxEvent(pool, 'evt-1');
      expect(row?.status).toBe('pending');
      expect(row?.lockedAt).toBeNull();
      expect(row?.lastError).toBe('try again');
      expect(row?.availableAt.getTime()).toBe(availableAt.getTime());
    });

    it('marks a permanent failure as failed', async () => {
      await enqueueEvent(pool, event('evt-1'));
      await claimNextEvent(pool);

      await settleEvent(pool, {
        eventId: 'evt-1',
        outcome: 'failed',
        lastError: '403 from Notion',
      });

      expect(await getInboxEvent(pool, 'evt-1')).toMatchObject({
        status: 'failed',
        lastError: '403 from Notion',
      });
      expect((await countInboxByStatus(pool)).failed).toBe(1);
    });

    it('does not settle an event that is not currently processing', async () => {
      await enqueueEvent(pool, event('evt-1'));

      const settled = await settleEvent(pool, { eventId: 'evt-1', outcome: 'processed' });
      expect(settled).toBe(false);
      expect((await getInboxEvent(pool, 'evt-1'))?.status).toBe('pending');
    });

    it('recovers a lease that outlived SYNC_LEASE_SECONDS (I-08)', async () => {
      await enqueueEvent(pool, event('evt-1'));
      await claimNextEvent(pool);
      await pool.query(
        `UPDATE notion_sync.sync_inbox SET locked_at = NOW() - INTERVAL '10 minutes'
          WHERE event_id = 'evt-1'`,
      );

      const recovered = await recoverStuckEvents(pool, 300);
      expect(recovered).toBe(1);

      const row = await getInboxEvent(pool, 'evt-1');
      expect(row?.status).toBe('pending');
      expect(row?.lockedAt).toBeNull();
      expect(row?.attempts).toBe(1);
    });

    it('requeues failed events for an operator and preserves last_error until the next attempt', async () => {
      await enqueueEvent(pool, event('evt-1'));
      await claimNextEvent(pool);
      await settleEvent(pool, { eventId: 'evt-1', outcome: 'failed', lastError: 'old error' });

      const requeued = await requeueFailedEvents(pool);
      expect(requeued).toBe(1);

      const row = await getInboxEvent(pool, 'evt-1');
      expect(row).toMatchObject({ status: 'pending', attempts: 0, lastError: 'old error' });
    });

    it('does not claim events whose available_at is in the future', async () => {
      await enqueueEvent(pool, event('evt-1'));
      await claimNextEvent(pool);
      await settleEvent(pool, {
        eventId: 'evt-1',
        outcome: 'retry',
        availableAt: new Date(Date.now() + 3600_000),
      });

      expect(await claimNextEvent(pool)).toBeNull();
    });
  });

  describe('transaction boundary', () => {
    it('rolls back both the task write and the inbox settle together (I-06, INV-6)', async () => {
      await enqueueEvent(pool, {
        eventId: 'evt-1',
        eventType: 'page.properties_updated',
        entityType: 'page',
        entityId: task().notionPageId,
        payload: {},
      });
      await claimNextEvent(pool);

      await expect(
        withTransaction(pool, async (client) => {
          await upsertTask(client, task());
          await settleEvent(client, { eventId: 'evt-1', outcome: 'processed' });
          throw new Error('simulated crash before commit');
        }),
      ).rejects.toThrow('simulated crash before commit');

      expect(await countTasks(pool)).toBe(0);
      expect(await getInboxEvent(pool, 'evt-1')).toMatchObject({ status: 'processing' });
    });

    it('commits the task and the inbox state together on success', async () => {
      await enqueueEvent(pool, {
        eventId: 'evt-1',
        eventType: 'page.properties_updated',
        entityType: 'page',
        entityId: task().notionPageId,
        payload: {},
      });
      await claimNextEvent(pool);

      await withTransaction(pool, async (client) => {
        await upsertTask(client, task());
        await settleEvent(client, { eventId: 'evt-1', outcome: 'processed' });
      });

      expect(await countTasks(pool)).toBe(1);
      expect((await getInboxEvent(pool, 'evt-1'))?.status).toBe('processed');
    });
  });

  describe('runs-repo', () => {
    it('records a run from running to succeeded with a cursor', async () => {
      const run = await startRun(pool, 'initial_backfill');
      expect(run.status).toBe('running');

      await finishRun(pool, run.runId, {
        status: 'succeeded',
        recordsProcessed: 12,
        cursorReached: 'cursor-final',
      });

      const finished = await getRun(pool, run.runId);
      expect(finished).toMatchObject({
        runType: 'initial_backfill',
        status: 'succeeded',
        recordsProcessed: 12,
        cursorReached: 'cursor-final',
      });
      expect(finished?.finishedAt).toBeInstanceOf(Date);
    });

    it('records partial and failed runs truthfully', async () => {
      const partial = await startRun(pool, 'reconciliation');
      await finishRun(pool, partial.runId, {
        status: 'partial',
        recordsProcessed: 4,
        errorMessage: 'query_result_limit_reached',
      });
      const failed = await startRun(pool, 'manual_retry');
      await finishRun(pool, failed.runId, { status: 'failed', recordsProcessed: 0 });

      expect((await getRun(pool, partial.runId))?.status).toBe('partial');
      expect((await getRun(pool, failed.runId))?.status).toBe('failed');
    });
  });
});
