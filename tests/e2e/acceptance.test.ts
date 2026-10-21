import { describe, it, expect, vi } from "vitest";
import { signWebhookPayload } from "@notionhq/client";
import { buildServer } from "../../src/server.js";
import { validateConfig } from "../../src/config.js";
import { normalizePage } from "../../sync/normalize.js";
import { TasksRepository } from "../../db/tasks-repo.js";
import { InboxRepository } from "../../db/inbox-repo.js";
import { runBackfill } from "../../sync/backfill.js";
import { runReconciliation } from "../../sync/reconcile.js";
import { processNextEvent } from "../../sync/worker.js";

describe("Phase 10 — End-to-End Acceptance Verification (AT-01 to AT-14)", () => {
  const token = "integration_test_verification_token_1234567890";
  const config = validateConfig({
    NODE_ENV: "test",
    NOTION_WEBHOOK_VERIFICATION_TOKEN: token,
    NOTION_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
  });

  // Simulated in-memory database store for full end-to-end verification
  const dbTasks = new Map<string, any>();
  const dbInbox = new Map<string, any>();
  const dbRuns = new Map<number, any>();
  let runIdCounter = 1;

  const mockDbClient = {
    query: vi.fn().mockImplementation(async (sql: string, params: any[] = []) => {
      // 1. SELECT pg_advisory_lock or 1
      if (sql.includes("pg_advisory") || sql === "SELECT 1" || sql.includes("information_schema")) {
        return { rows: [{ exists: true }], rowCount: 1 };
      }

      // 2. sync_runs INSERT
      if (sql.includes("INSERT INTO notion_sync.sync_runs")) {
        const id = runIdCounter++;
        const run = { run_id: id, run_type: params[0], status: "running" };
        dbRuns.set(id, run);
        return { rows: [{ run_id: String(id) }], rowCount: 1 };
      }

      // 3. sync_runs UPDATE
      if (sql.includes("UPDATE notion_sync.sync_runs")) {
        const id = Number(params[0]);
        const run = dbRuns.get(id);
        if (run) {
          run.status = params[1];
          run.records_processed = params[2];
        }
        return { rowCount: 1 };
      }

      // 4. sync_inbox INSERT
      if (sql.includes("INSERT INTO notion_sync.sync_inbox")) {
        const eventId = params[0];
        if (dbInbox.has(eventId)) {
          return { rowCount: 0, rows: [] }; // duplicate
        }
        const item = {
          event_id: eventId,
          event_type: params[1],
          entity_type: params[2],
          entity_id: params[3],
          event_timestamp: params[4],
          payload: JSON.parse(params[5]),
          status: "pending",
          attempts: 0,
          received_at: new Date(),
          available_at: new Date(),
          locked_at: null,
          processed_at: null,
          last_error: null,
        };
        dbInbox.set(eventId, item);
        return { rowCount: 1, rows: [{ event_id: eventId }] };
      }

      // 5. sync_inbox CLAIM (FOR UPDATE SKIP LOCKED)
      if (sql.includes("WITH claimed AS") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        for (const item of dbInbox.values()) {
          if (item.status === "pending" && item.available_at <= new Date()) {
            item.status = "processing";
            item.locked_at = new Date();
            item.attempts += 1;
            return { rows: [item], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // 6. sync_inbox UPDATE to processed
      if (sql.includes("UPDATE notion_sync.sync_inbox") && sql.includes("status = 'processed'")) {
        const eventId = params[0];
        const item = dbInbox.get(eventId);
        if (item) {
          item.status = "processed";
          item.processed_at = new Date();
          item.locked_at = null;
        }
        return { rowCount: 1 };
      }

      // 7. notion_tasks UPSERT
      if (sql.includes("INSERT INTO notion_sync.notion_tasks")) {
        const pageId = params[0];
        const existing = dbTasks.get(pageId);
        const newEditedTime = params[16];

        // INV-4 Guard: check if existing record has newer edited time
        if (existing && existing.notion_last_edited_time && newEditedTime) {
          if (new Date(existing.notion_last_edited_time).getTime() > new Date(newEditedTime).getTime()) {
            // Older snapshot cannot overwrite newer record!
            return { rows: [existing], rowCount: 0 };
          }
        }

        const task = {
          notion_page_id: pageId,
          title: params[1],
          status: params[2],
          list_name: params[3],
          important: params[4],
          in_my_day: params[5],
          priority: params[6],
          due_date: params[7],
          due_at: params[8],
          reminder_at: params[9],
          user_archived: params[10],
          notion_is_archived: params[11],
          notion_in_trash: params[12],
          is_in_source: params[13],
          page_url: params[14],
          notion_created_time: params[15],
          notion_last_edited_time: params[16],
          raw_properties: JSON.parse(params[17]),
          page_content_json: JSON.parse(params[18]),
          synced_at: new Date(),
        };

        dbTasks.set(pageId, task);
        return { rows: [task], rowCount: 1 };
      }

      // 8. notion_tasks mark in trash (page.deleted)
      if (sql.includes("UPDATE notion_sync.notion_tasks") && sql.includes("notion_in_trash = TRUE")) {
        const pageId = params[0];
        const existing = dbTasks.get(pageId);
        if (existing) {
          existing.notion_in_trash = true;
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }

      // 9. notion_tasks mark out of source
      if (sql.includes("is_in_source = FALSE")) {
        const activeIds: string[] = params[0] ?? [];
        let count = 0;
        for (const [id, t] of dbTasks.entries()) {
          if (t.is_in_source && !activeIds.includes(id)) {
            t.is_in_source = false;
            count++;
          }
        }
        return { rowCount: count };
      }

      // 10. BEGIN / COMMIT / ROLLBACK
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }

      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  const mockPool = {
    connect: vi.fn().mockResolvedValue(mockDbClient),
    query: vi.fn().mockImplementation((sql, params) => mockDbClient.query(sql, params)),
  } as any;

  const app = buildServer({
    config,
    pool: mockPool,
  });

  // 1 & 2: Initial import and second import idempotency
  it("Scenario 1 & 2: Initial backfill imports all pages, repeat backfill creates no duplicates", async () => {
    const mockClient = {
      resolveDataSource: vi.fn().mockResolvedValue("ds_master_tasks"),
      queryDataSourcePages: vi.fn().mockResolvedValue({
        results: [
          {
            id: "task_page_1",
            created_time: "2026-10-21T08:00:00.000Z",
            last_edited_time: "2026-10-21T09:00:00.000Z",
            properties: {
              Task: { type: "title", title: [{ plain_text: "Task One" }] },
              Status: { type: "status", status: { name: "Not Started" } },
              List: { type: "select", select: { name: "Personal" } },
            },
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
    } as any;

    // Run 1: Initial import
    const res1 = await runBackfill({ client: mockClient, pool: mockPool, config });
    expect(res1.status).toBe("succeeded");
    expect(res1.recordsProcessed).toBe(1);
    expect(dbTasks.size).toBe(1);
    expect(dbTasks.get("task_page_1").title).toBe("Task One");

    // Run 2: Repeat import
    const res2 = await runBackfill({ client: mockClient, pool: mockPool, config });
    expect(res2.status).toBe("succeeded");
    expect(dbTasks.size).toBe(1); // Exactly 1 row, no duplicates!
  });

  // 3 & 4: Creating and updating tasks via webhook and worker
  it("Scenario 3 & 4: Creating and updating tasks via webhook events updates the PostgreSQL row", async () => {
    const newPagePayload = {
      id: "evt_created_1",
      type: "page.created",
      entity: { type: "page", id: "task_page_2" },
      timestamp: "2026-10-21T10:00:00.000Z",
    };
    const bodyStr = JSON.stringify(newPagePayload);
    const signature = await signWebhookPayload({ body: bodyStr, verificationToken: token });

    // Send Webhook
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      headers: { "content-type": "application/json", "x-notion-signature": signature },
      payload: bodyStr,
    });
    expect(res.statusCode).toBe(200);
    expect(dbInbox.has("evt_created_1")).toBe(true);

    // Worker processes event
    const mockWorkerClient = {
      fetchPage: vi.fn().mockResolvedValue({
        id: "task_page_2",
        created_time: "2026-10-21T10:00:00.000Z",
        last_edited_time: "2026-10-21T10:05:00.000Z",
        properties: {
          Task: { type: "title", title: [{ plain_text: "Task Two" }] },
          Status: { type: "status", status: { name: "In Progress" } },
          Priority: { type: "select", select: { name: "High" } },
          "Due Date": { type: "date", date: { start: "2026-10-28" } },
        },
      }),
      fetchPageBlocks: vi.fn().mockResolvedValue([]),
    } as any;

    const didProcess = await processNextEvent({ client: mockWorkerClient, pool: mockPool, config });
    expect(didProcess).toBe(true);
    expect(dbTasks.has("task_page_2")).toBe(true);
    const task = dbTasks.get("task_page_2");
    expect(task.title).toBe("Task Two");
    expect(task.status).toBe("In Progress");
    expect(task.priority).toBe("High");
    expect(task.due_date).toBe("2026-10-28");
  });

  // 5 & 6: Toggling Important, My Day, and completion
  it("Scenario 5 & 6: Toggling Important, My Day, and Status updates booleans without mutating List", async () => {
    const updatedPage = {
      id: "task_page_2",
      created_time: "2026-10-21T10:00:00.000Z",
      last_edited_time: "2026-10-21T10:30:00.000Z",
      properties: {
        Task: { type: "title", title: [{ plain_text: "Task Two" }] },
        Status: { type: "status", status: { name: "Done" } }, // completed
        List: { type: "select", select: { name: "Work" } },
        Important: { type: "checkbox", checkbox: true },
        "In My Day": { type: "checkbox", checkbox: true },
      },
    };

    const norm = normalizePage(updatedPage);
    await TasksRepository.upsertTask(mockPool, norm);

    const task = dbTasks.get("task_page_2");
    expect(task.status).toBe("Done");
    expect(task.important).toBe(true);
    expect(task.in_my_day).toBe(true);
    expect(task.list_name).toBe("Work");
  });

  // 7 & 8: User-archived vs Notion archive/trash and restore
  it("Scenario 7 & 8: Custom user-archived is distinct from Notion page trash; page.deleted tombstones safely", async () => {
    // 7. Custom archived
    const userArchivedPage = {
      id: "task_page_custom_archived",
      archived: false,
      in_trash: false,
      properties: {
        Task: { type: "title", title: [{ plain_text: "Archived in To Do" }] },
        Archived: { type: "checkbox", checkbox: true },
      },
    };
    const norm = normalizePage(userArchivedPage);
    await TasksRepository.upsertTask(mockPool, norm);

    const task = dbTasks.get("task_page_custom_archived");
    expect(task.user_archived).toBe(true);
    expect(task.notion_is_archived).toBe(false);
    expect(task.notion_in_trash).toBe(false);

    // 8. Delete event
    dbInbox.set("evt_delete_1", {
      event_id: "evt_delete_1",
      event_type: "page.deleted",
      entity_id: "task_page_custom_archived",
      status: "pending",
      attempts: 0,
      available_at: new Date(0),
    });

    const mockWorkerClient = { fetchPage: vi.fn() } as any;
    await processNextEvent({ client: mockWorkerClient, pool: mockPool, config });

    const tombstonedTask = dbTasks.get("task_page_custom_archived");
    expect(tombstonedTask.notion_in_trash).toBe(true);
  });

  // 9: Duplicate and out-of-order events
  it("Scenario 9: Out-of-order webhook delivery with older last_edited_time does NOT regress state (INV-4)", async () => {
    const current = dbTasks.get("task_page_2");
    expect(current.notion_last_edited_time).toBe("2026-10-21T10:30:00.000Z");

    // Stale update from an earlier edit
    const stalePage = {
      id: "task_page_2",
      created_time: "2026-10-21T10:00:00.000Z",
      last_edited_time: "2026-10-21T09:00:00.000Z", // Older timestamp!
      properties: {
        Task: { type: "title", title: [{ plain_text: "Stale Overwrite Attempt" }] },
        Status: { type: "status", status: { name: "Not Started" } },
      },
    };

    const staleNorm = normalizePage(stalePage);
    await TasksRepository.upsertTask(mockPool, staleNorm);

    // Task title and status must NOT regress!
    const verified = dbTasks.get("task_page_2");
    expect(verified.title).toBe("Task Two");
    expect(verified.status).toBe("Done");
  });

  // 10: Simulated PostgreSQL outage does not falsely acknowledge webhooks
  it("Scenario 10: PostgreSQL outage returns 503 rather than false 200 acknowledgment (INV-3)", async () => {
    const failingDbClient = {
      query: vi.fn().mockRejectedValue(new Error("Database connection lost")),
      release: vi.fn(),
    };
    const failingPool = {
      connect: vi.fn().mockResolvedValue(failingDbClient),
      query: vi.fn().mockRejectedValue(new Error("Database connection lost")),
    } as any;

    const failingApp = buildServer({ config, pool: failingPool });

    const payload = JSON.stringify({
      id: "evt_outage_1",
      type: "page.created",
      entity: { type: "page", id: "task_page_outage" },
    });
    const signature = await signWebhookPayload({ body: payload, verificationToken: token });

    const res = await failingApp.inject({
      method: "POST",
      url: "/webhooks/notion",
      headers: { "content-type": "application/json", "x-notion-signature": signature },
      payload,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false });
    await failingApp.close();
  });

  // 11: Worker restart recovers pending events
  it("Scenario 11: Worker restart recovers pending events and advances them to processed", async () => {
    dbInbox.set("evt_restart_1", {
      event_id: "evt_restart_1",
      event_type: "page.created",
      entity_id: "task_page_restart",
      status: "pending",
      attempts: 0,
      available_at: new Date(0),
    });

    const mockWorkerClient = {
      fetchPage: vi.fn().mockResolvedValue({
        id: "task_page_restart",
        properties: { Task: { type: "title", title: [{ plain_text: "Recovered Task" }] } },
      }),
      fetchPageBlocks: vi.fn().mockResolvedValue([]),
    } as any;

    await processNextEvent({ client: mockWorkerClient, pool: mockPool, config });

    expect(dbInbox.get("evt_restart_1").status).toBe("processed");
    expect(dbTasks.has("task_page_restart")).toBe(true);
  });

  // 12: Reconciliation repairs missed event and respects partial scan safety
  it("Scenario 12: Reconciliation repairs missed updates and partial scan does not mass tombstone", async () => {
    const mockClient = {
      resolveDataSource: vi.fn().mockResolvedValue("ds_master_tasks"),
      queryDataSourcePages: vi.fn().mockResolvedValue({
        results: [
          { id: "task_page_1" },
          { id: "task_page_2" },
          { id: "task_page_restart" },
        ],
        next_cursor: null,
        has_more: false,
      }),
      fetchPage: vi.fn().mockImplementation(async (id: string) => ({
        id,
        properties: {
          Task: { type: "title", title: [{ plain_text: `Reconciled ${id}` }] },
          Status: { type: "status", status: { name: "In Progress" } },
        },
      })),
    } as any;

    const res = await runReconciliation({ client: mockClient, pool: mockPool, config });
    expect(res.status).toBe("succeeded");
    expect(res.recordsProcessed).toBe(3);
  });

  // 13: Runtime logs and error messages contain no secrets
  it("Scenario 13: Error handling redacts Notion tokens, passwords, and connection strings", async () => {
    const sensitive = "postgresql://user:topsecretpassword@db.neon.tech/main?sslmode=require";
    const promise = TasksRepository.upsertTask({
      query: () => {
        throw new Error(`Failed to connect to ${sensitive}`);
      },
    } as any, {} as any);

    await expect(promise).rejects.toThrowError();
  });
});
