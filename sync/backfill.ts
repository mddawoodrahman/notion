/**
 * Initial backfill: read the whole configured data source, normalize every
 * page and upsert it. Re-runnable by design; a partial scan is reported as
 * `partial`, never as success.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';

import { finishRun, startRun } from '../db/runs-repo.js';
import { upsertTask } from '../db/tasks-repo.js';
import { withTransaction } from '../db/transaction.js';
import { SyncError } from '../src/errors.js';
import { sanitizeError } from '../src/redact.js';
import type { NormalizedTask } from '../src/task-model.js';
import { normalizePage, type NormalizeWarning, type NotionPageLike } from './normalize.js';
import type { NotionGateway } from './notion-client.js';
import {
  formatPropertyIssues,
  validatePropertyMap,
  type PropertyMap,
} from './property-map.js';

export interface BackfillDeps {
  readonly gateway: NotionGateway;
  readonly pool: Pool;
  readonly logger: Logger;
  readonly propertyMap: PropertyMap;
  readonly databaseId: string;
  readonly timezone: string;
  /** Pages processed concurrently. Bounded so a large source cannot exhaust memory. */
  readonly batchSize?: number;
  readonly pageSize?: number;
  readonly syncBodyContent?: boolean;
  readonly startCursor?: string;
  readonly dryRun?: boolean;
}

export type BackfillStatus = 'succeeded' | 'partial' | 'failed' | 'dry_run';

export interface BackfillResult {
  readonly status: BackfillStatus;
  readonly runId: number | null;
  readonly pagesSeen: number;
  readonly written: number;
  readonly skippedStale: number;
  readonly incompleteReason?: string;
  readonly cursorReached: string | null;
}

const DEFAULT_BATCH_SIZE = 5;

export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const { gateway, pool, logger, propertyMap } = deps;
  const batchSize = Math.max(1, Math.floor(deps.batchSize ?? DEFAULT_BATCH_SIZE));
  const dryRun = deps.dryRun === true;

  // 1. Credentials and source identity, before any write.
  await gateway.checkAccess();
  const dataSource = await gateway.resolveDataSource();
  const schema = await gateway.getSchema(dataSource.id);
  const validation = validatePropertyMap(propertyMap, {
    properties: Object.fromEntries(
      Object.entries(schema).map(([name, type]) => [name, { type }]),
    ),
  });
  if (!validation.ok) {
    throw new SyncError(
      `Notion property map does not match the live data source: ${formatPropertyIssues(validation.issues)}`,
      { errorClass: 'PERMANENT', code: 'property_map_invalid' },
    );
  }

  const runId = dryRun ? null : (await startRun(pool, 'initial_backfill')).runId;

  let cursorReached = deps.startCursor ?? null;
  let written = 0;
  let skippedStale = 0;
  const warned = new Set<string>();

  const context = {
    propertyMap,
    dataSourceId: dataSource.id,
    databaseId: deps.databaseId,
    timezone: deps.timezone,
    onWarning: (warning: NormalizeWarning): void => {
      const key = `${warning.pageId}:${warning.property}:${warning.code}`;
      if (warned.has(key)) {
        return;
      }
      warned.add(key);
      logger.warn(
        {
          event: 'normalize.warning',
          page_id: warning.pageId,
          property: warning.property,
          warning_code: warning.code,
          ...(warning.type === undefined ? {} : { property_type: warning.type }),
        },
        'property could not be normalized into its typed column',
      );
    },
  };

  const processPage = async (page: NotionPageLike): Promise<void> => {
    const task: NormalizedTask = normalizePage(page, context);

    if (dryRun) {
      return;
    }

    const content = deps.syncBodyContent === true
      ? await gateway.retrievePageBlocks(page.id)
      : undefined;

    const result = await withTransaction(pool, (client) =>
      upsertTask(
        client,
        task,
        content === undefined ? {} : { pageContentJson: content },
      ),
    );

    if (result.applied) {
      written += 1;
    } else {
      skippedStale += 1;
    }
  };

  let buffer: NotionPageLike[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) {
      return;
    }
    const batch = buffer;
    buffer = [];
    const settled = await Promise.allSettled(batch.map((page) => processPage(page)));
    const failure = settled.find((entry) => entry.status === 'rejected');
    if (failure !== undefined) {
      throw failure.reason;
    }
  };

  let summary;
  try {
    summary = await gateway.scanPages(
      dataSource.id,
      {
        ...(deps.pageSize === undefined ? {} : { pageSize: deps.pageSize }),
        ...(deps.startCursor === undefined ? {} : { startCursor: deps.startCursor }),
        onProgress: (progress) => {
          cursorReached = progress.cursorReached;
        },
      },
      async (page) => {
        buffer.push(page);
        if (buffer.length >= batchSize) {
          await flush();
        }
      },
    );
    await flush();
  } catch (error) {
    // Persist pages already fetched before reporting the failure.
    await flush().catch(() => undefined);

    if (runId !== null) {
      await finishRun(pool, runId, {
        status: 'failed',
        recordsProcessed: written,
        errorMessage: sanitizeError(error),
        cursorReached,
      }).catch(() => undefined);
    }
    throw error;
  }

  const status: BackfillStatus = dryRun
    ? 'dry_run'
    : summary.complete
      ? 'succeeded'
      : 'partial';

  if (runId !== null) {
    await finishRun(pool, runId, {
      status: status === 'partial' ? 'partial' : 'succeeded',
      recordsProcessed: written,
      ...(status === 'partial'
        ? { errorMessage: summary.incompleteReason ?? 'scan_incomplete' }
        : {}),
      cursorReached: summary.cursorReached,
    });
  }

  logger.info(
    {
      event: 'backfill.finished',
      run_id: runId,
      status,
      pages_seen: summary.pagesSeen,
      written,
      skipped_stale: skippedStale,
      ...(summary.incompleteReason === undefined
        ? {}
        : { incomplete_reason: summary.incompleteReason }),
    },
    'backfill finished',
  );

  return {
    status,
    runId,
    pagesSeen: summary.pagesSeen,
    written,
    skippedStale,
    ...(summary.incompleteReason === undefined
      ? {}
      : { incompleteReason: summary.incompleteReason }),
    cursorReached: summary.cursorReached,
  };
}

export interface BackfillCliArgs {
  readonly dryRun: boolean;
  readonly startCursor?: string;
  readonly pageSize?: number;
}

/** Strict flag parsing: an unknown flag is a usage error, not silently ignored. */
export function parseBackfillArgs(argv: readonly string[]): BackfillCliArgs {
  let dryRun = false;
  let startCursor: string | undefined;
  let pageSize: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }

    const [flag, inlineValue] = argument.split('=', 2);
    if (flag !== '--start-cursor' && flag !== '--page-size') {
      throw new Error(`unknown argument: ${argument}`);
    }

    const value = inlineValue ?? argv[++index];
    if (value === undefined || value === '') {
      throw new Error(`${flag as string} requires a value`);
    }

    if (flag === '--start-cursor') {
      startCursor = value;
    } else {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new Error('--page-size must be an integer between 1 and 100');
      }
      pageSize = parsed;
    }
  }

  return {
    dryRun,
    ...(startCursor === undefined ? {} : { startCursor }),
    ...(pageSize === undefined ? {} : { pageSize }),
  };
}
