import { describe, it, expect, vi } from "vitest";
import { runReconciliation } from "../../sync/reconcile.js";
import { TasksRepository } from "../../db/tasks-repo.js";
import { RunsRepository } from "../../db/runs-repo.js";
import { validateConfig } from "../../src/config.js";

describe("Reconciliation and Operations (INV-5 Protection)", () => {
  const testConfig = validateConfig({
    NODE_ENV: "test",
    NOTION_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
  });

  it("complete scan with 0 failures updates tasks and remediates vanished records", async () => {
    const mockClient = {
      resolveDataSource: vi.fn().mockResolvedValue("ds_rec_1"),
      queryDataSourcePages: vi.fn().mockResolvedValue({
        results: [{ id: "page_active_1" }, { id: "page_active_2" }],
        next_cursor: null,
        has_more: false,
      }),
      fetchPage: vi.fn().mockImplementation(async (id: string) => ({
        id,
        properties: { Task: { type: "title", title: [{ plain_text: `Task ${id}` }] } },
      })),
    } as any;

    const upsertSpy = vi.spyOn(TasksRepository, "upsertTask").mockResolvedValue({} as any);
    const outOfSourceSpy = vi.spyOn(TasksRepository, "markTasksOutOfSource").mockResolvedValue(1);
    const startRunSpy = vi.spyOn(RunsRepository, "startRun").mockResolvedValue(201);
    const finishRunSpy = vi.spyOn(RunsRepository, "finishRun").mockResolvedValue();

    const mockPool = {} as any;

    const result = await runReconciliation({
      client: mockClient,
      pool: mockPool,
      config: testConfig,
      dryRun: false,
    });

    expect(result.status).toBe("succeeded");
    expect(result.recordsProcessed).toBe(2);
    expect(result.pageFailures).toBe(0);
    expect(result.remediatedOutdated).toBe(1);

    expect(upsertSpy).toHaveBeenCalledTimes(2);
    expect(outOfSourceSpy).toHaveBeenCalledWith(mockPool, ["page_active_1", "page_active_2"]);
    expect(finishRunSpy).toHaveBeenCalledWith(mockPool, 201, "succeeded", 2, null, undefined);

    upsertSpy.mockRestore();
    outOfSourceSpy.mockRestore();
    startRunSpy.mockRestore();
    finishRunSpy.mockRestore();
  });

  it("partial scan with page failure sets status=partial and NEVER triggers out-of-source remediation (INV-5)", async () => {
    const mockClient = {
      resolveDataSource: vi.fn().mockResolvedValue("ds_rec_1"),
      queryDataSourcePages: vi.fn().mockResolvedValue({
        results: [{ id: "page_good" }, { id: "page_bad" }],
        next_cursor: null,
        has_more: false,
      }),
      fetchPage: vi.fn().mockImplementation(async (id: string) => {
        if (id === "page_bad") {
          throw new Error("Temporary network timeout");
        }
        return {
          id,
          properties: { Task: { type: "title", title: [{ plain_text: "Good Task" }] } },
        };
      }),
    } as any;

    const upsertSpy = vi.spyOn(TasksRepository, "upsertTask").mockResolvedValue({} as any);
    const outOfSourceSpy = vi.spyOn(TasksRepository, "markTasksOutOfSource");
    const startRunSpy = vi.spyOn(RunsRepository, "startRun").mockResolvedValue(202);
    const finishRunSpy = vi.spyOn(RunsRepository, "finishRun").mockResolvedValue();

    const mockPool = {} as any;

    const result = await runReconciliation({
      client: mockClient,
      pool: mockPool,
      config: testConfig,
      dryRun: false,
    });

    expect(result.status).toBe("partial");
    expect(result.recordsProcessed).toBe(1);
    expect(result.pageFailures).toBe(1);
    // Crucial invariant: out-of-source remediation MUST NOT RUN on partial scan!
    expect(outOfSourceSpy).not.toHaveBeenCalled();

    expect(finishRunSpy).toHaveBeenCalledWith(
      mockPool,
      202,
      "partial",
      1,
      expect.stringContaining("Temporary network timeout"),
      undefined
    );

    upsertSpy.mockRestore();
    outOfSourceSpy.mockRestore();
    startRunSpy.mockRestore();
    finishRunSpy.mockRestore();
  });
});
