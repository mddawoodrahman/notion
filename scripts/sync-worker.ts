import { getConfig } from "../src/config.js";
import { getPool, closePool } from "../db/pool.js";
import { NotionSyncClient } from "../sync/notion-client.js";
import { startWorker } from "../sync/worker.js";

async function main() {
  const config = getConfig();
  const pool = getPool();
  const client = new NotionSyncClient(config);

  try {
    await startWorker({ client, pool, config });
  } catch (err) {
    console.error("Worker failed:", err);
    process.exit(1);
  } finally {
    await closePool(pool);
  }
}

main();
