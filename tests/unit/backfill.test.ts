import { describe, it, expect, vi } from "vitest";
import { runBackfill } from "../../sync/backfill.js";
import { TasksRepository } from "../../db/tasks-repo.js";
import { RunsRepository } from "../../db/runs-repo.js";
import { validateConfig } from "../../src/config.js";

describe("Initial Backfill Command and Cursor Pagination", () => {
  const testConfig = validateConfig({
    NODE_ENV: "test",
    NOTION_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
    SYNC_PAGE_SIZE: "2",
  });

  it("paginates across multiple cursor pages until has_more is false", async () => {
    const mockClient = {
      resolveDataSource: vi.fn().mockResolvedValue("ds_test_123"),
      queryDataSourcePages: vi.fn()
        .mockResolvedValueOnce({
          results: [
            { id: "page_1", properties: { Task: { type: "title", title: [{ plain_text: "Task 1" }] } } },
            { id: "page_2", properties: { Task: { type: "title", title: [{ plain_text: "Task 2" }] } } },
          ],
          next_cursor: "cursor_page_2",
          has_more: true,
        })
        .mockResolvedValueOnce({
          results: [
            { id: "page_3", properties: { Task: { type: "title", title: [{ plain_text: "Task 3" }] } } },
          ],
          next_cursor: null,
          has_more: false,
        }),
    } as any;

    const upsertSpy = vi.spyOn(TasksRepository, "upsertTask").mockResolvedValue({} as any);
    const startRunSpy = vi.spyOn(RunsRepository, "startRun").mockResolvedValue(101);
    const finishRunSpy = vi.spyOn(RunsRepository, "finishRun").mockResolvedValue();

    const mockPool = {} as any;

    const result = await runBackfill({
      client: mockClient,
      pool: mockPool,
      config: testConfig,
      dryRun: false,
    });

    expect(result.status).toBe("succeeded");
    expect(result.recordsProcessed).toBe(3);
    expect(result.pageFailures).toBe(0);
    expect(result.runId).toBe(101);

    expect(mockClient.queryDataSourcePages).toHaveBeenCalledTimes(2);
    expect(mockClient.queryDataSourcePages).toHaveBeenNthCalledWith(1, "ds_test_123", {
      startCursor: undefined,
      pageSize: 2,
    });
    expect(mockClient.queryDataSourcePages).toHaveBeenNthCalledWith(2, "ds_test_123", {
      startCursor: "cursor_page_2",
      pageSize: 2,
    });

    expect(upsertSpy).toHaveBeenCalledTimes(3);
    expect(startRunSpy).toHaveBeenCalledWith(mockPool, "initial_backfill");
    expect(finishRunSpy).toHaveBeenCalledWith(mockPool, 101, "succeeded", 3, null, undefined);

    upsertSpy.mockRestore();
    startRunSpy.mockRestore();
    finishRunSpy.mockRestore();
  });

  it("dry-run mode normalizes and counts records without writing to DB or sync_runs", async () => {
    const mockClient = {
      resolveDataSource: vi.fn().mockResolvedValue("ds_test_123"),
      queryDataSourcePages: vi.fn().mockResolvedValue({
        results: [
          { id: "page_dry_1", properties: { Task: { type: "title", title: [{ plain_text: "Dry 1" }] } } },
        ],
        next_cursor: null,
        has_more: false,
      }),
    } as any;

    const upsertSpy = vi.spyOn(TasksRepository, "upsertTask");
    const startRunSpy = vi.spyOn(RunsRepository, "startRun");

    const result = await runBackfill({
      client: mockClient,
      pool: {} as any,
      config: testConfig,
      dryRun: true,
    });

    expect(result.status).toBe("succeeded");
    expect(result.recordsProcessed).toBe(1);
    expect(result.runId).toBeNull();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(startRunSpy).not.toHaveBeenCalled();

    upsertSpy.mockRestore();
    startRunSpy.mockRestore();
  });

  it("detects infinite cursor cycle and aborts safely", async () => {
    const mockClient = {
      resolveDataSource: vi.fn().mockResolvedValue("ds_test_123"),
      queryDataSourcePages: vi.fn().mockResolvedValue({
        results: [],
        next_cursor: "stuck_cursor",
        has_more: true,
      }),
    } as any;

    const startRunSpy = vi.spyOn(RunsRepository, "startRun").mockResolvedValue(102);
    const finishRunSpy = vi.spyOn(RunsRepository, "finishRun").mockResolvedValue();

    await expect(
      runBackfill({
        client: mockClient,
        pool: {} as any,
        config: testConfig,
        dryRun: false,
      })
    ).rejects.toThrowError(/Infinite pagination cycle detected/);

    expect(finishRunSpy).toHaveBeenCalledWith(
      expect.anything(),
      102,
      "failed",
      0,
      expect.stringContaining("Infinite pagination cycle detected"),
      "stuck_cursor"
    );

    startRunSpy.mockRestore();
    finishRunSpy.mockRestore();
  });
});
