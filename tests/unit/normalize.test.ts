import { describe, it, expect } from "vitest";
import { normalizePage } from "../../sync/normalize.js";

describe("Property Normalization (Pure, I/O-Free)", () => {
  it("normalizes a complete Notion task with all typed properties", () => {
    const mockPage = {
      id: "9e5c468a-6bb2-4a0b-8d69-cb1477123456",
      created_time: "2026-10-21T10:00:00.000Z",
      last_edited_time: "2026-10-21T11:30:00.000Z",
      url: "https://www.notion.so/Test-Task-9e5c468a6bb24a0b8d69cb1477123456",
      archived: false,
      in_trash: false,
      parent: {
        type: "data_source_id",
        data_source_id: "ds_tasks_12345678",
      },
      properties: {
        Task: {
          type: "title",
          title: [{ plain_text: "Deploy Notion " }, { plain_text: "Sync Service" }],
        },
        Status: {
          type: "status",
          status: { name: "In Progress" },
        },
        List: {
          type: "select",
          select: { name: "Work" },
        },
        Important: {
          type: "checkbox",
          checkbox: true,
        },
        "In My Day": {
          type: "checkbox",
          checkbox: true,
        },
        Priority: {
          type: "select",
          select: { name: "High" },
        },
        "Due Date": {
          type: "date",
          date: { start: "2026-10-25" },
        },
        Reminder: {
          type: "date",
          date: { start: "2026-10-25T09:00:00.000Z" },
        },
        Archived: {
          type: "checkbox",
          checkbox: false,
        },
        "Custom Unknown Prop": {
          type: "rollup",
          rollup: { number: 42 },
        },
      },
    };

    const record = normalizePage(mockPage, {
      configuredDataSourceId: "ds_tasks_12345678",
    });

    expect(record.notion_page_id).toBe("9e5c468a-6bb2-4a0b-8d69-cb1477123456");
    expect(record.title).toBe("Deploy Notion Sync Service");
    expect(record.status).toBe("In Progress");
    expect(record.list_name).toBe("Work");
    expect(record.important).toBe(true);
    expect(record.in_my_day).toBe(true);
    expect(record.priority).toBe("High");
    expect(record.due_date).toBe("2026-10-25");
    expect(record.due_at).toBeNull();
    expect(record.reminder_at).toBe("2026-10-25T09:00:00.000Z");
    expect(record.user_archived).toBe(false);
    expect(record.notion_is_archived).toBe(false);
    expect(record.notion_in_trash).toBe(false);
    expect(record.is_in_source).toBe(true);
    expect(record.raw_properties).toHaveProperty("Custom Unknown Prop");
  });

  it("distinguishes date-only from timed due dates", () => {
    // 1. Date-only
    const dateOnlyPage = {
      id: "task-date-only",
      properties: {
        Task: { type: "title", title: [{ plain_text: "Date only task" }] },
        "Due Date": { type: "date", date: { start: "2026-11-01" } },
      },
    };
    const dateOnlyRec = normalizePage(dateOnlyPage);
    expect(dateOnlyRec.due_date).toBe("2026-11-01");
    expect(dateOnlyRec.due_at).toBeNull();

    // 2. Timed instant
    const timedPage = {
      id: "task-timed",
      properties: {
        Task: { type: "title", title: [{ plain_text: "Timed task" }] },
        "Due Date": { type: "date", date: { start: "2026-11-01T15:30:00.000Z" } },
      },
    };
    const timedRec = normalizePage(timedPage);
    expect(timedRec.due_date).toBe("2026-11-01");
    expect(timedRec.due_at).toBe("2026-11-01T15:30:00.000Z");
  });

  it("handles missing, null, or empty properties gracefully", () => {
    const emptyPage = {
      id: "task-empty",
      properties: {
        Task: { type: "title", title: [] },
        Status: { type: "status", status: null },
        List: { type: "select", select: null },
        Important: { type: "checkbox", checkbox: false },
        "Due Date": { type: "date", date: null },
      },
    };

    const record = normalizePage(emptyPage);
    expect(record.title).toBe("");
    expect(record.status).toBeNull();
    expect(record.list_name).toBeNull();
    expect(record.important).toBe(false);
    expect(record.in_my_day).toBe(false);
    expect(record.due_date).toBeNull();
    expect(record.due_at).toBeNull();
  });

  it("distinguishes custom task 'Archived' checkbox from Notion page archival and trash", () => {
    const archivedTaskPage = {
      id: "task-archived",
      archived: true,
      in_trash: false,
      properties: {
        Task: { type: "title", title: [{ plain_text: "Archived Task" }] },
        Archived: { type: "checkbox", checkbox: false },
      },
    };

    const rec1 = normalizePage(archivedTaskPage);
    expect(rec1.notion_is_archived).toBe(true);
    expect(rec1.user_archived).toBe(false);
    expect(rec1.notion_in_trash).toBe(false);

    const userArchivedPage = {
      id: "task-user-archived",
      archived: false,
      in_trash: false,
      properties: {
        Task: { type: "title", title: [{ plain_text: "User Archived Task" }] },
        Archived: { type: "checkbox", checkbox: true },
      },
    };

    const rec2 = normalizePage(userArchivedPage);
    expect(rec2.notion_is_archived).toBe(false);
    expect(rec2.user_archived).toBe(true);
    expect(rec2.notion_in_trash).toBe(false);
  });

  it("marks is_in_source = false when page moves outside configured data source", () => {
    const movedPage = {
      id: "task-moved",
      parent: {
        type: "data_source_id",
        data_source_id: "other_datasource_999",
      },
      properties: {
        Task: { type: "title", title: [{ plain_text: "Moved task" }] },
      },
    };

    const record = normalizePage(movedPage, {
      configuredDataSourceId: "expected_datasource_111",
    });

    expect(record.is_in_source).toBe(false);
  });
});
