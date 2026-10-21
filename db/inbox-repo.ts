import pg from "pg";

export interface InboxEventInput {
  eventId: string;
  eventType: string;
  entityType?: string | null;
  entityId?: string | null;
  eventTimestamp?: string | null;
  payload: Record<string, unknown>;
}

export interface InboxEventRecord {
  event_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  event_timestamp: Date | null;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "processed" | "failed";
  attempts: number;
  received_at: Date;
  available_at: Date;
  locked_at: Date | null;
  processed_at: Date | null;
  last_error: string | null;
}

export class InboxRepository {
  /**
   * Enqueues an inbound webhook event durably into sync_inbox.
   * Recognizes duplicate deliveries idempotently via ON CONFLICT (event_id) DO NOTHING.
   */
  static async enqueueEvent(
    db: pg.Pool | pg.PoolClient,
    event: InboxEventInput
  ): Promise<{ isDuplicate: boolean; eventId: string }> {
    const query = `
      INSERT INTO notion_sync.sync_inbox (
        event_id, event_type, entity_type, entity_id, event_timestamp, payload, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, 'pending'
      )
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id;
    `;

    const values = [
      event.eventId,
      event.eventType,
      event.entityType ?? null,
      event.entityId ?? null,
      event.eventTimestamp ? new Date(event.eventTimestamp) : null,
      JSON.stringify(event.payload),
    ];

    const result = await db.query(query, values);
    const isDuplicate = (result.rowCount ?? 0) === 0;

    return {
      isDuplicate,
      eventId: event.eventId,
    };
  }

  /**
   * Claims exactly one pending event safely under concurrent execution using FOR UPDATE SKIP LOCKED.
   * Increments attempts on claim.
   */
  static async claimNextEvent(
    db: pg.Pool | pg.PoolClient
  ): Promise<InboxEventRecord | null> {
    const query = `
      WITH claimed AS (
        SELECT event_id
          FROM notion_sync.sync_inbox
         WHERE status = 'pending'
           AND available_at <= NOW()
         ORDER BY available_at ASC, received_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE notion_sync.sync_inbox i
         SET status    = 'processing',
             locked_at = NOW(),
             attempts  = i.attempts + 1
        FROM claimed c
       WHERE i.event_id = c.event_id
      RETURNING i.*;
    `;

    const res = await db.query<InboxEventRecord>(query);
    return res.rows[0] ?? null;
  }

  /**
   * Settles an event as processed (success) within a transaction.
   */
  static async settleEventSuccess(
    client: pg.PoolClient,
    eventId: string
  ): Promise<void> {
    await client.query(
      `UPDATE notion_sync.sync_inbox
          SET status = 'processed',
              processed_at = NOW(),
              locked_at = NULL,
              last_error = NULL
        WHERE event_id = $1`,
      [eventId]
    );
  }

  /**
   * Settles an event as retryable pending with next available_at time and sanitized last_error.
   */
  static async settleEventRetryable(
    db: pg.Pool | pg.PoolClient,
    eventId: string,
    availableAt: Date,
    lastError: string
  ): Promise<void> {
    await db.query(
      `UPDATE notion_sync.sync_inbox
          SET status = 'pending',
              available_at = $2,
              last_error = $3,
              locked_at = NULL
        WHERE event_id = $1`,
      [eventId, availableAt, lastError]
    );
  }

  /**
   * Settles an event as permanently failed.
   */
  static async settleEventFailed(
    db: pg.Pool | pg.PoolClient,
    eventId: string,
    lastError: string
  ): Promise<void> {
    await db.query(
      `UPDATE notion_sync.sync_inbox
          SET status = 'failed',
              last_error = $2,
              locked_at = NULL
        WHERE event_id = $1`,
      [eventId, lastError]
    );
  }

  /**
   * Resets expired processing leases back to pending.
   */
  static async recoverStuckEvents(
    db: pg.Pool | pg.PoolClient,
    leaseSeconds = 300
  ): Promise<number> {
    const res = await db.query(
      `UPDATE notion_sync.sync_inbox
          SET status = 'pending',
              locked_at = NULL,
              available_at = NOW()
        WHERE status = 'processing'
          AND locked_at < NOW() - ($1 || ' seconds')::interval`,
      [leaseSeconds]
    );
    return res.rowCount ?? 0;
  }

  /**
   * Operator requeue: failed -> pending, attempts reset to 0.
   */
  static async retryFailedEvents(
    db: pg.Pool | pg.PoolClient,
    limit = 100
  ): Promise<number> {
    const res = await db.query(
      `UPDATE notion_sync.sync_inbox
          SET status = 'pending',
              attempts = 0,
              available_at = NOW()
        WHERE event_id IN (
          SELECT event_id FROM notion_sync.sync_inbox
           WHERE status = 'failed'
           LIMIT $1
        )`,
      [limit]
    );
    return res.rowCount ?? 0;
  }
}
