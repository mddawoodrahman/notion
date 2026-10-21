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
});
