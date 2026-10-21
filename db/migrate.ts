import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getPool } from "./pool.js";
import { getConfig } from "../src/config.js";
import { logger } from "../src/logger.js";
import { DatabaseError } from "../src/errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MigrationResult {
  version: string;
  applied: boolean;
  checksum: string;
}

export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string = path.resolve(__dirname, "../migrations")
): Promise<MigrationResult[]> {
  const client = await pool.connect();
  const results: MigrationResult[] = [];

  try {
    // Acquire advisory lock to prevent concurrent migrations
    await client.query("SELECT pg_advisory_lock(hashtext('notion_sync_migrations'))");

    // Ensure schema and migration tracking table exist
    await client.query("CREATE SCHEMA IF NOT EXISTS notion_sync");
    await client.query(`
      CREATE TABLE IF NOT EXISTS notion_sync.schema_migrations (
        version     TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum    TEXT NOT NULL
      )
    `);

    // Fetch already applied migrations
    const appliedRes = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM notion_sync.schema_migrations ORDER BY version ASC"
    );
    const appliedMap = new Map(appliedRes.rows.map((r) => [r.version, r.checksum]));

    // Read and sort migration files
    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const sqlFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".sql"))
      .map((e) => e.name)
      .sort();

    for (const filename of sqlFiles) {
      const filePath = path.join(migrationsDir, filename);
      const sqlContent = await fs.readFile(filePath, "utf-8");
      const checksum = crypto.createHash("sha256").update(sqlContent).digest("hex");

      const existingChecksum = appliedMap.get(filename);
      if (existingChecksum) {
        if (existingChecksum !== checksum) {
          throw new DatabaseError(
            `Migration checksum mismatch for ${filename}: applied checksum ${existingChecksum.slice(0, 8)} does not match local file ${checksum.slice(0, 8)}`
          );
        }
        results.push({ version: filename, applied: false, checksum });
        continue;
      }

      // Apply new migration in transaction
      await client.query("BEGIN");
      try {
        await client.query(sqlContent);
        await client.query(
          "INSERT INTO notion_sync.schema_migrations (version, checksum) VALUES ($1, $2)",
          [filename, checksum]
        );
        await client.query("COMMIT");
        logger.info({ version: filename }, "Migration applied successfully");
        results.push({ version: filename, applied: true, checksum });
      } catch (err) {
        await client.query("ROLLBACK");
        throw new DatabaseError(`Failed to apply migration ${filename}: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }

    return results;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('notion_sync_migrations'))");
    } catch {
      // Ignore unlock errors on release
    }
    client.release();
  }
}

export async function getMigrationStatus(
  pool: pg.Pool,
  migrationsDir: string = path.resolve(__dirname, "../migrations")
): Promise<{ version: string; applied: boolean; appliedAt?: Date }[]> {
  const client = await pool.connect();
  try {
    const tableExists = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'notion_sync' 
        AND table_name = 'schema_migrations'
      )
    `);

    const appliedMap = new Map<string, Date>();
    if (tableExists.rows[0]?.exists) {
      const res = await client.query<{ version: string; applied_at: Date }>(
        "SELECT version, applied_at FROM notion_sync.schema_migrations"
      );
      for (const row of res.rows) {
        appliedMap.set(row.version, row.applied_at);
      }
    }

    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const sqlFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".sql"))
      .map((e) => e.name)
      .sort();

    return sqlFiles.map((file) => ({
      version: file,
      applied: appliedMap.has(file),
      appliedAt: appliedMap.get(file),
    }));
  } finally {
    client.release();
  }
}

// CLI entrypoint
async function cli() {
  const command = process.argv[2] ?? "up";
  const config = getConfig();
  const connString = config.DIRECT_DATABASE_URL || config.DATABASE_URL;
  const pool = getPool(connString);

  try {
    if (command === "status") {
      const status = await getMigrationStatus(pool);
      console.log("Migration status:");
      for (const item of status) {
        console.log(`  ${item.applied ? "[✓]" : "[ ]"} ${item.version} ${item.appliedAt ? `(applied at ${item.appliedAt.toISOString()})` : "(pending)"}`);
      }
    } else if (command === "up") {
      const results = await runMigrations(pool);
      const appliedCount = results.filter((r) => r.applied).length;
      console.log(`Migrations complete. Applied ${appliedCount} new migrations.`);
    } else {
      console.error(`Unknown migration command: ${command}. Use 'up' or 'status'.`);
      process.exit(1);
    }
  } catch (err) {
    console.error("Migration error:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  cli();
}
