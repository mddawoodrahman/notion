import { findProperty, PropertyNameMapping, DEFAULT_PROPERTY_MAP } from "./property-map.js";

export interface NormalizedTaskRecord {
  notion_page_id: string;
  title: string;
  status: string | null;
  list_name: string | null;
  important: boolean;
  in_my_day: boolean;
  priority: string | null;
  due_date: string | null;
  due_at: string | null;
  reminder_at: string | null;
  user_archived: boolean;
  notion_is_archived: boolean;
  notion_in_trash: boolean;
  is_in_source: boolean;
  page_url: string | null;
  notion_created_time: string | null;
  notion_last_edited_time: string | null;
  raw_properties: Record<string, unknown>;
  /**
   * Fetched block children, or `null` when body content was not fetched at all
   * (BUG-004: `null` means "preserve existing stored content", `[]` means "genuinely empty").
   */
  page_content_json: unknown[] | null;
  synced_at: string;
}

export interface NormalizeOptions {
  configuredDataSourceId?: string;
  configuredDatabaseId?: string;
  timezone?: string;
  propertyMap?: PropertyNameMapping;
  bodyBlocks?: unknown[];
}

const DEFAULT_TIMEZONE = "Asia/Kolkata";
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Formats an instant as `YYYY-MM-DD` in the given IANA time zone.
 * The `en-CA` locale renders ISO-style dates, so no manual padding is needed.
 */
function formatDateInTimeZone(date: Date, timeZone: string): string {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter.format(date);
}

/**
 * Pure function that maps an official Notion Page Object into a NormalizedTaskRecord.
 * Never throws on unexpected/missing property shapes; preserves unknown data in raw_properties.
 */
export function normalizePage(page: any, options: NormalizeOptions = {}): NormalizedTaskRecord {
  const properties = (page && typeof page.properties === "object" && page.properties !== null)
    ? page.properties
    : {};

  const propMap = { ...DEFAULT_PROPERTY_MAP, ...(options.propertyMap ?? {}) };

  // 1. Title
  let title = "";
  const titleProp = findProperty(properties, propMap.title, ["Title", "Name", "Task Name"]) ||
    Object.values(properties).find((p: any) => p && p.type === "title");

  if (titleProp) {
    const val = (titleProp as any).value ?? titleProp;
    if (val.type === "title" && Array.isArray(val.title)) {
      title = val.title.map((t: any) => t.plain_text ?? "").join("").trim();
    }
  }

  // 2. Status
  let status: string | null = null;
  const statusProp = findProperty(properties, propMap.status, ["State", "Status"]) ||
    Object.values(properties).find((p: any) => p && (p.type === "status" || p.type === "select"));

  if (statusProp) {
    const val = (statusProp as any).value ?? statusProp;
    if (val.type === "status" && val.status) {
      status = val.status.name ?? null;
    } else if (val.type === "select" && val.select) {
      status = val.select.name ?? null;
    }
  }

  // 3. List
  let listName: string | null = null;
  const listProp = findProperty(properties, propMap.list, ["Category", "Lists"]);
  if (listProp) {
    const val = (listProp as any).value ?? listProp;
    if (val.type === "select" && val.select) {
      listName = val.select.name ?? null;
    }
  }

  // 4. Important
  let important = false;
  const importantProp = findProperty(properties, propMap.important, ["Star", "Starred", "Importance"]);
  if (importantProp) {
    const val = (importantProp as any).value ?? importantProp;
    if (val.type === "checkbox") {
      important = Boolean(val.checkbox);
    }
  }

  // 5. In My Day
  let inMyDay = false;
  const inMyDayProp = findProperty(properties, propMap.inMyDay, ["My Day", "MyDay"]);
  if (inMyDayProp) {
    const val = (inMyDayProp as any).value ?? inMyDayProp;
    if (val.type === "checkbox") {
      inMyDay = Boolean(val.checkbox);
    }
  }

  // 6. Priority
  let priority: string | null = null;
  const priorityProp = findProperty(properties, propMap.priority, ["Urgency", "Level"]);
  if (priorityProp) {
    const val = (priorityProp as any).value ?? priorityProp;
    if (val.type === "select" && val.select) {
      priority = val.select.name ?? null;
    } else if (val.type === "status" && val.status) {
      priority = val.status.name ?? null;
    }
  }

  // 7. Due Date & Due At
  let dueDate: string | null = null;
  let dueAt: string | null = null;
  const dueProp = findProperty(properties, propMap.dueDate, ["Due", "Deadline", "Date"]);
  if (dueProp) {
    const val = (dueProp as any).value ?? dueProp;
    if (val.type === "date" && val.date && val.date.start) {
      const rawStart: string = val.date.start;
      if (rawStart.includes("T")) {
        // Timed instant: keep the UTC instant, derive the calendar date in the configured zone (DOC-001)
        const dateObj = new Date(rawStart);
        if (!Number.isNaN(dateObj.getTime())) {
          dueAt = dateObj.toISOString();
          try {
            dueDate = formatDateInTimeZone(dateObj, options.timezone ?? DEFAULT_TIMEZONE);
          } catch {
            // Unknown/invalid time zone: fall back to the literal date portion
            dueDate = rawStart.split("T")[0] ?? null;
          }
        }
      } else {
        // Date-only (YYYY-MM-DD): a calendar date has no time zone, keep it verbatim
        dueDate = rawStart;
        dueAt = null;
      }
    }
  }

  // 8. Reminder
  let reminderAt: string | null = null;
  const reminderProp = findProperty(properties, propMap.reminder, ["Remind", "Reminder Date"]);
  if (reminderProp) {
    const val = (reminderProp as any).value ?? reminderProp;
    if (val.type === "date" && val.date && val.date.start) {
      const dateObj = new Date(val.date.start);
      if (!Number.isNaN(dateObj.getTime())) {
        reminderAt = dateObj.toISOString();
      }
    }
  }

  // 9. User Archived (custom checkbox)
  let userArchived = false;
  const userArchivedProp = findProperty(properties, propMap.userArchived, ["User Archived", "Archived Task"]);
  if (userArchivedProp) {
    const val = (userArchivedProp as any).value ?? userArchivedProp;
    if (val.type === "checkbox") {
      userArchived = Boolean(val.checkbox);
    }
  }

  // 10. Notion Page Archival & Trash
  const notionIsArchived = Boolean(page.archived);
  const notionInTrash = Boolean(page.in_trash);

  // 11. Source Membership
  let isInSource = true;
  if (page.parent) {
    const parentId = page.parent.data_source_id || page.parent.database_id;
    if (parentId) {
      const cleanParentId = String(parentId).replace(/-/g, "").toLowerCase();
      const cleanTargetSource = options.configuredDataSourceId ? options.configuredDataSourceId.replace(/-/g, "").toLowerCase() : null;
      const cleanTargetDb = options.configuredDatabaseId ? options.configuredDatabaseId.replace(/-/g, "").toLowerCase() : null;

      if (cleanTargetSource || cleanTargetDb) {
        isInSource = (cleanTargetSource ? cleanParentId === cleanTargetSource : false) ||
          (cleanTargetDb ? cleanParentId === cleanTargetDb : false);
      }
    }
  }

  return {
    notion_page_id: String(page.id ?? ""),
    title,
    status,
    list_name: listName,
    important,
    in_my_day: inMyDay,
    priority,
    due_date: dueDate,
    due_at: dueAt,
    reminder_at: reminderAt,
    user_archived: userArchived,
    notion_is_archived: notionIsArchived,
    notion_in_trash: notionInTrash,
    is_in_source: isInSource,
    page_url: page.url ? String(page.url) : null,
    notion_created_time: page.created_time ? new Date(page.created_time).toISOString() : null,
    notion_last_edited_time: page.last_edited_time ? new Date(page.last_edited_time).toISOString() : null,
    raw_properties: properties,
    // BUG-004: `null` = "not fetched" (preserve stored content), `[]` = genuinely empty page
    page_content_json: Array.isArray(options.bodyBlocks) ? options.bodyBlocks : null,
    synced_at: new Date().toISOString(),
  };
}
