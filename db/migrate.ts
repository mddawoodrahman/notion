import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { types, type Pool, type PoolClient } from 'pg';

import { createMigrationPool } from './pool.js';

// DATE (OID 1082) is a calendar date, not an instant. Returning it as a raw
// `YYYY-MM-DD` string prevents node-postgres from materialising local midnight
// and shifting the day for negative-offset timezones.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const ADVISORY_LOCK_KEY = 7_214_005_337;

export interface MigrationFile {
  readonly version: string;
  readonly path: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationStatus {
  readonly applied: ReadonlyArray<{ version: string; appliedAt: Date; checksum: string }>;
  readonly pending: readonly string[];
  readonly drifted: ReadonlyArray<{ version: string; applied: string; onDisk: string }>;
}

export interface MigrateOptions {
  readonly migrationsDir?: string;
  readonly logger?: (message: string) => void;
}

export function migrationsDirectory(custom?: string): string {
  return custom ?? resolve(process.cwd(), 'migrations');
}

export async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const migrations: MigrationFile[] = [];
  for (const name of files) {
    const path = join(directory, name);
    const sql = await readFile(path, 'utf8');
    migrations.push({
      version: name,
      path,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}`);
    }
    seen.add(migration.version);
  }
  return migrations;
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS notion_sync');
  await client.query(`
    CREATE TABLE IF NOT EXISTS notion_sync.schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum   TEXT NOT NULL
    )
  `);
}

export async function getMigrationStatus(
  client: Pick<PoolClient, 'query'>,
  directory: string,
): Promise<MigrationStatus> {
  const migrations = await readMigrations(directory);
  const appliedResult = await client.query<{
    version: string;
    applied_at: Date;
    checksum: string;
  }>('SELECT version, applied_at, checksum FROM notion_sync.schema_migrations ORDER BY version');

  const applied = appliedResult.rows.map((row) => ({
    version: row.version,
    appliedAt: row.applied_at,
    checksum: row.checksum,
  }));
  const appliedByVersion = new Map(applied.map((row) => [row.version, row.checksum]));

  const pending: string[] = [];
  const drifted: Array<{ version: string; applied: string; onDisk: string }> = [];
  for (const migration of migrations) {
    const appliedChecksum = appliedByVersion.get(migration.version);
    if (appliedChecksum === undefined) {
      pending.push(migration.version);
    } else if (appliedChecksum !== migration.checksum) {
      drifted.push({
        version: migration.version,
        applied: appliedChecksum,
        onDisk: migration.checksum,
      });
    }
  }

  return { applied, pending, drifted };
}

/**
 * Apply every pending migration exactly once, under a session advisory lock so
 * two deployers cannot race. Each migration is applied in its own transaction.
 */
export async function applyMigrations(
  databaseUrl: string,
  options: MigrateOptions = {},
): Promise<{ appliedNow: readonly string[]; status: MigrationStatus }> {
  const directory = migrationsDirectory(options.migrationsDir);
  const pool = createMigrationPool(databaseUrl);
  const client = await pool.connect();
  const log = options.logger ?? (() => undefined);

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureLedger(client);

    const before = await getMigrationStatus(client, directory);
    if (before.drifted.length > 0) {
      throw new Error(
        `Applied migration checksum mismatch: ${before.drifted
          .map((item) => item.version)
          .join(', ')}. Refusing to continue; migrations are forward-only.`,
      );
    }

    const byVersion = new Map((await readMigrations(directory)).map((item) => [item.version, item]));
    const appliedNow: string[] = [];

    for (const version of before.pending) {
      const migration = byVersion.get(version);
      if (migration === undefined) {
        throw new Error(`Migration ${version} disappeared between listing and applying`);
      }
      log(`applying ${version}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO notion_sync.schema_migrations (version, checksum) VALUES ($1, $2)',
          [migration.version, migration.checksum],
        );
        await client.query('COMMIT');
        appliedNow.push(version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${version} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    return { appliedNow, status: await getMigrationStatus(client, directory) };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

export async function withMigrationClient<T>(
  databaseUrl: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = createMigrationPool(databaseUrl);
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

export function resolveMigrationUrl(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const url = env['DIRECT_DATABASE_URL'] ?? env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    throw new Error('DIRECT_DATABASE_URL or DATABASE_URL must be set to run migrations');
  }
  return url;
}

/** Convenience re-export used by tests that need a plain pool. */
export function poolFor(url: string): Pool {
  return createMigrationPool(url);
}

// ---------------------------------------------------------------------------
// CLI: tsx db/migrate.ts up|status
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const url = resolveMigrationUrl(process.env);

  if (command === 'status') {
    const status = await withMigrationClient(url, (client) =>
      getMigrationStatus(client, migrationsDirectory()),
    );
    for (const applied of status.applied) {
      console.log(`applied  ${applied.version}  ${applied.appliedAt.toISOString()}`);
    }
    for (const pending of status.pending) {
      console.log(`pending  ${pending}`);
    }
    for (const drift of status.drifted) {
      console.log(`drifted  ${drift.version}`);
    }
    console.log(
      `summary applied=${status.applied.length} pending=${status.pending.length} drifted=${status.drifted.length}`,
    );
    process.exitCode = status.drifted.length > 0 ? 1 : 0;
    return;
  }

  if (command !== 'up') {
    console.error(`Unknown command "${command}". Use "up" or "status".`);
    process.exitCode = 2;
    return;
  }

  const result = await applyMigrations(url, { logger: (message) => console.log(message) });
  console.log(
    `migrations applied=${result.appliedNow.length} pending=${result.status.pending.length}`,
  );
}

function isDirectlyInvoked(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return pathToFileURL(entry).href === import.meta.url;
}

if (isDirectlyInvoked()) {
  main().catch((error: unknown) => {
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
