import { getConfig } from "../src/config.js";
import { getPool, closePool } from "../db/pool.js";
import { NotionSyncClient } from "../sync/notion-client.js";
import { runReconciliation } from "../sync/reconcile.js";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const config = getConfig();
  const pool = getPool();
  const client = new NotionSyncClient(config);

  try {
    const result = await runReconciliation({
      client,
      pool,
      config,
      dryRun,
    });

    console.log(
      `Reconciliation complete: status=${result.status} processed=${result.recordsProcessed} failed=${result.pageFailures} remediated=${result.remediatedOutdated} run_id=${result.runId ?? "dry-run"}`
    );

    if (result.status === "failed" || result.status === "partial") {
      process.exit(1);
    }
  } catch (err) {
    console.error("Reconciliation command failed:", err);
    process.exit(1);
  } finally {
    await closePool(pool);
  }
}

main();
