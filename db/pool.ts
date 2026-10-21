import { Pool, type PoolConfig } from 'pg';

// DATE (OID 1082) is a calendar date. Keep it as `YYYY-MM-DD`; never let a
// timezone turn 2026-10-21 into 2026-10-20.
import { types } from 'pg';

types.setTypeParser(types.builtins.DATE, (value: string) => value);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface PoolOptions {
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly statementTimeoutMillis?: number;
}

/**
 * Build the runtime connection pool. TLS is enabled for every non-local host
 * unless the URL explicitly disables it; certificates are verified.
 */
export function poolConfigFromUrl(connectionString: string, options: PoolOptions = {}): PoolConfig {
  const url = new URL(connectionString);
  const local = LOCAL_HOSTS.has(url.hostname);
  const sslMode = url.searchParams.get('sslmode');
  const verifySsl = !local && sslMode !== 'disable' && sslMode !== 'no-verify';

  return {
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    statement_timeout: options.statementTimeoutMillis ?? 30_000,
    application_name: 'notion-tasks-sync',
    ...(verifySsl ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

export function createPool(connectionString: string, options: PoolOptions = {}): Pool {
  return new Pool(poolConfigFromUrl(connectionString, options));
}

/** Readiness probe: succeeds only if a round-trip to PostgreSQL succeeds. */
export async function checkPool(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}

/** Migrations may legitimately run longer than runtime statements. */
export function createMigrationPool(connectionString: string): Pool {
  return createPool(connectionString, { max: 2, statementTimeoutMillis: 300_000 });
}
