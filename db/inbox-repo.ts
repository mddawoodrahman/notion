/**
 * Durable webhook inbox. Events are stored before acknowledgement, claimed
 * with `FOR UPDATE SKIP LOCKED`, and settled in the same transaction as the
 * task write. Failed events are terminal until an operator requeues them.
 */

import type { Queryable } from './queryable.js';

export type InboxStatus = 'pending' | 'processing' | 'processed' | 'failed';

export interface InboxEventInput {
  readonly eventId: string;
  readonly eventType: string;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly eventTimestamp?: Date | null;
  readonly payload: unknown;
}

export interface InboxEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly eventTimestamp: Date | null;
  readonly payload: unknown;
  readonly status: InboxStatus;
  readonly attempts: number;
  readonly receivedAt: Date;
  readonly availableAt: Date;
  readonly lockedAt: Date | null;
  readonly processedAt: Date | null;
  readonly lastError: string | null;
}

export interface InboxCounts {
  readonly pending: number;
  readonly processing: number;
  readonly processed: number;
  readonly failed: number;
}

export type SettleEventOptions =
  | { readonly eventId: string; readonly outcome: 'processed' }
  | {
      readonly eventId: string;
      readonly outcome: 'retry';
      readonly availableAt: Date;
      readonly lastError?: string;
    }
  | {
      readonly eventId: string;
      readonly outcome: 'failed';
      readonly lastError: string;
    };

interface InboxDbRow {
  event_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  event_timestamp: Date | null;
  payload: unknown;
  status: InboxStatus;
  attempts: number;
  received_at: Date;
  available_at: Date;
  locked_at: Date | null;
  processed_at: Date | null;
  last_error: string | null;
}

/** Store one event. Returns false when the `event_id` was already present. */
export async function enqueueEvent(db: Queryable, event: InboxEventInput): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO notion_sync.sync_inbox
         (event_id, event_type, entity_type, entity_id, event_timestamp, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      event.eventId,
      event.eventType,
      event.entityType ?? null,
      event.entityId ?? null,
      event.eventTimestamp ?? null,
      JSON.stringify(event.payload),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Claim exactly one due event; safe under N concurrent workers (INV-1). */
export async function claimNextEvent(db: Queryable): Promise<InboxEvent | null> {
  const result = await db.query<InboxDbRow>(`
    WITH claimed AS (
        SELECT event_id
          FROM notion_sync.sync_inbox
         WHERE status = 'pending'
           AND available_at <= NOW()
         ORDER BY available_at, received_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
    )
    UPDATE notion_sync.sync_inbox i
       SET status    = 'processing',
           locked_at = NOW(),
           attempts  = i.attempts + 1
      FROM claimed c
     WHERE i.event_id = c.event_id
    RETURNING i.*
  `);
  const row = result.rows[0];
  return row === undefined ? null : mapInboxRow(row);
}

/**
 * Settle a claimed event. The `status = 'processing'` guard means a stale or
 * duplicate worker cannot overwrite a terminal state.
 */
export async function settleEvent(db: Queryable, options: SettleEventOptions): Promise<boolean> {
  let result;
  switch (options.outcome) {
    case 'processed':
      result = await db.query(
        `UPDATE notion_sync.sync_inbox
            SET status = 'processed', processed_at = NOW(), locked_at = NULL, last_error = NULL
          WHERE event_id = $1 AND status = 'processing'`,
        [options.eventId],
      );
      break;
    case 'retry':
      result = await db.query(
        `UPDATE notion_sync.sync_inbox
            SET status = 'pending', locked_at = NULL, available_at = $2, last_error = $3
          WHERE event_id = $1 AND status = 'processing'`,
        [options.eventId, options.availableAt, options.lastError ?? null],
      );
      break;
    case 'failed':
      result = await db.query(
        `UPDATE notion_sync.sync_inbox
            SET status = 'failed', locked_at = NULL, last_error = $2
          WHERE event_id = $1 AND status = 'processing'`,
        [options.eventId, options.lastError],
      );
      break;
  }
  return (result.rowCount ?? 0) > 0;
}

/** Return leases older than `leaseSeconds` to the pending queue. */
export async function recoverStuckEvents(db: Queryable, leaseSeconds: number): Promise<number> {
  const result = await db.query(
    `UPDATE notion_sync.sync_inbox
        SET status = 'pending', locked_at = NULL, available_at = NOW()
      WHERE status = 'processing'
        AND locked_at < NOW() - make_interval(secs => $1)`,
    [leaseSeconds],
  );
  return result.rowCount ?? 0;
}

/** Operator-only requeue of terminal failures. `last_error` is preserved. */
export async function requeueFailedEvents(db: Queryable): Promise<number> {
  const result = await db.query(
    `UPDATE notion_sync.sync_inbox
        SET status = 'pending', attempts = 0, available_at = NOW(), locked_at = NULL
      WHERE status = 'failed'`,
  );
  return result.rowCount ?? 0;
}

export async function getInboxEvent(db: Queryable, eventId: string): Promise<InboxEvent | null> {
  const result = await db.query<InboxDbRow>(
    'SELECT * FROM notion_sync.sync_inbox WHERE event_id = $1',
    [eventId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapInboxRow(row);
}

export async function countInboxByStatus(db: Queryable): Promise<InboxCounts> {
  const result = await db.query<{ status: InboxStatus; count: string }>(
    `SELECT status, COUNT(*)::text AS count
       FROM notion_sync.sync_inbox
      GROUP BY status`,
  );

  const counts: Record<InboxStatus, number> = {
    pending: 0,
    processing: 0,
    processed: 0,
    failed: 0,
  };
  for (const row of result.rows) {
    counts[row.status] = Number(row.count);
  }
  return counts;
}

function mapInboxRow(row: InboxDbRow): InboxEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    eventTimestamp: row.event_timestamp,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    receivedAt: row.received_at,
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    processedAt: row.processed_at,
    lastError: row.last_error,
  };
}
