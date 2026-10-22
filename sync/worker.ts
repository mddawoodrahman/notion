import pg from "pg";
import { NotionSyncClient } from "./notion-client.js";
import { normalizePage } from "./normalize.js";
import { TasksRepository } from "../db/tasks-repo.js";
import { InboxRepository } from "../db/inbox-repo.js";
import { AppConfig, getConfig } from "../src/config.js";
import { classifyError } from "../src/errors.js";
import { withTransaction } from "../db/pool.js";
import { backoffMs } from "./retry-policy.js";
import { logger } from "../src/logger.js";

export interface WorkerOptions {
  client: NotionSyncClient;
  pool: pg.Pool;
  config?: AppConfig;
  /**
   * BUG-001: cache of the data source id resolved once per worker process, so
   * `is_in_source` is computed against the real data source (not raw config).
   */
  resolvedDataSourceId?: string;
}

/**
 * Processes a single claimed event according to SPEC §11.2.
 * Returns true if an event was claimed and processed, false if no pending events were due.
 */
export async function processNextEvent(options: WorkerOptions): Promise<boolean> {
  const config = options.config ?? getConfig();
  const pool = options.pool;
  const client = options.client;

  const event = await InboxRepository.claimNextEvent(pool);
  if (!event) {
    return false;
  }

  const eventId = event.event_id;
  const eventType = event.event_type;
  const pageId = event.entity_id ?? (event.payload?.entity as any)?.id;

  logger.info({ eventId, eventType, pageId, attempt: event.attempts }, "Worker processing inbox event");

  try {
    // Handle according to event matrix (SPEC §11.2)
    if (eventType === "page.deleted") {
      // Tombstone without re-fetching from Notion (404 expected on deleted page)
      if (pageId) {
        await withTransaction(pool, async (clientConn) => {
          await TasksRepository.markTaskInTrash(clientConn, pageId);
          await InboxRepository.settleEventSuccess(clientConn, eventId);
        });
      } else {
        await InboxRepository.settleEventSuccess(pool, eventId);
      }
    } else if (
      eventType === "page.created" ||
      eventType === "page.properties_updated" ||
      eventType === "page.content_updated" ||
      eventType === "page.undeleted" ||
      eventType === "page.moved"
    ) {
      if (!pageId) {
        throw new Error(`Page event ${eventType} missing entity ID`);
      }

      // Fetch latest authoritative page record from Notion (INV-2)
      const page = await client.fetchPage(pageId);

      // Fetch blocks if content updated and enabled.
      // BUG-004: leave `bodyBlocks` undefined when not fetched or when the fetch fails,
      // so the upsert preserves any previously stored page_content_json.
      let bodyBlocks: unknown[] | undefined;
      if (
        (eventType === "page.content_updated" || config.SYNC_SYNC_BODY_CONTENT) &&
        !page.in_trash
      ) {
        try {
          bodyBlocks = await client.fetchPageBlocks(pageId);
        } catch (blockErr) {
          logger.warn(
            { pageId, blockErr },
            "Could not fetch updated page body blocks; preserving stored page content"
          );
        }
      }

      // BUG-001: resolve the target data source once and reuse it for every page event
      if (!options.resolvedDataSourceId) {
        options.resolvedDataSourceId = await client.resolveDataSource(
          config.NOTION_DATABASE_ID,
          config.NOTION_DATA_SOURCE_ID
        );
      }

      const normalized = normalizePage(page, {
        configuredDataSourceId: options.resolvedDataSourceId,
        configuredDatabaseId: config.NOTION_DATABASE_ID,
        timezone: config.SYNC_TIMEZONE,
        bodyBlocks,
      });

      // Atomic commit: upsert task + settle inbox row (INV-6)
      await withTransaction(pool, async (clientConn) => {
        await TasksRepository.upsertTask(clientConn, normalized);
        await InboxRepository.settleEventSuccess(clientConn, eventId);
      });
    } else {
      // Out-of-scope or informational event: acknowledge without mutating tasks
      await withTransaction(pool, async (clientConn) => {
        await InboxRepository.settleEventSuccess(clientConn, eventId);
      });
    }

    logger.info({ eventId }, "Worker settled event as processed");
    return true;
  } catch (err) {
    const classification = classifyError(err, event.attempts, config.SYNC_MAX_ATTEMPTS);
    logger.error(
      { eventId, category: classification.category, err: classification.message },
      "Error processing inbox event"
    );

    if (classification.category === "RETRYABLE") {
      const delayMs = backoffMs(event.attempts, classification.retryAfterMs);
      const availableAt = new Date(Date.now() + delayMs);
      await InboxRepository.settleEventRetryable(pool, eventId, availableAt, classification.message);
    } else {
      // PERMANENT or EXHAUSTED
      await InboxRepository.settleEventFailed(pool, eventId, classification.message);
    }

    return true;
  }
}

/**
 * Runs the continuous worker loop with graceful shutdown support.
 */
export async function startWorker(options: WorkerOptions): Promise<void> {
  const config = options.config ?? getConfig();
  let isRunning = true;

  const stop = () => {
    logger.info("Worker received shutdown signal, draining in-flight work...");
    isRunning = false;
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  logger.info("Background sync worker started");

  let idleDelayMs = 1000;
  const maxIdleDelayMs = 30000;
  let lastLeaseCheck = 0;

  while (isRunning) {
    try {
      const now = Date.now();
      // Periodically recover expired leases (every 60s)
      if (now - lastLeaseCheck > 60000) {
        lastLeaseCheck = now;
        const recovered = await InboxRepository.recoverStuckEvents(options.pool, config.SYNC_LEASE_SECONDS);
        if (recovered > 0) {
          logger.warn({ recovered }, "Recovered stuck inbox events with expired leases");
        }
      }

      const didWork = await processNextEvent(options);
      if (didWork) {
        idleDelayMs = 1000; // Reset delay when work is happening
      } else {
        await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
        idleDelayMs = Math.min(idleDelayMs * 1.5, maxIdleDelayMs);
      }
    } catch (loopErr) {
      logger.error({ err: loopErr }, "Unexpected error in worker loop; sleeping 5s");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  logger.info("Worker stopped gracefully");
}
