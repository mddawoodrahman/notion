import { getPool, closePool } from "../db/pool.js";
import { InboxRepository } from "../db/inbox-repo.js";

async function main() {
  const pool = getPool();
  try {
    const requeued = await InboxRepository.retryFailedEvents(pool, 100);
    console.log(`Requeued ${requeued} failed events back to pending status.`);
  } catch (err) {
    console.error("Failed to requeue failed events:", err);
    process.exit(1);
  } finally {
    await closePool(pool);
  }
}

main();
