import { describe, it, expect, vi } from "vitest";
import { processNextEvent } from "../../sync/worker.js";
import { InboxRepository } from "../../db/inbox-repo.js";
import { TasksRepository } from "../../db/tasks-repo.js";
import { validateConfig } from "../../src/config.js";
import { NotionApiError } from "../../src/errors.js";

describe("Background Worker and Event Processing", () => {
  const testConfig = validateConfig({
    NODE_ENV: "test",
    SYNC_MAX_ATTEMPTS: "3",
  });

  const createMockPool = () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      release: vi.fn(),
    };
    return {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      mockClient,
    };
  };

  it("processes page.properties_updated event: fetches page and commits upsert transaction", async () => {
    const claimSpy = vi.spyOn(InboxRepository, "claimNextEvent").mockResolvedValue({
      event_id: "evt_prop_1",
      event_type: "page.properties_updated",
      entity_id: "page_123",
      entity_type: "page",
      event_timestamp: new Date(),
      payload: {},
      status: "processing",
      attempts: 1,
      received_at: new Date(),
      available_at: new Date(),
      locked_at: new Date(),
      processed_at: null,
      last_error: null,
    });

    const mockNotionClient = {
      resolveDataSource: vi.fn().mockResolvedValue("ds_test_123"),
      fetchPage: vi.fn().mockResolvedValue({
        id: "page_123",
        properties: {
          Task: { type: "title", title: [{ plain_text: "Updated Title" }] },
        },
      }),
      fetchPageBlocks: vi.fn().mockResolvedValue([]),
    } as any;

    const upsertSpy = vi.spyOn(TasksRepository, "upsertTask").mockResolvedValue({} as any);
    const settleSuccessSpy = vi.spyOn(InboxRepository, "settleEventSuccess").mockResolvedValue();

    const pool = createMockPool();

    const result = await processNextEvent({
      client: mockNotionClient,
      pool: pool as any,
      config: testConfig,
    });

    expect(result).toBe(true);
    expect(mockNotionClient.fetchPage).toHaveBeenCalledWith("page_123");
    expect(upsertSpy).toHaveBeenCalled();
    expect(settleSuccessSpy).toHaveBeenCalledWith(expect.anything(), "evt_prop_1");
    // Blocks were fetched successfully (even though empty) -> genuinely empty content, not "unknown"
    expect((upsertSpy.mock.calls[0]?.[1] as any)?.page_content_json).toEqual([]);

    claimSpy.mockRestore();
    upsertSpy.mockRestore();
    settleSuccessSpy.mockRestore();
  });

  it("processes page.deleted event: tombstones task without calling fetchPage", async () => {
    const claimSpy = vi.spyOn(InboxRepository, "claimNextEvent").mockResolvedValue({
      event_id: "evt_del_1",
      event_type: "page.deleted",
      entity_id: "page_deleted_123",
      entity_type: "page",
      event_timestamp: new Date(),
      payload: {},
      status: "processing",
      attempts: 1,
      received_at: new Date(),
      available_at: new Date(),
      locked_at: new Date(),
      processed_at: null,
      last_error: null,
    });

    const mockNotionClient = {
      fetchPage: vi.fn(),
    } as any;

    const trashSpy = vi.spyOn(TasksRepository, "markTaskInTrash").mockResolvedValue(true);
    const settleSuccessSpy = vi.spyOn(InboxRepository, "settleEventSuccess").mockResolvedValue();

    const pool = createMockPool();

    const result = await processNextEvent({
      client: mockNotionClient,
      pool: pool as any,
      config: testConfig,
    });

    expect(result).toBe(true);
    expect(mockNotionClient.fetchPage).not.toHaveBeenCalled();
    expect(trashSpy).toHaveBeenCalledWith(expect.anything(), "page_deleted_123");
    expect(settleSuccessSpy).toHaveBeenCalledWith(expect.anything(), "evt_del_1");

    claimSpy.mockRestore();
    trashSpy.mockRestore();
    settleSuccessSpy.mockRestore();
  });

  it("handles transient failure by settling event as retryable pending", async () => {
    const claimSpy = vi.spyOn(InboxRepository, "claimNextEvent").mockResolvedValue({
      event_id: "evt_transient_1",
      event_type: "page.properties_updated",
      entity_id: "page_err",
      entity_type: "page",
      event_timestamp: new Date(),
      payload: {},
      status: "processing",
      attempts: 1, // first attempt
      received_at: new Date(),
      available_at: new Date(),
      locked_at: new Date(),
      processed_at: null,
      last_error: null,
    });

    const mockNotionClient = {
      fetchPage: vi.fn().mockRejectedValue(
        new NotionApiError("Notion rate limited", { status: 429, retryAfterSeconds: 5 })
      ),
    } as any;

    const settleRetrySpy = vi.spyOn(InboxRepository, "settleEventRetryable").mockResolvedValue();

    const pool = createMockPool();

    const result = await processNextEvent({
      client: mockNotionClient,
      pool: pool as any,
      config: testConfig,
    });

    expect(result).toBe(true);
    expect(settleRetrySpy).toHaveBeenCalledWith(
      expect.anything(),
      "evt_transient_1",
      expect.any(Date),
      expect.stringContaining("rate limited")
    );

    claimSpy.mockRestore();
    settleRetrySpy.mockRestore();
  });

  it("handles permanent failure by settling event as failed", async () => {
    const claimSpy = vi.spyOn(InboxRepository, "claimNextEvent").mockResolvedValue({
      event_id: "evt_perm_1",
      event_type: "page.properties_updated",
      entity_id: "page_bad",
      entity_type: "page",
      event_timestamp: new Date(),
      payload: {},
      status: "processing",
      attempts: 1,
      received_at: new Date(),
      available_at: new Date(),
      locked_at: new Date(),
      processed_at: null,
      last_error: null,
    });

    const mockNotionClient = {
      fetchPage: vi.fn().mockRejectedValue(
        new NotionApiError("Invalid query", { status: 400 })
      ),
    } as any;

    const settleFailedSpy = vi.spyOn(InboxRepository, "settleEventFailed").mockResolvedValue();

    const pool = createMockPool();

    const result = await processNextEvent({
      client: mockNotionClient,
      pool: pool as any,
      config: testConfig,
    });

    expect(result).toBe(true);
    expect(settleFailedSpy).toHaveBeenCalledWith(
      expect.anything(),
      "evt_perm_1",
      expect.stringContaining("Invalid query")
    );

    claimSpy.mockRestore();
    settleFailedSpy.mockRestore();
  });

  it("marks event failed when attempts reach SYNC_MAX_ATTEMPTS (EXHAUSTED)", async () => {
    const claimSpy = vi.spyOn(InboxRepository, "claimNextEvent").mockResolvedValue({
      event_id: "evt_exhausted_1",
      event_type: "page.properties_updated",
      entity_id: "page_err",
      entity_type: "page",
      event_timestamp: new Date(),
      payload: {},
      status: "processing",
      attempts: 3, // equals max attempts 3
      received_at: new Date(),
      available_at: new Date(),
      locked_at: new Date(),
      processed_at: null,
      last_error: null,
    });

    const mockNotionClient = {
      fetchPage: vi.fn().mockRejectedValue(
        new NotionApiError("Service unavailable", { status: 503 })
      ),
    } as any;

    const settleFailedSpy = vi.spyOn(InboxRepository, "settleEventFailed").mockResolvedValue();

    const pool = createMockPool();

    const result = await processNextEvent({
      client: mockNotionClient,
      pool: pool as any,
      config: testConfig,
    });

    expect(result).toBe(true);
    expect(settleFailedSpy).toHaveBeenCalledWith(
      expect.anything(),
      "evt_exhausted_1",
      expect.stringContaining("Exhausted after 3 attempts")
    );

    claimSpy.mockRestore();
    settleFailedSpy.mockRestore();
  });

  const eventRecord = (overrides: Record<string, unknown>) => ({
    event_id: "evt_default",
    event_type: "page.properties_updated",
    entity_id: "page_default",
    entity_type: "page",
    event_timestamp: new Date(),
    payload: {},
    status: "processing",
    attempts: 1,
    received_at: new Date(),
    available_at: new Date(),
    locked_at: new Date(),
    processed_at: null,
    last_error: null,
    ...overrides,
  }) as any;

  it("resolves the data source once and computes is_in_source against it even when NOTION_DATA_SOURCE_ID is unset (BUG-001)", async () => {
    const config = validateConfig({
      NODE_ENV: "test",
      NOTION_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
      NOTION_DATA_SOURCE_ID: "",
      SYNC_MAX_ATTEMPTS: "3",
    });

    const claimSpy = vi
      .spyOn(InboxRepository, "claimNextEvent")
      .mockResolvedValueOnce(eventRecord({ event_id: "evt_ds_1", entity_id: "page_ds_1" }))
      .mockResolvedValueOnce(eventRecord({ event_id: "evt_ds_2", entity_id: "page_ds_2" }));

    const resolveSpy = vi.fn().mockResolvedValue("ds-123");
    const mockNotionClient = {
      resolveDataSource: resolveSpy,
      fetchPage: vi.fn().mockImplementation(async (id: string) => ({
        id,
        parent: { type: "data_source_id", data_source_id: "ds-123" },
        properties: { Task: { type: "title", title: [{ plain_text: `Task ${id}` }] } },
      })),
      fetchPageBlocks: vi.fn().mockResolvedValue([]),
    } as any;

    const upsertSpy = vi.spyOn(TasksRepository, "upsertTask").mockResolvedValue({} as any);
    const settleSuccessSpy = vi.spyOn(InboxRepository, "settleEventSuccess").mockResolvedValue();

    try {
      const options = { client: mockNotionClient, pool: createMockPool() as any, config };

      expect(await processNextEvent(options)).toBe(true);
      expect(await processNextEvent(options)).toBe(true);

      // Resolved exactly once for the worker process, not once per event
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", "");

      const records = upsertSpy.mock.calls.map(([, record]) => record as any);
      expect(records).toHaveLength(2);
      // Both pages live in the resolved data source: raw empty config must not mark them out-of-source
      expect(records.map((record) => record.is_in_source)).toEqual([true, true]);
    } finally {
      claimSpy.mockRestore();
      upsertSpy.mockRestore();
      settleSuccessSpy.mockRestore();
    }
  });

  it("keeps page_content_json null when the block fetch fails so stored content is preserved (BUG-004)", async () => {
    const claimSpy = vi.spyOn(InboxRepository, "claimNextEvent").mockResolvedValue(
      eventRecord({
        event_id: "evt_blocks_1",
        entity_id: "page_blocks_1",
        event_type: "page.content_updated",
      })
    );

    const mockNotionClient = {
      resolveDataSource: vi.fn().mockResolvedValue("ds_test_123"),
      fetchPage: vi.fn().mockResolvedValue({
        id: "page_blocks_1",
        in_trash: false,
        properties: { Task: { type: "title", title: [{ plain_text: "Content task" }] } },
      }),
      fetchPageBlocks: vi.fn().mockRejectedValue(new Error("blocks endpoint unavailable")),
    } as any;

    const upsertSpy = vi.spyOn(TasksRepository, "upsertTask").mockResolvedValue({} as any);
    const settleSuccessSpy = vi.spyOn(InboxRepository, "settleEventSuccess").mockResolvedValue();

    try {
      const result = await processNextEvent({
        client: mockNotionClient,
        pool: createMockPool() as any,
        config: testConfig,
      });

      expect(result).toBe(true);
      expect(mockNotionClient.fetchPageBlocks).toHaveBeenCalledWith("page_blocks_1");
      expect((upsertSpy.mock.calls[0]?.[1] as any)?.page_content_json).toBeNull();
      // Missing body content is not a task failure: the event still settles as processed
      expect(settleSuccessSpy).toHaveBeenCalledWith(expect.anything(), "evt_blocks_1");
    } finally {
      claimSpy.mockRestore();
      upsertSpy.mockRestore();
      settleSuccessSpy.mockRestore();
    }
  });

  it("treats status-less network failures (TypeError: fetch failed) as retryable, not permanent (BUG-003)", async () => {
    const claimSpy = vi.spyOn(InboxRepository, "claimNextEvent").mockResolvedValue(
      eventRecord({ event_id: "evt_net_1", entity_id: "page_net_1" })
    );

    const networkError = new TypeError("fetch failed");
    (networkError as any).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    });

    const mockNotionClient = {
      resolveDataSource: vi.fn().mockResolvedValue("ds_test_123"),
      fetchPage: vi.fn().mockRejectedValue(networkError),
    } as any;

    const settleRetrySpy = vi.spyOn(InboxRepository, "settleEventRetryable").mockResolvedValue();
    const settleFailedSpy = vi.spyOn(InboxRepository, "settleEventFailed").mockResolvedValue();

    try {
      const result = await processNextEvent({
        client: mockNotionClient,
        pool: createMockPool() as any,
        config: testConfig,
      });

      expect(result).toBe(true);
      expect(settleRetrySpy).toHaveBeenCalledWith(
        expect.anything(),
        "evt_net_1",
        expect.any(Date),
        expect.stringContaining("fetch failed")
      );
      expect(settleFailedSpy).not.toHaveBeenCalled();
    } finally {
      claimSpy.mockRestore();
      settleRetrySpy.mockRestore();
      settleFailedSpy.mockRestore();
    }
  });

  it("rolls back before releasing the client when an informational event fails to settle (BUG-007, INV-6)", async () => {
    const claimSpy = vi.spyOn(InboxRepository, "claimNextEvent").mockResolvedValue(
      eventRecord({
        event_id: "evt_info_1",
        event_type: "database.schema_updated",
        entity_id: null,
        entity_type: "database",
      })
    );

    const settleSuccessSpy = vi
      .spyOn(InboxRepository, "settleEventSuccess")
      .mockRejectedValue(new Error("inbox write failed"));
    const settleFailedSpy = vi.spyOn(InboxRepository, "settleEventFailed").mockResolvedValue();

    const pool = createMockPool();

    try {
      const result = await processNextEvent({
        client: {} as any,
        pool: pool as any,
        config: testConfig,
      });

      expect(result).toBe(true);

      const sqlStatements = pool.mockClient.query.mock.calls.map(([sql]) => String(sql));
      const beginIndex = sqlStatements.indexOf("BEGIN");
      const rollbackIndex = sqlStatements.indexOf("ROLLBACK");

      expect(beginIndex).toBeGreaterThanOrEqual(0);
      expect(rollbackIndex).toBeGreaterThan(beginIndex);
      expect(sqlStatements).not.toContain("COMMIT");

      // The client is released only after the rollback has been issued
      const rollbackOrder = pool.mockClient.query.mock.invocationCallOrder[rollbackIndex] ?? 0;
      const releaseOrder = pool.mockClient.release.mock.invocationCallOrder[0] ?? 0;
      expect(releaseOrder).toBeGreaterThan(rollbackOrder);

      expect(settleFailedSpy).toHaveBeenCalledWith(
        expect.anything(),
        "evt_info_1",
        expect.stringContaining("inbox write failed")
      );
    } finally {
      claimSpy.mockRestore();
      settleSuccessSpy.mockRestore();
      settleFailedSpy.mockRestore();
    }
  });
});
