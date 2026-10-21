import { getConfig } from "../src/config.js";
import { getPool, closePool } from "../db/pool.js";
import { InboxRepository } from "../db/inbox-repo.js";

async function main() {
  const config = getConfig();
  const pool = getPool();

  try {
    const recovered = await InboxRepository.recoverStuckEvents(pool, config.SYNC_LEASE_SECONDS);
    console.log(`Recovered ${recovered} stuck processing events (reset to pending).`);
  } catch (err) {
    console.error("Failed to recover stuck events:", err);
    process.exit(1);
  } finally {
    await closePool(pool);
  }
}

main();
