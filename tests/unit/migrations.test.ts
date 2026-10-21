import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Migration SQL Structure and Schema Constraints", () => {
  const migrationPath = path.resolve(__dirname, "../../migrations/0001_init.sql");

  it("0001_init.sql exists and is non-empty", async () => {
    const content = await fs.readFile(migrationPath, "utf-8");
    expect(content.length).toBeGreaterThan(100);
  });

  it("contains schema notion_sync", async () => {
    const sql = await fs.readFile(migrationPath, "utf-8");
    expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS notion_sync;");
  });

  it("contains notion_tasks with all canonical V1 fields", async () => {
    const sql = await fs.readFile(migrationPath, "utf-8");

    const requiredFields = [
      "notion_page_id",
      "title",
      "status",
      "list_name",
      "important",
      "in_my_day",
      "priority",
      "due_date",
      "due_at",
      "reminder_at",
      "user_archived",
      "notion_is_archived",
      "notion_in_trash",
      "is_in_source",
      "page_url",
      "notion_created_time",
      "notion_last_edited_time",
      "raw_properties",
      "page_content_json",
      "synced_at",
    ];

    for (const field of requiredFields) {
      expect(sql).toContain(field);
    }
  });

  it("enforces type contracts: DATE for due_date, TIMESTAMPTZ for due_at", async () => {
    const sql = await fs.readFile(migrationPath, "utf-8");
    expect(sql).toMatch(/due_date\s+DATE/i);
    expect(sql).toMatch(/due_at\s+TIMESTAMPTZ/i);
    expect(sql).toMatch(/reminder_at\s+TIMESTAMPTZ/i);
  });

  it("contains sync_inbox with status check constraint and indexes", async () => {
    const sql = await fs.readFile(migrationPath, "utf-8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS notion_sync.sync_inbox");
    expect(sql).toContain("CHECK (status IN ('pending','processing','processed','failed'))");
    expect(sql).toContain("sync_inbox_claim_idx");
    expect(sql).toContain("sync_inbox_lease_idx");
    expect(sql).toContain("sync_inbox_failed_idx");
  });

  it("contains sync_runs with status and run_type check constraints", async () => {
    const sql = await fs.readFile(migrationPath, "utf-8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS notion_sync.sync_runs");
    expect(sql).toContain("CHECK (run_type IN ('initial_backfill','reconciliation','manual_retry'))");
    expect(sql).toContain("CHECK (status IN ('running','succeeded','partial','failed'))");
  });

  it("contains schema_migrations ledger table", async () => {
    const sql = await fs.readFile(migrationPath, "utf-8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS notion_sync.schema_migrations");
  });
});
