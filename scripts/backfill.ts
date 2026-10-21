/**
 * Operator/CI entrypoint: `npm run sync:backfill [-- --dry-run]`.
 * Exit 0 only for a complete scan; `partial` and `failed` exit 1.
 */

import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createPool } from '../db/pool.js';
import { sanitizeError } from '../src/redact.js';
import { parseBackfillArgs, runBackfill } from '../sync/backfill.js';
import { createNotionGateway } from '../sync/notion-client.js';
import { resolvePropertyMap } from '../sync/property-map.js';

async function main(): Promise<void> {
  // Node's built-in loader: no dotenv dependency, and a missing .env is fine
  // because real deployments inject variables through the platform.
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env present.
  }

  const args = parseBackfillArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPool(config.database.url);

  try {
    const gateway = createNotionGateway({ config, logger });
    const result = await runBackfill({
      gateway,
      pool,
      logger,
      propertyMap: resolvePropertyMap(process.env),
      databaseId: config.notion.databaseId,
      timezone: config.sync.timezone,
      syncBodyContent: config.sync.syncBodyContent,
      pageSize: config.sync.pageSize,
      dryRun: args.dryRun,
      ...(args.startCursor === undefined ? {} : { startCursor: args.startCursor }),
      ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
    });

    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === 'partial' || result.status === 'failed' ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`backfill failed: ${sanitizeError(error)}\n`);
  process.exitCode = 1;
});
