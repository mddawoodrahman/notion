import pg from "pg";
import { NormalizedTaskRecord } from "../sync/normalize.js";

export class TasksRepository {
  /**
   * Upserts a normalized task record. Keyed by notion_page_id.
   * Uses INV-4 guard: an older snapshot never overwrites a newer last_edited_time.
   */
  static async upsertTask(
    db: pg.Pool | pg.PoolClient,
    task: NormalizedTaskRecord
  ): Promise<any> {
    const query = `
      INSERT INTO notion_sync.notion_tasks (
        notion_page_id, title, status, list_name, important, in_my_day, priority,
        due_date, due_at, reminder_at, user_archived, notion_is_archived,
        notion_in_trash, is_in_source, page_url, notion_created_time,
        notion_last_edited_time, raw_properties, page_content_json, synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18::jsonb, $19::jsonb, NOW()
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
        page_content_json       = EXCLUDED.page_content_json,
        synced_at               = NOW()
      WHERE notion_sync.notion_tasks.notion_last_edited_time IS NULL
         OR EXCLUDED.notion_last_edited_time IS NULL
         OR EXCLUDED.notion_last_edited_time >= notion_sync.notion_tasks.notion_last_edited_time
      RETURNING *;
    `;

    const values = [
      task.notion_page_id,
      task.title,
      task.status,
      task.list_name,
      task.important,
      task.in_my_day,
      task.priority,
      task.due_date,
      task.due_at,
      task.reminder_at,
      task.user_archived,
      task.notion_is_archived,
      task.notion_in_trash,
      task.is_in_source,
      task.page_url,
      task.notion_created_time,
      task.notion_last_edited_time,
      JSON.stringify(task.raw_properties ?? {}),
      JSON.stringify(task.page_content_json ?? []),
    ];

    const result = await db.query(query, values);
    return result.rows[0] ?? null;
  }

  /**
   * Retrieves a task by Notion Page ID.
   */
  static async getTaskById(db: pg.Pool | pg.PoolClient, pageId: string): Promise<any | null> {
    const res = await db.query(
      "SELECT * FROM notion_sync.notion_tasks WHERE notion_page_id = $1",
      [pageId]
    );
    return res.rows[0] ?? null;
  }

  /**
   * Tombstones a task as in_trash (on page.deleted event) without physically deleting it.
   */
  static async markTaskInTrash(db: pg.Pool | pg.PoolClient, pageId: string): Promise<boolean> {
    const res = await db.query(
      `UPDATE notion_sync.notion_tasks 
          SET notion_in_trash = TRUE, synced_at = NOW() 
        WHERE notion_page_id = $1`,
      [pageId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Lists all task IDs that are currently considered in scope and active.
   */
  static async listInScopeTaskIds(db: pg.Pool | pg.PoolClient): Promise<string[]> {
    const res = await db.query<{ notion_page_id: string }>(
      "SELECT notion_page_id FROM notion_sync.notion_tasks WHERE is_in_source = TRUE AND notion_in_trash = FALSE"
    );
    return res.rows.map((r) => r.notion_page_id);
  }

  /**
   * Flags tasks as out-of-source when a full reconciliation scan proves they no longer exist in the source.
   */
  static async markTasksOutOfSource(db: pg.Pool | pg.PoolClient, activePageIds: string[]): Promise<number> {
    if (activePageIds.length === 0) {
      return 0;
    }

    const res = await db.query(
      `UPDATE notion_sync.notion_tasks 
          SET is_in_source = FALSE, synced_at = NOW() 
        WHERE is_in_source = TRUE AND NOT (notion_page_id = ANY($1))`,
      [activePageIds]
    );

    return res.rowCount ?? 0;
  }
}
