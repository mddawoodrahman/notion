import pg from "pg";
import { NotionSyncClient } from "./notion-client.js";
import { normalizePage } from "./normalize.js";
import { TasksRepository } from "../db/tasks-repo.js";
import { RunsRepository, RunStatus } from "../db/runs-repo.js";
import { AppConfig, getConfig } from "../src/config.js";
import { logger } from "../src/logger.js";
import { sanitizeErrorMessage } from "../src/errors.js";

export interface BackfillOptions {
  client: NotionSyncClient;
  pool: pg.Pool;
  config?: AppConfig;
  dryRun?: boolean;
}

export interface BackfillResult {
  runId: number | null;
  recordsProcessed: number;
  pageFailures: number;
  status: RunStatus;
  dataSourceId: string;
  /** True when Notion reported the query result set is incomplete (e.g. 10k cap). */
  isIncomplete: boolean;
  incompleteReason: string | null;
}

/**
 * Runs the initial paginated backfill importing all accessible tasks from the configured source.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const config = options.config ?? getConfig();
  const pool = options.pool;
  const client = options.client;

  // 1. Resolve master Tasks data source
  const dataSourceId = await client.resolveDataSource(
    config.NOTION_DATABASE_ID,
    config.NOTION_DATA_SOURCE_ID
  );

  logger.info({ dataSourceId, dryRun: options.dryRun }, "Starting initial backfill");

  // 2. Open sync_runs record
  let runId: number | null = null;
  if (!options.dryRun) {
    runId = await RunsRepository.startRun(pool, "initial_backfill");
  }

  let recordsProcessed = 0;
  let pageFailures = 0;
  let cursor: string | undefined = undefined;
  let hasMore = true;
  let finalStatus: RunStatus = "succeeded";
  let isIncomplete = false;
  let incompleteReason: string | null = null;
  let lastErrorMessage: string | null = null;
  const seenCursors = new Set<string>();

  try {
    // 3. Paginate until complete
    while (hasMore) {
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new Error(`Infinite pagination cycle detected: cursor ${cursor} already seen`);
        }
        seenCursors.add(cursor);
      }

      const response = await client.queryDataSourcePages(dataSourceId, {
        startCursor: cursor,
        pageSize: config.SYNC_PAGE_SIZE,
      });

      // BUG-002: surface the Notion 10,000-result query cap instead of trusting has_more=false
      if (response.is_incomplete) {
        isIncomplete = true;
        incompleteReason = response.incomplete_reason ?? "query_result_limit_reached";
        logger.warn(
          { dataSourceId, cursor, incompleteReason },
          "Notion reported an incomplete query result set during backfill"
        );
      }

      for (const page of response.results) {
        try {
          // Normalize task record
          const record = normalizePage(page, {
            configuredDataSourceId: dataSourceId,
            configuredDatabaseId: config.NOTION_DATABASE_ID,
            timezone: config.SYNC_TIMEZONE,
          });

          if (!options.dryRun) {
            await TasksRepository.upsertTask(pool, record);
          }
          recordsProcessed++;
        } catch (pageErr) {
          pageFailures++;
          lastErrorMessage = sanitizeErrorMessage(pageErr);
          logger.error({ pageId: page?.id, err: pageErr }, "Failed to process page during backfill");
        }
      }

      hasMore = response.has_more;
      cursor = response.next_cursor ?? undefined;
    }

    if (isIncomplete || pageFailures > 0) {
      finalStatus = recordsProcessed > 0 || isIncomplete ? "partial" : "failed";
      if (!lastErrorMessage) {
        lastErrorMessage = isIncomplete
          ? `Notion query returned an incomplete result set (${incompleteReason ?? "unknown reason"})`
          : `Backfill completed with ${pageFailures} page failure(s)`;
      }
      logger.warn(
        { recordsProcessed, pageFailures, isIncomplete, incompleteReason },
        "Backfill coverage is incomplete; run status recorded as partial"
      );
    }
  } catch (err) {
    finalStatus = "failed";
    lastErrorMessage = sanitizeErrorMessage(err);
    logger.error({ err }, "Backfill failed abruptly");
    throw err;
  } finally {
    if (runId !== null) {
      await RunsRepository.finishRun(
        pool,
        runId,
        finalStatus,
        recordsProcessed,
        lastErrorMessage,
        cursor
      );
    }
  }

  logger.info(
    { runId, recordsProcessed, pageFailures, status: finalStatus, isIncomplete },
    "Initial backfill completed"
  );

  return {
    runId,
    recordsProcessed,
    pageFailures,
    status: finalStatus,
    dataSourceId,
    isIncomplete,
    incompleteReason,
  };
}
