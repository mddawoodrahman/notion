/**
 * Operational run ledger. A run is never deleted or rewritten into a success:
 * interrupted imports stay visible as `partial`/`failed` with the cursor at
 * which they stopped.
 */

import type { Queryable } from './queryable.js';

export type RunType = 'initial_backfill' | 'reconciliation' | 'manual_retry';
export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed';
export type TerminalRunStatus = Exclude<RunStatus, 'running'>;

export interface SyncRun {
  readonly runId: number;
  readonly runType: RunType;
  readonly status: RunStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly recordsProcessed: number;
  readonly errorMessage: string | null;
  readonly cursorReached: string | null;
}

export interface FinishRunOptions {
  readonly status: TerminalRunStatus;
  readonly recordsProcessed?: number;
  readonly errorMessage?: string | null;
  readonly cursorReached?: string | null;
}

interface RunDbRow {
  run_id: string;
  run_type: RunType;
  status: RunStatus;
  started_at: Date;
  finished_at: Date | null;
  records_processed: number;
  error_message: string | null;
  cursor_reached: string | null;
}

export async function startRun(db: Queryable, runType: RunType): Promise<SyncRun> {
  const result = await db.query<RunDbRow>(
    `INSERT INTO notion_sync.sync_runs (run_type, status)
     VALUES ($1, 'running')
     RETURNING *`,
    [runType],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('sync_runs insert returned no row');
  }
  return mapRunRow(row);
}

export async function finishRun(
  db: Queryable,
  runId: number,
  options: FinishRunOptions,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE notion_sync.sync_runs
        SET status = $2,
            finished_at = NOW(),
            records_processed = $3,
            error_message = $4,
            cursor_reached = $5
      WHERE run_id = $1`,
    [
      runId,
      options.status,
      options.recordsProcessed ?? 0,
      options.errorMessage ?? null,
      options.cursorReached ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getRun(db: Queryable, runId: number): Promise<SyncRun | null> {
  const result = await db.query<RunDbRow>(
    'SELECT * FROM notion_sync.sync_runs WHERE run_id = $1',
    [runId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRunRow(row);
}

export async function getLatestRun(db: Queryable, runType: RunType): Promise<SyncRun | null> {
  const result = await db.query<RunDbRow>(
    `SELECT * FROM notion_sync.sync_runs
      WHERE run_type = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [runType],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRunRow(row);
}

function mapRunRow(row: RunDbRow): SyncRun {
  return {
    runId: Number(row.run_id),
    runType: row.run_type,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    recordsProcessed: row.records_processed,
    errorMessage: row.error_message,
    cursorReached: row.cursor_reached,
  };
}
