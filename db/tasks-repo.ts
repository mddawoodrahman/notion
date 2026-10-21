/**
 * Task persistence. One current-state row per Notion page, keyed by the page ID.
 * Writes are idempotent upserts guarded by source `last_edited_time` (INV-4),
 * and removal is expressed as flags, never as a hard delete (INV-5).
 */

import type { NormalizedTask } from '../src/task-model.js';
import type { Queryable } from './queryable.js';

export interface TaskRow {
  readonly notionPageId: string;
  readonly title: string;
  readonly status: string | null;
  readonly listName: string | null;
  readonly important: boolean;
  readonly inMyDay: boolean;
  readonly priority: string | null;
  readonly dueDate: string | null;
  readonly dueAt: Date | null;
  readonly reminderAt: Date | null;
  readonly userArchived: boolean;
  readonly notionIsArchived: boolean;
  readonly notionInTrash: boolean;
  readonly isInSource: boolean;
  readonly pageUrl: string | null;
  readonly notionCreatedTime: Date | null;
  readonly notionLastEditedTime: Date | null;
  readonly rawProperties: Record<string, unknown>;
  readonly pageContentJson: unknown;
  readonly syncedAt: Date;
}

export interface UpsertTaskOptions {
  /** Present only when the caller fetched page content for this write. */
  readonly pageContentJson?: unknown;
  /** Test/ops override; production uses the database clock. */
  readonly syncedAt?: Date;
}

export interface UpsertTaskResult {
  /** False when the write was skipped because the stored row is newer. */
  readonly applied: boolean;
  readonly inserted: boolean;
}

interface TaskDbRow {
  notion_page_id: string;
  title: string;
  status: string | null;
  list_name: string | null;
  important: boolean;
  in_my_day: boolean;
  priority: string | null;
  due_date: string | null;
  due_at: Date | null;
  reminder_at: Date | null;
  user_archived: boolean;
  notion_is_archived: boolean;
  notion_in_trash: boolean;
  is_in_source: boolean;
  page_url: string | null;
  notion_created_time: Date | null;
  notion_last_edited_time: Date | null;
  raw_properties: Record<string, unknown>;
  page_content_json: unknown;
  synced_at: Date;
}

const UPSERT_SQL = `
INSERT INTO notion_sync.notion_tasks (
    notion_page_id, title, status, list_name, important, in_my_day, priority,
    due_date, due_at, reminder_at, user_archived, notion_is_archived,
    notion_in_trash, is_in_source, page_url, notion_created_time,
    notion_last_edited_time, raw_properties, page_content_json, synced_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7,
    $8, $9, $10, $11, $12,
    $13, $14, $15, $16,
    $17, $18::jsonb, $19::jsonb, COALESCE($20::timestamptz, NOW())
)
ON CONFLICT (notion_page_id) DO UPDATE SET
    title                   = EXCLUDED.title,
    status                  = EXCLUDED.status,
    list_name               = EXCLUDED.list_name,
    important               = EXCLUDED.important,
    in_my_day               = EXCLUDED.in_my_day,
    priority                = EXCLUDED.priority,
    due_date                = EXCLUDED.due_date,
    due_at                  = EXCLUDED.due_at,
    reminder_at             = EXCLUDED.reminder_at,
    user_archived           = EXCLUDED.user_archived,
    notion_is_archived      = EXCLUDED.notion_is_archived,
    notion_in_trash         = EXCLUDED.notion_in_trash,
    is_in_source            = EXCLUDED.is_in_source,
    page_url                = EXCLUDED.page_url,
    notion_created_time     = EXCLUDED.notion_created_time,
    notion_last_edited_time = EXCLUDED.notion_last_edited_time,
    raw_properties          = EXCLUDED.raw_properties,
    page_content_json       = CASE
        WHEN $21::boolean THEN EXCLUDED.page_content_json
        ELSE notion_sync.notion_tasks.page_content_json
    END,
    synced_at               = COALESCE($20::timestamptz, NOW())
WHERE notion_sync.notion_tasks.notion_last_edited_time IS NULL
   OR EXCLUDED.notion_last_edited_time IS NULL
   OR EXCLUDED.notion_last_edited_time >= notion_sync.notion_tasks.notion_last_edited_time
RETURNING (xmax = 0) AS inserted
`;

/**
 * Insert or update one task. A stale write returns `applied: false` rather
 * than an error: the newer state is already stored, which is success.
 */
export async function upsertTask(
  db: Queryable,
  task: NormalizedTask,
  options: UpsertTaskOptions = {},
): Promise<UpsertTaskResult> {
  const contentProvided = Object.prototype.hasOwnProperty.call(options, 'pageContentJson');
  const content = contentProvided ? options.pageContentJson : [];

  const result = await db.query<{ inserted: boolean }>(UPSERT_SQL, [
    task.notionPageId,
    task.title,
    task.status,
    task.listName,
    task.important,
    task.inMyDay,
    task.priority,
    task.dueDate,
    task.dueAt,
    task.reminderAt,
    task.userArchived,
    task.notionIsArchived,
    task.notionInTrash,
    task.isInSource,
    task.pageUrl,
    task.notionCreatedTime,
    task.notionLastEditedTime,
    JSON.stringify(task.rawProperties),
    JSON.stringify(content ?? []),
    options.syncedAt ?? null,
    contentProvided,
  ]);

  if (result.rowCount === 0) {
    return { applied: false, inserted: false };
  }
  return { applied: true, inserted: result.rows[0]?.inserted === true };
}

/** Tombstone a deleted page. The row is kept so a restore is possible. */
export async function markPageTrashed(db: Queryable, pageId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE notion_sync.notion_tasks
        SET notion_in_trash = TRUE, synced_at = NOW()
      WHERE notion_page_id = $1`,
    [pageId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Mark rows missing from a *completed* source scan as out of scope. Callers
 * must never invoke this after a partial or failed scan (INV-5).
 */
export async function markPagesOutOfScope(
  db: Queryable,
  keepPageIds: readonly string[],
): Promise<number> {
  const result = await db.query(
    `UPDATE notion_sync.notion_tasks
        SET is_in_source = FALSE, synced_at = NOW()
      WHERE is_in_source = TRUE
        AND NOT (notion_page_id = ANY($1::text[]))`,
    [keepPageIds],
  );
  return result.rowCount ?? 0;
}

export async function getTask(db: Queryable, pageId: string): Promise<TaskRow | null> {
  const result = await db.query<TaskDbRow>(
    'SELECT * FROM notion_sync.notion_tasks WHERE notion_page_id = $1',
    [pageId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapTaskRow(row);
}

export async function countTasks(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM notion_sync.notion_tasks',
  );
  return Number(result.rows[0]?.count ?? '0');
}

export async function listTaskPageIds(db: Queryable): Promise<string[]> {
  const result = await db.query<{ notion_page_id: string }>(
    'SELECT notion_page_id FROM notion_sync.notion_tasks ORDER BY notion_page_id',
  );
  return result.rows.map((row) => row.notion_page_id);
}

function mapTaskRow(row: TaskDbRow): TaskRow {
  return {
    notionPageId: row.notion_page_id,
    title: row.title,
    status: row.status,
    listName: row.list_name,
    important: row.important,
    inMyDay: row.in_my_day,
    priority: row.priority,
    dueDate: row.due_date,
    dueAt: row.due_at,
    reminderAt: row.reminder_at,
    userArchived: row.user_archived,
    notionIsArchived: row.notion_is_archived,
    notionInTrash: row.notion_in_trash,
    isInSource: row.is_in_source,
    pageUrl: row.page_url,
    notionCreatedTime: row.notion_created_time,
    notionLastEditedTime: row.notion_last_edited_time,
    rawProperties: row.raw_properties,
    pageContentJson: row.page_content_json,
    syncedAt: row.synced_at,
  };
}
