/**
 * The single Notion access module. Every request goes through the shared retry
 * policy, pagination never trusts `results.length`, and page content is
 * paginated recursively (bounded, so a pathological workspace cannot OOM the
 * worker).
 */

import { Client, isFullPage } from '@notionhq/client';
import type { Logger } from 'pino';

import { SUPPORTED_NOTION_VERSION, type AppConfig } from '../src/config.js';
import { SyncError } from '../src/errors.js';
import { sanitizeError } from '../src/redact.js';
import type { NotionPageLike } from './normalize.js';
export type { NotionPageLike } from './normalize.js';
import { withRetry, type ErrorClassification } from './retry-policy.js';
import type { DataSourceSchema } from './property-map.js';

export interface NotionQueryResponse {
  readonly results: readonly unknown[];
  readonly has_more: boolean;
  readonly next_cursor: string | null;
  readonly request_status?: {
    readonly type?: string;
    readonly incomplete_reason?: string;
  };
}

export interface NotionListResponse {
  readonly results: readonly unknown[];
  readonly has_more: boolean;
  readonly next_cursor: string | null;
}

/**
 * The slice of the SDK this service uses. Tests inject a fake; production
 * injects the real `Client`, which keeps network I/O out of unit tests.
 */
export interface NotionApiPort {
  readonly databases: {
    retrieve(args: { database_id: string }): Promise<{
      data_sources?: ReadonlyArray<{ id: string; name?: string }> | null;
    }>;
  };
  readonly dataSources: {
    retrieve(args: { data_source_id: string }): Promise<{
      properties?: Readonly<Record<string, { type?: string } | undefined>> | null;
    }>;
    query(args: {
      data_source_id: string;
      page_size?: number;
      start_cursor?: string;
      [key: string]: unknown;
    }): Promise<NotionQueryResponse>;
  };
  readonly pages: {
    retrieve(args: { page_id: string }): Promise<unknown>;
  };
  readonly blocks: {
    readonly children: {
      list(args: {
        block_id: string;
        page_size?: number;
        start_cursor?: string;
        [key: string]: unknown;
      }): Promise<NotionListResponse>;
    };
  };
  readonly users: {
    me(args?: Record<string, never>): Promise<unknown>;
  };
}

export type NotionBlock = Record<string, unknown> & {
  id?: string;
  type?: string;
  has_children?: boolean;
  children?: NotionBlock[];
};

export interface PageScanSummary {
  readonly pagesSeen: number;
  /** False when Notion reported `request_status.incomplete` (10k cap). */
  readonly complete: boolean;
  readonly incompleteReason?: string;
  /** Cursor from the last response, for run diagnostics; null when finished. */
  readonly cursorReached: string | null;
}

export interface ScanPagesOptions {
  readonly pageSize?: number;
  readonly startCursor?: string;
  /**
   * Called after each API response with the cursor just reached, so a failing
   * run can record where it stopped instead of losing that information.
   */
  readonly onProgress?: (progress: { cursorReached: string | null; pagesSeen: number }) => void;
}

export interface NotionGateway {
  readonly apiVersion: typeof SUPPORTED_NOTION_VERSION;
  readonly maxContentDepth: number;
  resolveDataSource(): Promise<{ id: string; name: string }>;
  scanPages(
    dataSourceId: string,
    options: ScanPagesOptions,
    visit: (page: NotionPageLike) => void | Promise<void>,
  ): Promise<PageScanSummary>;
  retrievePage(pageId: string): Promise<NotionPageLike>;
  retrievePageBlocks(pageId: string): Promise<NotionBlock[]>;
  getSchema(dataSourceId: string): Promise<Record<string, string>>;
  checkAccess(): Promise<void>;
}

export interface NotionGatewayOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly api?: NotionApiPort;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly timeoutMs?: number;
  readonly maxContentDepth?: number;
  readonly maxContentBlocks?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_BLOCKS = 5_000;
const NOTION_PAGE_SIZE_MAX = 100;

export function createNotionGateway(options: NotionGatewayOptions): NotionGateway {
  const { config, logger } = options;
  const api: NotionApiPort =
    options.api ??
    (new Client({
      auth: config.notion.apiKey,
      notionVersion: config.notion.version,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Our backoff is the single policy; the SDK must not retry underneath it.
      retry: false,
    }) as unknown as NotionApiPort);

  const maxContentDepth = options.maxContentDepth ?? DEFAULT_MAX_DEPTH;
  const maxContentBlocks = options.maxContentBlocks ?? DEFAULT_MAX_BLOCKS;

  const request = async <T>(
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> =>
    withRetry(operation, {
      maxAttempts: config.sync.maxAttempts,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.random === undefined ? {} : { random: options.random }),
      onRetry: ({ attempt, delayMs, classification }: {
        attempt: number;
        delayMs: number;
        classification: ErrorClassification;
      }) => {
        logger.warn(
          {
            event: 'notion.retry',
            action,
            attempt,
            delay_ms: delayMs,
            error_class: classification.errorClass,
          },
          'retrying Notion request',
        );
      },
    });

  const resolveDataSource = async (): Promise<{ id: string; name: string }> => {
    const database = await request('retrieve_database', () =>
      api.databases.retrieve({ database_id: config.notion.databaseId }),
    );

    const sources = Array.isArray(database.data_sources) ? database.data_sources : [];
    if (sources.length === 0) {
      throw new SyncError(
        'The configured Notion database exposes no data sources. Check NOTION_DATABASE_ID and that the integration has access.',
        { errorClass: 'PERMANENT', code: 'notion_no_data_source' },
      );
    }

    const configuredId = config.notion.dataSourceId;
    const names = sources.map((source) => source.name ?? 'unnamed').join(', ');

    if (sources.length > 1 && configuredId === undefined) {
      throw new SyncError(
        `The configured Notion database exposes ${sources.length} data sources (${names}). Set NOTION_DATA_SOURCE_ID.`,
        { errorClass: 'PERMANENT', code: 'notion_data_source_ambiguous' },
      );
    }

    const normalized = (value: string): string => value.replace(/-/g, '').toLowerCase();
    const selected =
      configuredId === undefined
        ? sources[0]
        : sources.find((source) => normalized(source.id) === normalized(configuredId));

    if (selected === undefined) {
      throw new SyncError(
        `NOTION_DATA_SOURCE_ID does not match any data source in the configured database (available: ${names}).`,
        { errorClass: 'PERMANENT', code: 'notion_data_source_mismatch' },
      );
    }

    if (configuredId !== undefined && normalized(selected.id) !== normalized(configuredId)) {
      throw new SyncError(
        `Resolved data source "${selected.name ?? 'unnamed'}" does not match NOTION_DATA_SOURCE_ID.`,
        { errorClass: 'PERMANENT', code: 'notion_data_source_mismatch' },
      );
    }

    return { id: selected.id, name: selected.name ?? 'unnamed' };
  };

  const scanPages = async (
    dataSourceId: string,
    scanOptions: ScanPagesOptions,
    visit: (page: NotionPageLike) => void | Promise<void>,
  ): Promise<PageScanSummary> => {
    const pageSize = clampPageSize(scanOptions.pageSize ?? config.sync.pageSize);
    const seenCursors = new Set<string>();
    let cursor = scanOptions.startCursor;
    let pagesSeen = 0;
    let complete = true;
    let incompleteReason: string | undefined;
    let cursorReached: string | null = null;

    for (;;) {
      const response = await request('query_data_source', () =>
        api.dataSources.query({
          data_source_id: dataSourceId,
          page_size: pageSize,
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        }),
      );

      for (const result of response.results) {
        if (!isFullPage(result as never)) {
          logger.warn(
            { event: 'notion.partial_result_skipped', data_source_id: dataSourceId },
            'Notion query returned a partial page object',
          );
          continue;
        }
        pagesSeen += 1;
        await visit(result as unknown as NotionPageLike);
      }

      if (response.request_status?.type === 'incomplete') {
        complete = false;
        incompleteReason = response.request_status.incomplete_reason;
      }

      cursorReached = response.next_cursor;
      scanOptions.onProgress?.({ cursorReached, pagesSeen });
      if (response.has_more !== true) {
        break;
      }

      if (response.next_cursor === null || response.next_cursor === '') {
        throw new SyncError('Notion reported has_more without a next_cursor', {
          errorClass: 'PERMANENT',
          code: 'pagination_cursor_missing',
        });
      }
      if (seenCursors.has(response.next_cursor)) {
        throw new SyncError('Notion repeated a pagination cursor; aborting instead of looping', {
          errorClass: 'PERMANENT',
          code: 'pagination_cursor_loop',
        });
      }

      seenCursors.add(response.next_cursor);
      cursor = response.next_cursor;
    }

    return {
      pagesSeen,
      complete,
      ...(incompleteReason === undefined ? {} : { incompleteReason }),
      cursorReached,
    };
  };

  const retrievePage = async (pageId: string): Promise<NotionPageLike> => {
    const page = await request('retrieve_page', () => api.pages.retrieve({ page_id: pageId }));
    if (!isFullPage(page as never)) {
      throw new SyncError('Notion returned a partial page object; properties are unavailable', {
        errorClass: 'PERMANENT',
        code: 'notion_partial_page',
      });
    }
    return page as unknown as NotionPageLike;
  };

  const retrievePageBlocks = async (pageId: string): Promise<NotionBlock[]> => {
    let total = 0;

    const listChildren = async (blockId: string, depth: number): Promise<NotionBlock[]> => {
      if (depth > maxContentDepth) {
        logger.warn(
          { event: 'notion.content_depth_limited', block_id: blockId, depth },
          'page content exceeds the configured depth; deeper blocks were not fetched',
        );
        return [];
      }

      const nodes: NotionBlock[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      for (;;) {
        const response = await request('list_block_children', () =>
          api.blocks.children.list({
            block_id: blockId,
            page_size: NOTION_PAGE_SIZE_MAX,
            ...(cursor === undefined ? {} : { start_cursor: cursor }),
          }),
        );

        for (const raw of response.results) {
          if (total >= maxContentBlocks) {
            logger.warn(
              { event: 'notion.content_blocks_limited', block_id: blockId, limit: maxContentBlocks },
              'page content exceeds the configured block limit; remaining blocks were not fetched',
            );
            return nodes;
          }

          const block = raw as NotionBlock;
          total += 1;
          const node: NotionBlock = { ...block };
          const isContainer =
            block.has_children === true &&
            block.type !== 'child_page' &&
            block.type !== 'child_database' &&
            typeof block.id === 'string';

          if (isContainer) {
            node.children = await listChildren(block.id as string, depth + 1);
          }
          nodes.push(node);
        }

        if (response.has_more !== true) {
          break;
        }
        if (response.next_cursor === null || response.next_cursor === '') {
          throw new SyncError('Notion reported has_more without a next_cursor for block children', {
            errorClass: 'PERMANENT',
            code: 'pagination_cursor_missing',
          });
        }
        if (seenCursors.has(response.next_cursor)) {
          throw new SyncError('Notion repeated a block-children cursor; aborting', {
            errorClass: 'PERMANENT',
            code: 'pagination_cursor_loop',
          });
        }
        seenCursors.add(response.next_cursor);
        cursor = response.next_cursor;
      }

      return nodes;
    };

    try {
      return await listChildren(pageId, 0);
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      throw new SyncError(`failed to fetch page content: ${sanitizeError(error)}`, {
        errorClass: 'PERMANENT',
        code: 'notion_content_fetch_failed',
        cause: error,
      });
    }
  };

  const getSchema = async (dataSourceId: string): Promise<Record<string, string>> => {
    const dataSource = await request('retrieve_data_source', () =>
      api.dataSources.retrieve({ data_source_id: dataSourceId }),
    );
    return toSchemaMap({ properties: dataSource.properties ?? {} });
  };

  const checkAccess = async (): Promise<void> => {
    await request('users_me', () => api.users.me({}));
  };

  return {
    apiVersion: SUPPORTED_NOTION_VERSION,
    maxContentDepth,
    resolveDataSource,
    scanPages,
    retrievePage,
    retrievePageBlocks,
    getSchema,
    checkAccess,
  };
}

function clampPageSize(value: number): number {
  if (!Number.isFinite(value)) {
    return NOTION_PAGE_SIZE_MAX;
  }
  return Math.min(NOTION_PAGE_SIZE_MAX, Math.max(1, Math.floor(value)));
}

/** Exported for the startup schema check and reconciliation diff. */
export function toSchemaMap(schema: Pick<DataSourceSchema, 'properties'>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    map[name] = property?.type ?? 'unknown';
  }
  return map;
}
