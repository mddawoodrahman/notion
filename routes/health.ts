import type { FastifyInstance } from 'fastify';

import { validateBaseEnv, type AppConfig } from '../src/config.js';

export interface HealthDeps {
  readonly config: AppConfig;
  readonly checkDatabase: () => Promise<void>;
}

const READINESS_TIMEOUT_MS = 1_000;

/**
 * Liveness answers "is this process running"; readiness answers "can it do
 * useful work". Neither exposes versions, hostnames, counts or error text.
 */
export async function healthRoutes(
  app: FastifyInstance,
  options: { readonly deps: HealthDeps },
): Promise<void> {
  const { config, checkDatabase } = options.deps;
  const startedAt = Date.now();

  app.get('/health', async () => ({
    status: 'ok',
    uptime_s: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
  }));

  app.get('/ready', async (_request, reply) => {
    if (validateBaseEnv(config).length > 0) {
      return reply.code(503).send({ ready: false, reason: 'config' });
    }

    try {
      await withTimeout(checkDatabase(), READINESS_TIMEOUT_MS);
      return reply.code(200).send({ ready: true });
    } catch {
      return reply.code(503).send({ ready: false, reason: 'db' });
    }
  });
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('readiness probe timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
