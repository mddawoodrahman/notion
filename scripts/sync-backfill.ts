import { getConfig } from "../src/config.js";
import { getPool, closePool } from "../db/pool.js";
import { NotionSyncClient } from "../sync/notion-client.js";
import { runBackfill } from "../sync/backfill.js";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const config = getConfig();
  const pool = getPool();
  const client = new NotionSyncClient(config);

  try {
    const result = await runBackfill({
      client,
      pool,
      config,
      dryRun,
    });

    console.log(
      `Backfill complete: status=${result.status} processed=${result.recordsProcessed} failed=${result.pageFailures} run_id=${result.runId ?? "dry-run"}`
    );

    if (result.status === "failed" || result.status === "partial") {
      process.exit(1);
    }
  } catch (err) {
    console.error("Backfill command failed:", err);
    process.exit(1);
  } finally {
    await closePool(pool);
  }
}

main();
