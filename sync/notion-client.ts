import { Client } from "@notionhq/client";
import { AppConfig, getConfig } from "../src/config.js";
import { NotionApiError, ConfigurationError, sanitizeErrorMessage } from "../src/errors.js";
import { backoffMs, parseRetryAfter } from "./retry-policy.js";
import { logger } from "../src/logger.js";

export class NotionSyncClient {
  private readonly client: Client;
  private readonly config: AppConfig;

  constructor(config?: AppConfig, clientOverride?: Client) {
    this.config = config ?? getConfig();
    this.client = clientOverride ??
      new Client({
        auth: this.config.NOTION_API_KEY,
        notionVersion: this.config.NOTION_VERSION,
      });
  }

  /**
   * Executes a Notion API call with rate-limit and transient error retry logic.
   */
  private async executeWithRetry<T>(operation: () => Promise<T>, opName = "notion_api_call"): Promise<T> {
    let attempt = 0;
    const maxAttempts = this.config.SYNC_MAX_ATTEMPTS;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        return await operation();
      } catch (err: any) {
        const status = err.status ?? err.statusCode;
        const retryAfterHeader = err.headers?.get?.("retry-after") ?? err.headers?.["retry-after"];
        const retryAfterMs = parseRetryAfter(retryAfterHeader);

        const sanitized = sanitizeErrorMessage(err.message ?? String(err));
        const notionError = new NotionApiError(`Notion ${opName} failed (${status || "network"}): ${sanitized}`, {
          status,
          retryAfterSeconds: retryAfterMs ? retryAfterMs / 1000 : undefined,
          cause: err,
        });

        if (!notionError.isRetryable || attempt >= maxAttempts) {
          throw notionError;
        }

        const waitMs = backoffMs(attempt, retryAfterMs);
        logger.warn({ opName, attempt, waitMs, status }, "Retrying Notion API call after transient failure");
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    throw new NotionApiError(`Notion ${opName} failed after ${maxAttempts} attempts`);
  }

  /**
   * Resolves the target data source ID from the master Tasks database metadata.
   */
  async resolveDataSource(databaseId: string, configuredDataSourceId?: string): Promise<string> {
    const db: any = await this.executeWithRetry(
      () => this.client.databases.retrieve({ database_id: databaseId }),
      "databases.retrieve"
    );

    const dataSources: Array<{ id: string; name?: string }> = db.data_sources ?? [];

    if (dataSources.length === 0) {
      // In some Notion workspaces or API models, the database itself acts as the primary data source
      if (configuredDataSourceId) return configuredDataSourceId;
      return databaseId;
    }

    if (dataSources.length === 1 && dataSources[0]?.id) {
      const resolved = dataSources[0].id;
      if (configuredDataSourceId && configuredDataSourceId.replace(/-/g, "") !== resolved.replace(/-/g, "")) {
        throw new ConfigurationError(
          `Resolved data source ID (${resolved}) does not match configured NOTION_DATA_SOURCE_ID (${configuredDataSourceId})`
        );
      }
      return resolved;
    }

    if (!configuredDataSourceId) {
      const names = dataSources.map((ds) => ds.name || ds.id).join(", ");
      throw new ConfigurationError(
        `Database contains multiple data sources (${names}). You must specify NOTION_DATA_SOURCE_ID in configuration.`
      );
    }

    const match = dataSources.find(
      (ds) => ds.id.replace(/-/g, "") === configuredDataSourceId.replace(/-/g, "")
    );

    if (!match) {
      throw new ConfigurationError(
        `Configured NOTION_DATA_SOURCE_ID (${configuredDataSourceId}) not found in database data sources`
      );
    }

    return match.id;
  }

  /**
   * Queries task pages from the target data source with cursor pagination.
   */
  async queryDataSourcePages(
    dataSourceId: string,
    options: { startCursor?: string; pageSize?: number } = {}
  ): Promise<{ results: any[]; next_cursor: string | null; has_more: boolean }> {
    const pageSize = Math.min(Math.max(options.pageSize ?? this.config.SYNC_PAGE_SIZE, 1), 100);

    return this.executeWithRetry(
      async () => {
        // Use client.dataSources.query if available
        if (typeof (this.client as any).dataSources?.query === "function") {
          const res = await (this.client as any).dataSources.query({
            data_source_id: dataSourceId,
            start_cursor: options.startCursor,
            page_size: pageSize,
          });
          return {
            results: res.results ?? [],
            next_cursor: res.next_cursor ?? null,
            has_more: Boolean(res.has_more),
          };
        }

        // Fallback for database query
        const res: any = await (this.client.databases as any).query({
          database_id: dataSourceId,
          start_cursor: options.startCursor,
          page_size: pageSize,
        });

        return {
          results: res.results ?? [],
          next_cursor: res.next_cursor ?? null,
          has_more: Boolean(res.has_more),
        };
      },
      "dataSources.query"
    );
  }

  /**
   * Retrieves a single page by ID.
   */
  async fetchPage(pageId: string): Promise<any> {
    return this.executeWithRetry(
      () => this.client.pages.retrieve({ page_id: pageId }),
      "pages.retrieve"
    );
  }

  /**
   * Recursively retrieves block children for a task page.
   */
  async fetchPageBlocks(blockId: string, maxDepth = 3): Promise<any[]> {
    if (maxDepth <= 0) return [];

    const blocks: any[] = [];
    let cursor: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const response: any = await this.executeWithRetry(
        () =>
          this.client.blocks.children.list({
            block_id: blockId,
            start_cursor: cursor,
            page_size: 100,
          }),
        "blocks.children.list"
      );

      for (const block of response.results ?? []) {
        if (block.has_children && maxDepth > 1) {
          const children = await this.fetchPageBlocks(block.id, maxDepth - 1);
          blocks.push({ ...block, children });
        } else {
          blocks.push(block);
        }
      }

      hasMore = Boolean(response.has_more);
      cursor = response.next_cursor ?? undefined;
    }

    return blocks;
  }
}
