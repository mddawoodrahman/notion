import pg from "pg";
import { getConfig } from "../src/config.js";
import { DatabaseError } from "../src/errors.js";

const { Pool } = pg;

let defaultPool: pg.Pool | null = null;

export function getPool(connectionString?: string): pg.Pool {
  if (connectionString) {
    return createPool(connectionString);
  }

  if (!defaultPool) {
    const config = getConfig();
    defaultPool = createPool(config.DATABASE_URL);
  }

  return defaultPool;
}

export function resolveSslConfig(
  connectionString: string,
  allowInsecure: boolean = process.env.DB_SSL_INSECURE === "true"
): true | { rejectUnauthorized: false } | undefined {
  const isSsl = connectionString.includes("sslmode=require") ||
    (!connectionString.includes("localhost") && !connectionString.includes("127.0.0.1"));

  if (!isSsl) {
    return undefined;
  }

  // SEC-002: verify TLS certificates by default. DB_SSL_INSECURE=true is an explicit
  // opt-out for local/self-signed development databases only.
  return allowInsecure ? { rejectUnauthorized: false } : true;
}

export function createPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    ssl: resolveSslConfig(connectionString),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

export async function closePool(pool?: pg.Pool): Promise<void> {
  if (pool) {
    await pool.end();
  } else if (defaultPool) {
    await defaultPool.end();
    defaultPool = null;
  }
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failure if already closed
    }
    const pgErr = err as { code?: string; message?: string };
    throw new DatabaseError(`Transaction failed: ${pgErr.message ?? String(err)}`, {
      pgCode: pgErr.code,
      cause: err,
    });
  } finally {
    client.release();
  }
}
