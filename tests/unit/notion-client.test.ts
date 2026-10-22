import { describe, it, expect, vi } from "vitest";
import { NotionSyncClient } from "../../sync/notion-client.js";
import { validateConfig } from "../../src/config.js";
import { ConfigurationError, NotionApiError } from "../../src/errors.js";

describe("Notion API Client and Retry Policy", () => {
  const testConfig = validateConfig({
    NODE_ENV: "test",
    NOTION_API_KEY: "secret_test_key",
    NOTION_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
    SYNC_MAX_ATTEMPTS: "3",
  });

  it("resolves single data source from database metadata", async () => {
    const mockClient = {
      databases: {
        retrieve: vi.fn().mockResolvedValue({
          id: "db_123",
          data_sources: [{ id: "ds_456", name: "Tasks Data Source" }],
        }),
      },
    } as any;

    const syncClient = new NotionSyncClient(testConfig, mockClient);
    const resolved = await syncClient.resolveDataSource("db_123");
    expect(resolved).toBe("ds_456");
  });

  it("fails to resolve when database has multiple data sources and NOTION_DATA_SOURCE_ID is missing", async () => {
    const mockClient = {
      databases: {
        retrieve: vi.fn().mockResolvedValue({
          id: "db_123",
          data_sources: [
            { id: "ds_1", name: "Tasks" },
            { id: "ds_2", name: "Archive" },
          ],
        }),
      },
    } as any;

    const syncClient = new NotionSyncClient(testConfig, mockClient);
    await expect(syncClient.resolveDataSource("db_123")).rejects.toThrowError(ConfigurationError);
  });

  it("retries on transient 429 and eventually succeeds", async () => {
    let callCount = 0;
    const mockClient = {
      pages: {
        retrieve: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount < 2) {
            const err = new Error("Rate limit exceeded") as any;
            err.status = 429;
            err.headers = { get: (name: string) => (name === "retry-after" ? "0" : null) };
            throw err;
          }
          return { id: "page_123", properties: {} };
        }),
      },
    } as any;

    const syncClient = new NotionSyncClient(testConfig, mockClient);
    const page = await syncClient.fetchPage("page_123");
    expect(page.id).toBe("page_123");
    expect(callCount).toBe(2);
  });

  it("does not retry permanent 404 or 403 errors", async () => {
    let callCount = 0;
    const mockClient = {
      pages: {
        retrieve: vi.fn().mockImplementation(async () => {
          callCount++;
          const err = new Error("Page not found") as any;
          err.status = 404;
          throw err;
        }),
      },
    } as any;

    const syncClient = new NotionSyncClient(testConfig, mockClient);
    await expect(syncClient.fetchPage("page_not_found")).rejects.toThrowError(NotionApiError);
    expect(callCount).toBe(1); // No retries on 404
  });

  it("redacts secret tokens from error messages", async () => {
    const sensitiveKey = "secret_my_sensitive_notion_key_value";
    const mockClient = {
      pages: {
        retrieve: vi.fn().mockImplementation(async () => {
          throw new Error(`Failed with authorization header using ${sensitiveKey}`);
        }),
      },
    } as any;

    const syncClient = new NotionSyncClient(testConfig, mockClient);
    try {
      await syncClient.fetchPage("page_secret");
    } catch (err: any) {
      expect(err.message).not.toContain(sensitiveKey);
      expect(err.message).toContain("[REDACTED_NOTION_KEY]");
    }
  });

  it("surfaces Notion request_status as is_incomplete / incomplete_reason (BUG-002)", async () => {
    const mockClient = {
      dataSources: {
        query: vi.fn()
          .mockResolvedValueOnce({
            results: [{ id: "page_capped_1" }],
            next_cursor: null,
            has_more: false,
            request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
          })
          .mockResolvedValueOnce({
            results: [{ id: "page_ok_1" }],
            next_cursor: "cursor_next",
            has_more: true,
          }),
      },
    } as any;

    const syncClient = new NotionSyncClient(testConfig, mockClient);

    const capped = await syncClient.queryDataSourcePages("ds_123");
    expect(capped).toMatchObject({
      has_more: false,
      is_incomplete: true,
      incomplete_reason: "query_result_limit_reached",
    });
    expect(capped.results).toHaveLength(1);

    const complete = await syncClient.queryDataSourcePages("ds_123");
    expect(complete).toMatchObject({
      has_more: true,
      next_cursor: "cursor_next",
      is_incomplete: false,
      incomplete_reason: null,
    });
  });

  it("retries status-less RequestTimeoutError up to SYNC_MAX_ATTEMPTS before succeeding (BUG-003)", async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const mockClient = {
        pages: {
          retrieve: vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount < 3) {
              const err = new Error("Request timed out after 60000ms") as any;
              err.name = "RequestTimeoutError";
              err.code = "notionhq_client_request_timeout";
              throw err;
            }
            return { id: "page_timeout_ok", properties: {} };
          }),
        },
      } as any;

      const syncClient = new NotionSyncClient(testConfig, mockClient);
      const promise = syncClient.fetchPage("page_timeout_ok");

      // Drive the exponential backoff waits deterministically
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(promise).resolves.toMatchObject({ id: "page_timeout_ok" });
      expect(callCount).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries status-less ECONNRESET network failures and reports them retryable after exhaustion (BUG-003)", async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const mockClient = {
        pages: {
          retrieve: vi.fn().mockImplementation(async () => {
            callCount++;
            const err = new Error("socket hang up") as any;
            err.code = "ECONNRESET";
            throw err;
          }),
        },
      } as any;

      const syncClient = new NotionSyncClient(testConfig, mockClient);
      const settled = syncClient.fetchPage("page_reset").catch((err) => err);

      await vi.advanceTimersByTimeAsync(120_000);

      const err = await settled;
      expect(err).toBeInstanceOf(NotionApiError);
      expect(err.isRetryable).toBe(true);
      expect(err.message).toContain("network");
      expect(callCount).toBe(3); // SYNC_MAX_ATTEMPTS attempts, not one
    } finally {
      vi.useRealTimers();
    }
  });
});
