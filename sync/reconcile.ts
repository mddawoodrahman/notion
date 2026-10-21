import pg from "pg";
import { NotionSyncClient } from "./notion-client.js";
import { normalizePage } from "./normalize.js";
import { TasksRepository } from "../db/tasks-repo.js";
import { RunsRepository, RunStatus } from "../db/runs-repo.js";
import { AppConfig, getConfig } from "../src/config.js";
import { logger } from "../src/logger.js";
import { sanitizeErrorMessage } from "../src/errors.js";

export interface ReconcileOptions {
  client: NotionSyncClient;
  pool: pg.Pool;
  config?: AppConfig;
  dryRun?: boolean;
}

export interface ReconcileResult {
  runId: number | null;
  recordsProcessed: number;
  pageFailures: number;
  status: RunStatus;
  remediatedOutdated: number;
  dataSourceId: string;
}

/**
 * Executes a full reconciliation scan across the authorized data source (SPEC §11.6).
 * Safely repairs missed updates and marks vanished records out-of-scope ONLY if
 * the scan was 100% complete with 0 page failures (INV-5).
 */
export async function runReconciliation(options: ReconcileOptions): Promise<ReconcileResult> {
  const config = options.config ?? getConfig();
  const pool = options.pool;
  const client = options.client;

  const dataSourceId = await client.resolveDataSource(
    config.NOTION_DATABASE_ID,
    config.NOTION_DATA_SOURCE_ID
  );

  logger.info({ dataSourceId, dryRun: options.dryRun }, "Starting reconciliation scan");

  let runId: number | null = null;
  if (!options.dryRun) {
    runId = await RunsRepository.startRun(pool, "reconciliation");
  }

  const seenPageIds = new Set<string>();
  let recordsProcessed = 0;
  let pageFailures = 0;
  let cursor: string | undefined = undefined;
  let hasMore = true;
  let scanComplete = false;
  let remediatedOutdated = 0;
  let finalStatus: RunStatus = "succeeded";
  let lastErrorMessage: string | null = null;
  const seenCursors = new Set<string>();

  try {
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

      for (const page of response.results) {
        if (!page?.id) continue;
        seenPageIds.add(page.id);

        try {
          // Fetch full page to repair any missed field changes
          const fullPage = await client.fetchPage(page.id);
          const record = normalizePage(fullPage, {
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
          logger.error({ pageId: page.id, err: pageErr }, "Failed to reconcile page");
        }
      }

      hasMore = response.has_more;
      cursor = response.next_cursor ?? undefined;
    }

    scanComplete = true;

    // INV-5: Only compare out-of-scope pages if scan was completely successful with 0 page failures
    if (!scanComplete || pageFailures > 0) {
      finalStatus = recordsProcessed > 0 ? "partial" : "failed";
      logger.warn(
        { recordsProcessed, pageFailures },
        "Reconciliation was partial. Skipping out-of-source remediation to protect existing tasks (INV-5)"
      );
    } else {
      finalStatus = "succeeded";
      if (!options.dryRun && seenPageIds.size > 0) {
        remediatedOutdated = await TasksRepository.markTasksOutOfSource(
          pool,
          Array.from(seenPageIds)
        );
        if (remediatedOutdated > 0) {
          logger.info({ remediatedOutdated }, "Flagged vanished pages as is_in_source=false");
        }
      }
    }
  } catch (err) {
    finalStatus = "failed";
    lastErrorMessage = sanitizeErrorMessage(err);
    logger.error({ err }, "Reconciliation scan aborted");
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
    { runId, recordsProcessed, pageFailures, remediatedOutdated, status: finalStatus },
    "Reconciliation completed"
  );

  return {
    runId,
    recordsProcessed,
    pageFailures,
    status: finalStatus,
    remediatedOutdated,
    dataSourceId,
  };
}
