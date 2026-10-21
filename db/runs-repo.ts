import pg from "pg";

export type RunType = "initial_backfill" | "reconciliation" | "manual_retry";
export type RunStatus = "running" | "succeeded" | "partial" | "failed";

export interface SyncRunRecord {
  run_id: number;
  run_type: RunType;
  status: RunStatus;
  started_at: Date;
  finished_at: Date | null;
  records_processed: number;
  error_message: string | null;
  cursor_reached: string | null;
}

export class RunsRepository {
  /**
   * Starts a new operational sync run.
   */
  static async startRun(
    db: pg.Pool | pg.PoolClient,
    runType: RunType
  ): Promise<number> {
    const res = await db.query<{ run_id: string }>(
      `INSERT INTO notion_sync.sync_runs (run_type, status, started_at)
       VALUES ($1, 'running', NOW())
       RETURNING run_id`,
      [runType]
    );

    return Number(res.rows[0]?.run_id);
  }

  /**
   * Records the finish status and metrics of a sync run.
   */
  static async finishRun(
    db: pg.Pool | pg.PoolClient,
    runId: number,
    status: RunStatus,
    recordsProcessed: number,
    errorMessage?: string | null,
    cursorReached?: string | null
  ): Promise<void> {
    await db.query(
      `UPDATE notion_sync.sync_runs
          SET status = $2,
              finished_at = NOW(),
              records_processed = $3,
              error_message = $4,
              cursor_reached = $5
        WHERE run_id = $1`,
      [runId, status, recordsProcessed, errorMessage ?? null, cursorReached ?? null]
    );
  }

  /**
   * Retrieves the most recent run for a specific run type.
   */
  static async getLatestRun(
    db: pg.Pool | pg.PoolClient,
    runType?: RunType
  ): Promise<SyncRunRecord | null> {
    const query = runType
      ? "SELECT * FROM notion_sync.sync_runs WHERE run_type = $1 ORDER BY started_at DESC LIMIT 1"
      : "SELECT * FROM notion_sync.sync_runs ORDER BY started_at DESC LIMIT 1";
    const values = runType ? [runType] : [];

    const res = await db.query<SyncRunRecord>(query, values);
    return res.rows[0] ?? null;
  }
}
