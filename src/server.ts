import { buildApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { sanitizeError } from './redact.js';
import { checkPool, createPool } from '../db/pool.js';

/**
 * Process entrypoint. Startup validation order is fixed:
 *   config → database probe → HTTP listener.
 * Phase 3 adds Notion reachability + data-source identity to this sequence.
 */
async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`Startup configuration error: ${sanitizeError(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config);
  const pool = createPool(config.database.url);

  try {
    await checkPool(pool);
  } catch (error) {
    if (!config.testMode) {
      logger.fatal(
        { event: 'startup.db_unreachable', error: sanitizeError(error) },
        'PostgreSQL is not reachable; refusing to start',
      );
      await pool.end();
      process.exitCode = 1;
      return;
    }
    logger.warn(
      { event: 'startup.db_unreachable_test_mode', error: sanitizeError(error) },
      'PostgreSQL unavailable in explicit test mode; starting with /ready reporting db',
    );
  }

  const app = await buildApp({
    config,
    logger,
    checkDatabase: () => checkPool(pool),
  });

  await installShutdownHandlers(app, pool, logger);

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    logger.fatal({ event: 'startup.listen_failed', error: sanitizeError(error) });
    await pool.end();
    process.exitCode = 1;
  }
}

async function installShutdownHandlers(
  app: Awaited<ReturnType<typeof buildApp>>,
  pool: ReturnType<typeof createPool>,
  logger: Logger,
): Promise<void> {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ event: 'server.shutdown', signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (error) {
      logger.error({ event: 'server.shutdown_failed', error: sanitizeError(error) });
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
