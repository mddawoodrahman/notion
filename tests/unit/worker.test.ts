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
});
