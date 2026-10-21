import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import type { AppConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { sanitizeError } from './redact.js';
import { healthRoutes } from '../routes/health.js';

export interface AppDeps {
  readonly config: AppConfig;
  /** Probe used by readiness. Must throw on failure; never returns secrets. */
  readonly checkDatabase: () => Promise<void>;
  readonly logger?: Logger;
}

/**
 * Build the HTTP application. Handlers receive all I/O through injected
 * dependencies so `src/` never imports the database or Notion layers.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger =
    deps.logger ??
    createLogger({
      env: deps.config.env,
      logLevel: deps.config.testMode ? 'silent' : deps.config.logLevel,
    });

  const options: FastifyServerOptions = {
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
  };

  const app = Fastify(options);

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ ok: false, error: 'not_found' });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(
      {
        event: 'request.failed',
        request_id: request.id,
        error: sanitizeError(error),
      },
      'unhandled request error',
    );
    void reply.code(500).send({ ok: false, error: 'internal_error' });
  });

  await app.register(healthRoutes, { deps });

  return app;
}
