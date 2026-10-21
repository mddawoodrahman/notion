import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import {
  createNotionGateway,
  type NotionApiPort,
  type NotionPageLike,
} from '../../sync/notion-client.js';

const DATA_SOURCE_ID = '11111111-1111-4111-8111-111111111111';

const logger = createLogger({ env: 'test', logLevel: 'silent' });

function fakePage(id: string): NotionPageLike {
  return {
    object: 'page',
    id,
    url: `https://www.notion.so/${id}`,
    created_time: '2026-10-01T00:00:00.000Z',
    last_edited_time: '2026-10-02T00:00:00.000Z',
    in_trash: false,
    archived: false,
    is_archived: false,
    parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
    properties: {},
  };
}

function api(overrides: Partial<NotionApiPort> = {}): NotionApiPort {
  const base: NotionApiPort = {
    databases: {
      retrieve: vi.fn(async () => ({ data_sources: [{ id: DATA_SOURCE_ID, name: 'Tasks' }] })),
    },
    dataSources: {
      retrieve: vi.fn(async () => ({ properties: {} })),
      query: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
    },
    pages: { retrieve: vi.fn(async () => fakePage('p1')) },
    blocks: {
      children: {
        list: vi.fn(async () => ({ results: [], has_more: false, next_cursor: null })),
      },
    },
    users: { me: vi.fn(async () => ({ id: 'bot' })) },
  };

  return { ...base, ...overrides } as NotionApiPort;
}

function gateway(options: {
  api?: NotionApiPort;
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
} = {}) {
  const config = loadConfig({ NODE_ENV: 'test', ...options.env });
  return createNotionGateway({
    config,
    logger,
    api: options.api ?? api(),
    sleep: options.sleep ?? (async () => undefined),
    random: options.random ?? (() => 1),
  });
}

describe('createNotionGateway', () => {
  it('pins the supported Notion version on a real SDK client', () => {
    const client = createNotionGateway({
      config: loadConfig({ NODE_ENV: 'test' }),
      logger,
    });

    expect(client.apiVersion).toBe('2026-03-11');
  });

  it('resolves a single data source from the configured database', async () => {
    const client = gateway();

    await expect(client.resolveDataSource()).resolves.toEqual({
      id: DATA_SOURCE_ID,
      name: 'Tasks',
    });
  });

  it('fails when the database has no data sources', async () => {
    const client = gateway({
      api: api({
        databases: { retrieve: vi.fn(async () => ({ data_sources: [] })) },
      }),
    });

    await expect(client.resolveDataSource()).rejects.toMatchObject({
      name: 'SyncError',
      code: 'notion_no_data_source',
      errorClass: 'PERMANENT',
    });
  });

  it('requires an explicit data source id when several exist, listing names only', async () => {
    const client = gateway({
      api: api({
        databases: {
          retrieve: vi.fn(async () => ({
            data_sources: [
              { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Tasks' },
              { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Archive' },
            ],
          })),
        },
      }),
    });

    const error = (await client
      .resolveDataSource()
      .catch((caught: unknown) => caught)) as Error & { code?: string };

    expect(error).toMatchObject({ code: 'notion_data_source_ambiguous' });
    expect(error.message).toContain('Tasks');
    expect(error.message).toContain('Archive');
    expect(error.message).not.toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('honours NOTION_DATA_SOURCE_ID when several data sources exist', async () => {
    const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const client = gateway({
      env: { NOTION_DATA_SOURCE_ID: otherId },
      api: api({
        databases: {
          retrieve: vi.fn(async () => ({
            data_sources: [
              { id: DATA_SOURCE_ID, name: 'Tasks' },
              { id: otherId, name: 'Archive' },
            ],
          })),
        },
      }),
    });

    await expect(client.resolveDataSource()).resolves.toEqual({ id: otherId, name: 'Archive' });
  });

  it('fails when the configured data source id does not match the database', async () => {
    const client = gateway({ env: { NOTION_DATA_SOURCE_ID: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } });

    await expect(client.resolveDataSource()).rejects.toMatchObject({
      code: 'notion_data_source_mismatch',
      errorClass: 'PERMANENT',
    });
  });

  it('walks every page using the opaque cursor, not the result count (I-10)', async () => {
    const pages = [100, 40, 7].map((size, index) => ({
      results: Array.from({ length: size }, (_, i) => fakePage(`p${index}-${i}`)),
      has_more: index < 2,
      next_cursor: index === 0 ? 'cursor-1' : index === 1 ? 'cursor-2' : null,
      ...(index === 2
        ? { request_status: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' } }
        : {}),
    }));

    const query = vi.fn(async (args: Record<string, unknown>) => {
      if (args.start_cursor === undefined) return pages[0];
      if (args.start_cursor === 'cursor-1') return pages[1];
      if (args.start_cursor === 'cursor-2') return pages[2];
      throw new Error(`unexpected cursor ${String(args.start_cursor)}`);
    });

    const client = gateway({ api: api({ dataSources: { retrieve: vi.fn(), query } as never }) });
    const visited: NotionPageLike[] = [];

    const summary = await client.scanPages(DATA_SOURCE_ID, {}, (page) => {
      visited.push(page);
    });

    expect(visited).toHaveLength(147);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[0]).toMatchObject({ start_cursor: 'cursor-1', page_size: 100 });
    expect(summary).toMatchObject({
      pagesSeen: 147,
      complete: false,
      incompleteReason: 'query_result_limit_reached',
      cursorReached: null,
    });
  });

  it('reports a complete scan when Notion omits request_status', async () => {
    const client = gateway({
      api: api({
        dataSources: {
          retrieve: vi.fn(),
          query: vi.fn(async () => ({ results: [fakePage('p1')], has_more: false, next_cursor: null })),
        } as never,
      }),
    });

    const summary = await client.scanPages(DATA_SOURCE_ID, {}, () => undefined);

    expect(summary.complete).toBe(true);
    expect(summary.incompleteReason).toBeUndefined();
  });

  it('aborts when the server repeats the same next_cursor (I-11)', async () => {
    const query = vi.fn(async () => ({
      results: [fakePage('p1')],
      has_more: true,
      next_cursor: 'stuck',
    }));
    const client = gateway({ api: api({ dataSources: { retrieve: vi.fn(), query } as never }) });

    await expect(client.scanPages(DATA_SOURCE_ID, {}, () => undefined)).rejects.toMatchObject({
      name: 'SyncError',
      code: 'pagination_cursor_loop',
      errorClass: 'PERMANENT',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('aborts when has_more is true but no cursor is returned', async () => {
    const client = gateway({
      api: api({
        dataSources: {
          retrieve: vi.fn(),
          query: vi.fn(async () => ({ results: [fakePage('p1')], has_more: true, next_cursor: null })),
        } as never,
      }),
    });

    await expect(client.scanPages(DATA_SOURCE_ID, {}, () => undefined)).rejects.toMatchObject({
      code: 'pagination_cursor_missing',
    });
  });

  it('clamps the requested page size to Notion’s maximum of 100', async () => {
    const query = vi.fn<(args: { page_size?: number }) => Promise<{
      results: never[];
      has_more: boolean;
      next_cursor: null;
    }>>(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }));
    const client = gateway({ api: api({ dataSources: { retrieve: vi.fn(), query } as never }) });

    await client.scanPages(DATA_SOURCE_ID, { pageSize: 5_000 }, () => undefined);
    expect(query.mock.calls[0]?.[0]).toMatchObject({ page_size: 100 });

    await client.scanPages(DATA_SOURCE_ID, { pageSize: 0 }, () => undefined);
    expect(query.mock.calls[1]?.[0]).toMatchObject({ page_size: 1 });
  });

  it('retries 429 responses and honours Retry-After', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const query = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, headers: { 'retry-after': '2' }, message: 'slow down' })
      .mockResolvedValueOnce({ results: [fakePage('p1')], has_more: false, next_cursor: null });

    const client = gateway({
      sleep,
      random: () => 0,
      api: api({ dataSources: { retrieve: vi.fn(), query } as never }),
    });

    await client.scanPages(DATA_SOURCE_ID, {}, () => undefined);

    expect(query).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBe(2_000);
  });

  it('does not retry a 403 permission error', async () => {
    const sleep = vi.fn(async () => undefined);
    const query = vi.fn().mockRejectedValue({ status: 403, message: 'forbidden' });
    const client = gateway({
      sleep,
      api: api({ dataSources: { retrieve: vi.fn(), query } as never }),
    });

    await expect(client.scanPages(DATA_SOURCE_ID, {}, () => undefined)).rejects.toMatchObject({
      errorClass: 'PERMANENT',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('recursively paginates block children to full depth (I-12)', async () => {
    const block = (id: string, hasChildren: boolean, type = 'paragraph') => ({
      object: 'block',
      id,
      type,
      has_children: hasChildren,
    });

    const list = vi.fn(async (args: { block_id: string }) => {
      switch (args.block_id) {
        case 'page':
          return {
            results: [block('a', true), block('b', false), block('child-page', true, 'child_page')],
            has_more: false,
            next_cursor: null,
          };
        case 'a':
          return { results: [block('c', true)], has_more: false, next_cursor: null };
        case 'c':
          return { results: [block('d', false)], has_more: false, next_cursor: null };
        default:
          return { results: [], has_more: false, next_cursor: null };
      }
    });

    const client = gateway({ api: api({ blocks: { children: { list } } as never }) });
    const blocks = await client.retrievePageBlocks('page');

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ id: 'a', children: [{ id: 'c', children: [{ id: 'd' }] }] });
    expect(blocks[2]).toMatchObject({ id: 'child-page' });
    expect(blocks[2]).not.toHaveProperty('children');
    expect(list.mock.calls.map((call) => call[0].block_id)).toEqual(['page', 'a', 'c']);
  });

  it('follows block pagination cursors', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ object: 'block', id: 'b1', type: 'paragraph', has_children: false }],
        has_more: true,
        next_cursor: 'next',
      })
      .mockResolvedValueOnce({
        results: [{ object: 'block', id: 'b2', type: 'paragraph', has_children: false }],
        has_more: false,
        next_cursor: null,
      });

    const client = gateway({ api: api({ blocks: { children: { list } } as never }) });
    const blocks = await client.retrievePageBlocks('page');

    expect(blocks.map((block) => (block as { id: string }).id)).toEqual(['b1', 'b2']);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ start_cursor: 'next' });
  });

  it('rejects pages that are not full page objects', async () => {
    const client = gateway({
      api: api({ pages: { retrieve: vi.fn(async () => ({ object: 'page', id: 'p1' })) } }),
    });

    await expect(client.retrievePage('p1')).rejects.toMatchObject({
      code: 'notion_partial_page',
      errorClass: 'PERMANENT',
    });
  });

  it('sanitizes secrets from surfaced API errors', async () => {
    const client = gateway({
      api: api({
        pages: {
          retrieve: vi.fn(async () => {
            throw new Error('bad token secret_abcdef1234567890');
          }),
        },
      }),
    });

    await expect(client.retrievePage('p1')).rejects.toMatchObject({
      message: expect.not.stringContaining('secret_abcdef1234567890'),
    });
  });

  it('checks API access through /users/me', async () => {
    const me = vi.fn(async () => ({ id: 'bot' }));
    const client = gateway({ api: api({ users: { me } }) });

    await client.checkAccess();
    expect(me).toHaveBeenCalledTimes(1);
  });

  it('returns a name→type schema map', async () => {
    const client = gateway({
      api: api({
        dataSources: {
          retrieve: vi.fn(async () => ({
            properties: {
              Name: { type: 'title' },
              Status: { type: 'status' },
              UnknownFuture: { type: 'verification' },
            },
          })),
          query: vi.fn(),
        } as never,
      }),
    });

    await expect(client.getSchema(DATA_SOURCE_ID)).resolves.toEqual({
      Name: 'title',
      Status: 'status',
      UnknownFuture: 'verification',
    });
  });
});
