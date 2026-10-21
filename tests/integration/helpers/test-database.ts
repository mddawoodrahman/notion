import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';

export interface TestDatabase {
  readonly url: string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not allocate a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Start a throwaway PostgreSQL cluster for integration tests.
 *
 * The repository intentionally has no Docker requirement: the `embedded-postgres`
 * dev dependency supplies a real PostgreSQL binary so ON CONFLICT, SKIP LOCKED,
 * JSONB and CHECK constraints are exercised against a real server, not a mock.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const port = await freePort();
  const databaseDir = await mkdtemp(join(tmpdir(), 'notion-sync-pg-'));

  const postgres = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: (message) => {
      throw message instanceof Error ? message : new Error(String(message));
    },
  });

  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('notion_test');

  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/notion_test`;

  return {
    url,
    stop: async () => {
      await postgres.stop();
      await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
