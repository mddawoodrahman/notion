import pg from "pg";
import { NotionSyncClient } from "./notion-client.js";
import { normalizePage, NormalizedTaskRecord } from "./normalize.js";
import { TasksRepository } from "../db/tasks-repo.js";
import { AppConfig, getConfig } from "../src/config.js";
import { logger } from "../src/logger.js";

export interface SyncTaskPageOptions {
  client: NotionSyncClient;
  db: pg.Pool | pg.PoolClient;
  config?: AppConfig;
  dryRun?: boolean;
  dataSourceId?: string;
  fetchBlocks?: boolean;
}

/**
 * Shared synchronization core: Fetches latest page state from Notion,
 * optionally retrieves body blocks, normalizes the record, and upserts into PostgreSQL.
 */
export async function syncTaskPage(
  pageId: string,
  options: SyncTaskPageOptions
): Promise<NormalizedTaskRecord> {
  const config = options.config ?? getConfig();
  const fetchBlocks = options.fetchBlocks ?? config.SYNC_SYNC_BODY_CONTENT;

  // 1. Fetch fresh page state from Notion (INV-2)
  const page = await options.client.fetchPage(pageId);

  // 2. Fetch page body blocks if enabled (FR-005)
  let bodyBlocks: any[] = [];
  if (fetchBlocks && !page.in_trash) {
    try {
      bodyBlocks = await options.client.fetchPageBlocks(pageId);
    } catch (err) {
      logger.warn({ pageId, err }, "Failed to fetch body blocks for task; continuing with empty content");
    }
  }

  // 3. Normalize into typed record
  const record = normalizePage(page, {
    configuredDataSourceId: options.dataSourceId ?? config.NOTION_DATA_SOURCE_ID,
    configuredDatabaseId: config.NOTION_DATABASE_ID,
    timezone: config.SYNC_TIMEZONE,
    bodyBlocks,
  });

  // 4. Upsert into database unless dryRun
  if (!options.dryRun) {
    await TasksRepository.upsertTask(options.db, record);
  }

  return record;
}
