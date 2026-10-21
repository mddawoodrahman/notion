import { resolve } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyMigrations } from '../../db/migrate.js';
import { createPool } from '../../db/pool.js';
import { countTasks, getTask, listTaskPageIds } from '../../db/tasks-repo.js';
import { getRun } from '../../db/runs-repo.js';
import { createLogger } from '../../src/logger.js';
import { runBackfill } from '../../sync/backfill.js';
import type { NotionGateway, NotionPageLike } from '../../sync/notion-client.js';
import type { NotionPropertyValue } from '../../sync/normalize.js';
import { resolvePropertyMap } from '../../sync/property-map.js';
import { startTestDatabase, type TestDatabase } from './helpers/test-database.js';

const migrationsDir = resolve(process.cwd(), 'migrations');
const DATA_SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const DATABASE_ID = '22222222-2222-4222-8222-222222222222';
const logger = createLogger({ env: 'test', logLevel: 'silent' });

function title(text: string): NotionPropertyValue {
  return { type: 'title', title: [{ plain_text: text }] };
}

function page(id: string, text: string, overrides: Partial<NotionPageLike> = {}): NotionPageLike {
  return {
    object: 'page',
    id,
    url: `https://www.notion.so/${id}`,
    created_time: '2026-10-01T00:00:00.000Z',
    last_edited_time: '2026-10-20T00:00:00.000Z',
    in_trash: false,
    archived: false,
    is_archived: false,
    parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
    properties: { Name: title(text) },
    ...overrides,
  };
}

const DEFAULT_SCHEMA: Record<string, string> = {
  Name: 'title',
  Status: 'status',
  List: 'select',
  Important: 'checkbox',
  'In My Day': 'checkbox',
  Priority: 'select',
  'Due Date': 'date',
  Reminder: 'date',
  Archived: 'checkbox',
};

interface FakeGatewayOptions {
  readonly pages: readonly NotionPageLike[];
  readonly complete?: boolean;
  readonly incompleteReason?: string;
  readonly failAfter?: number;
  readonly schema?: Record<string, string>;
  readonly onScanPage?: (page: NotionPageLike) => Promise<void> | void;
  readonly blocks?: unknown[];
  readonly blockDelayMs?: number;
}

function fakeGateway(options: FakeGatewayOptions): NotionGateway {
  return {
    apiVersion: '2026-03-11',
    maxContentDepth: 10,
    checkAccess: vi.fn(async () => undefined),
    resolveDataSource: vi.fn(async () => ({ id: DATA_SOURCE_ID, name: 'Tasks' })),
    getSchema: vi.fn(async () => options.schema ?? DEFAULT_SCHEMA),
    retrievePage: vi.fn(async (pageId: string) => {
      const found = options.pages.find((candidate) => candidate.id === pageId);
      if (found === undefined) throw new Error('not found');
      return found;
    }),
    retrievePageBlocks: vi.fn(async () => {
      if (options.blockDelayMs !== undefined) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, options.blockDelayMs));
      }
      return (options.blocks ?? []) as never;
    }),
    scanPages: async (_dataSourceId, scanOptions, visit) => {
      let seen = 0;
      for (const candidate of options.pages) {
        if (options.failAfter !== undefined && seen >= options.failAfter) {
          throw new Error('simulated Notion outage for secret_abcdef1234567890');
        }
        await options.onScanPage?.(candidate);
        await visit(candidate);
        seen += 1;
        scanOptions.onProgress?.({ cursorReached: `cursor-${seen}`, pagesSeen: seen });
      }
      return {
        pagesSeen: seen,
        complete: options.complete ?? true,
        ...(options.incompleteReason === undefined
          ? {}
          : { incompleteReason: options.incompleteReason }),
        cursorReached: `cursor-${seen}`,
      };
    },
  };
}

function deps(pool: Pool, gateway: NotionGateway, overrides: Record<string, unknown> = {}) {
  return {
    gateway,
    pool,
    logger,
    propertyMap: resolvePropertyMap({}),
    databaseId: DATABASE_ID,
    timezone: 'UTC',
    syncBodyContent: false,
    batchSize: 5,
    ...overrides,
  };
}

describe.sequential('initial backfill (real PostgreSQL, mocked Notion)', () => {
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

  it('imports every page and records a succeeded run', async () => {
    const gateway = fakeGateway({
      pages: [page('p1', 'One'), page('p2', 'Two'), page('p3', 'Three')],
    });

    const result = await runBackfill(deps(pool, gateway));

    expect(result).toMatchObject({ status: 'succeeded', pagesSeen: 3, written: 3, skippedStale: 0 });
    expect(await listTaskPageIds(pool)).toEqual(['p1', 'p2', 'p3']);

    const run = await getRun(pool, result.runId ?? 0);
    expect(run).toMatchObject({
      runType: 'initial_backfill',
      status: 'succeeded',
      recordsProcessed: 3,
      cursorReached: 'cursor-3',
    });
  });

  it('is re-runnable without creating duplicates (AT-02)', async () => {
    const gateway = fakeGateway({ pages: [page('p1', 'One'), page('p2', 'Two')] });

    await runBackfill(deps(pool, gateway));
    const before = await getTask(pool, 'p1');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const second = await runBackfill(deps(pool, gateway));
    const after = await getTask(pool, 'p1');

    expect(await countTasks(pool)).toBe(2);
    expect(second).toMatchObject({ status: 'succeeded', written: 2 });
    expect(after?.syncedAt.getTime() ?? 0).toBeGreaterThan(before?.syncedAt.getTime() ?? 0);
  });

  it('keeps pages that moved out of the source as out-of-scope rows', async () => {
    const gateway = fakeGateway({
      pages: [
        page('p1', 'In source'),
        page('p2', 'Moved', {
          parent: { type: 'data_source_id', data_source_id: '99999999-9999-4999-8999-999999999999' },
        }),
      ],
    });

    await runBackfill(deps(pool, gateway));

    expect((await getTask(pool, 'p1'))?.isInSource).toBe(true);
    expect((await getTask(pool, 'p2'))?.isInSource).toBe(false);
    expect(await countTasks(pool)).toBe(2);
  });

  it('reports a 10k-limit scan as partial, never succeeded', async () => {
    const gateway = fakeGateway({
      pages: [page('p1', 'One')],
      complete: false,
      incompleteReason: 'query_result_limit_reached',
    });

    const result = await runBackfill(deps(pool, gateway));
    const run = await getRun(pool, result.runId ?? 0);

    expect(result).toMatchObject({
      status: 'partial',
      incompleteReason: 'query_result_limit_reached',
    });
    expect(run?.status).toBe('partial');
    expect(run?.errorMessage).toBe('query_result_limit_reached');
  });

  it('syncs page content only when enabled', async () => {
    const blocks = [{ id: 'block-1', type: 'paragraph', has_children: false }];
    const gateway = fakeGateway({ pages: [page('p1', 'One')], blocks });

    await runBackfill(deps(pool, gateway, { syncBodyContent: false }));
    expect((await getTask(pool, 'p1'))?.pageContentJson).toEqual([]);
    expect(gateway.retrievePageBlocks).not.toHaveBeenCalled();

    await runBackfill(deps(pool, gateway, { syncBodyContent: true }));
    expect((await getTask(pool, 'p1'))?.pageContentJson).toEqual(blocks);
    expect(gateway.retrievePageBlocks).toHaveBeenCalledWith('p1');
  });

  it('records a failed run with the cursor reached and a sanitized error', async () => {
    const gateway = fakeGateway({ pages: [page('p1', 'One'), page('p2', 'Two')], failAfter: 1 });

    await expect(runBackfill(deps(pool, gateway))).rejects.toThrow();

    const run = await getRun(pool, 1);
    expect(run).toMatchObject({
      status: 'failed',
      cursorReached: 'cursor-1',
      recordsProcessed: 1,
    });
    expect(run?.errorMessage).not.toContain('secret_abcdef1234567890');
    expect(await countTasks(pool)).toBe(1);
  });

  it('fails before writing anything when the live schema does not match the map', async () => {
    const schemaWithoutStatus = Object.fromEntries(
      Object.entries(DEFAULT_SCHEMA).filter(([name]) => name !== 'Status'),
    );
    const gateway = fakeGateway({ pages: [page('p1', 'One')], schema: schemaWithoutStatus });

    await expect(runBackfill(deps(pool, gateway))).rejects.toMatchObject({
      code: 'property_map_invalid',
    });
    expect(await countTasks(pool)).toBe(0);
    expect(await getRun(pool, 1)).toBeNull();
  });

  it('supports a dry run that reads nothing and writes nothing', async () => {
    const gateway = fakeGateway({ pages: [page('p1', 'One'), page('p2', 'Two')] });

    const result = await runBackfill(deps(pool, gateway, { dryRun: true }));

    expect(result).toMatchObject({ status: 'dry_run', pagesSeen: 2, written: 0, runId: null });
    expect(await countTasks(pool)).toBe(0);
    expect(gateway.retrievePageBlocks).not.toHaveBeenCalled();
  });

  it('bounds in-flight page processing to the configured batch size', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gateway = fakeGateway({
      pages: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, index) => page(id, `Task ${index}`)),
      blockDelayMs: 25,
    });

    const result = await runBackfill(
      deps(pool, gateway, {
        syncBodyContent: true,
        batchSize: 2,
        gateway: {
          ...gateway,
          retrievePageBlocks: vi.fn(async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
            inFlight -= 1;
            return [];
          }),
        },
      }),
    );

    expect(result.written).toBe(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });
});
