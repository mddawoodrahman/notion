import { describe, it, expect, vi } from "vitest";
import { TasksRepository } from "../../db/tasks-repo.js";
import { InboxRepository } from "../../db/inbox-repo.js";
import { RunsRepository } from "../../db/runs-repo.js";
import { NormalizedTaskRecord } from "../../sync/normalize.js";

describe("Idempotent Repository SQL and Query Logic", () => {
  const sampleTask: NormalizedTaskRecord = {
    notion_page_id: "test-page-1234",
    title: "Verify Idempotency",
    status: "Done",
    list_name: "QA",
    important: true,
    in_my_day: false,
    priority: "Urgent",
    due_date: "2026-10-25",
    due_at: null,
    reminder_at: null,
    user_archived: false,
    notion_is_archived: false,
    notion_in_trash: false,
    is_in_source: true,
    page_url: "https://notion.so/test",
    notion_created_time: "2026-10-21T10:00:00.000Z",
    notion_last_edited_time: "2026-10-21T12:00:00.000Z",
    raw_properties: { foo: "bar" },
    page_content_json: [{ type: "paragraph" }],
    synced_at: "2026-10-21T12:05:00.000Z",
  };

  it("upsertTask formats parameterized query with 19 values and INV-4 last_edited_time guard", async () => {
    let capturedQuery = "";
    let capturedValues: any[] = [];

    const mockDb = {
      query: vi.fn().mockImplementation(async (query: string, values: any[]) => {
        capturedQuery = query;
        capturedValues = values;
        return { rows: [sampleTask], rowCount: 1 };
      }),
    } as any;

    const result = await TasksRepository.upsertTask(mockDb, sampleTask);
    expect(result).toBeDefined();

    // Verify SQL syntax and contract
    expect(capturedQuery).toContain("INSERT INTO notion_sync.notion_tasks");
    expect(capturedQuery).toContain("ON CONFLICT (notion_page_id) DO UPDATE SET");
    expect(capturedQuery).toContain("EXCLUDED.notion_last_edited_time >= notion_sync.notion_tasks.notion_last_edited_time");

    // BUG-004: null incoming content must never wipe stored content
    expect(capturedQuery).toContain("COALESCE($19::jsonb, '[]'::jsonb)");
    expect(capturedQuery).toMatch(
      /page_content_json\s*=\s*COALESCE\(\$19::jsonb,\s*notion_sync\.notion_tasks\.page_content_json\)/
    );
    // BUG-008: a null incoming timestamp must not be an unconditional overwrite
    expect(capturedQuery).not.toContain("OR EXCLUDED.notion_last_edited_time IS NULL");

    // Verify 19 parameterized values
    expect(capturedValues.length).toBe(19);
    expect(capturedValues[0]).toBe("test-page-1234");
    expect(capturedValues[1]).toBe("Verify Idempotency");
    expect(capturedValues[2]).toBe("Done");
    expect(capturedValues[4]).toBe(true); // important
    expect(capturedValues[17]).toBe(JSON.stringify({ foo: "bar" })); // raw_properties JSON
    expect(capturedValues[18]).toBe(JSON.stringify([{ type: "paragraph" }])); // page_content_json JSON
  });

  it("passes SQL null for un-fetched page content so COALESCE can preserve stored content (BUG-004)", async () => {
    let capturedValues: any[] = [];

    const mockDb = {
      query: vi.fn().mockImplementation(async (_query: string, values: any[]) => {
        capturedValues = values;
        return { rows: [sampleTask], rowCount: 1 };
      }),
    } as any;

    await TasksRepository.upsertTask(mockDb, { ...sampleTask, page_content_json: null });
    expect(capturedValues[18]).toBeNull();

    await TasksRepository.upsertTask(mockDb, { ...sampleTask, page_content_json: [] });
    expect(capturedValues[18]).toBe("[]");
  });

  it("enqueueEvent detects duplicates idempotently using ON CONFLICT (event_id) DO NOTHING", async () => {
    // 1. First delivery (inserted)
    const mockDbFirst = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ event_id: "evt_123" }] }),
    } as any;

    const res1 = await InboxRepository.enqueueEvent(mockDbFirst, {
      eventId: "evt_123",
      eventType: "page.properties_updated",
      payload: { hello: "world" },
    });
    expect(res1.isDuplicate).toBe(false);

    // 2. Duplicate delivery (rowCount 0)
    const mockDbDup = {
      query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
    } as any;

    const res2 = await InboxRepository.enqueueEvent(mockDbDup, {
      eventId: "evt_123",
      eventType: "page.properties_updated",
      payload: { hello: "world" },
    });
    expect(res2.isDuplicate).toBe(true);
  });

  it("claimNextEvent uses FOR UPDATE SKIP LOCKED and increments attempts on claim", async () => {
    let capturedQuery = "";
    const mockDb = {
      query: vi.fn().mockImplementation(async (query: string) => {
        capturedQuery = query;
        return {
          rows: [
            {
              event_id: "evt_claim_1",
              status: "processing",
              attempts: 1,
            },
          ],
        };
      }),
    } as any;

    const event = await InboxRepository.claimNextEvent(mockDb);
    expect(event).toBeDefined();
    expect(event?.event_id).toBe("evt_claim_1");
    expect(capturedQuery).toContain("FOR UPDATE SKIP LOCKED");
    expect(capturedQuery).toContain("attempts  = i.attempts + 1");
  });

  it("RunsRepository records lifecycle correctly", async () => {
    const mockDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ run_id: "42" }] })
        .mockResolvedValueOnce({ rowCount: 1 }),
    } as any;

    const runId = await RunsRepository.startRun(mockDb, "initial_backfill");
    expect(runId).toBe(42);

    await RunsRepository.finishRun(mockDb, runId, "succeeded", 150);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });
});
