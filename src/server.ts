import Fastify from "fastify";
import pg from "pg";
import { AppConfig, getConfig } from "./config.js";
import { logger } from "./logger.js";
import { healthRoutes } from "../routes/health.js";
import { webhookRoutes } from "../routes/webhooks.js";
import { getPool } from "../db/pool.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface ServerOptions {
  config?: AppConfig;
  pool?: pg.Pool;
  checkDbReady?: () => Promise<boolean>;
}

export function buildServer(options: ServerOptions = {}) {
  const config = options.config ?? getConfig();

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: config.NODE_ENV === "test",
    bodyLimit: 256 * 1024, // 256 KiB limit per SPEC §8.3
  });

  // Custom parser for application/json that retains raw Buffer for signature verification
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    try {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
      req.rawBody = raw;
      if (!raw || raw.length === 0) {
        done(null, {});
        return;
      }
      const parsed = JSON.parse(raw.toString("utf-8"));
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Register routes
  app.register(healthRoutes, { checkDbReady: options.checkDbReady });
  app.register(webhookRoutes, { pool: options.pool, config });

  return app;
}

// Start server if run directly
async function start() {
  try {
    const config = getConfig();
    const pool = getPool();
    const server = buildServer({
      config,
      pool,
      checkDbReady: async () => {
        try {
          await pool.query("SELECT 1");
          return true;
        } catch {
          return false;
        }
      },
    });

    const address = await server.listen({
      port: config.PORT,
      host: "0.0.0.0",
    });
    logger.info({ address }, "Notion to PostgreSQL sync server listening");
  } catch (err) {
    logger.fatal({ err }, "Failed to start server");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  start();
}
