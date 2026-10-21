import type { Pool, PoolClient } from 'pg';

/**
 * Run `work` inside a single transaction. Any throw rolls back every write, so
 * a task upsert and its inbox settlement can never be half-applied (INV-6).
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original failure is the useful one; a rollback failure means the
      // connection is unusable and the pool will discard it.
    }
    throw error;
  } finally {
    client.release();
  }
}
