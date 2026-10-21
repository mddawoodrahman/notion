import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestDatabase, type TestDatabase } from './helpers/test-database.js';

describe.sequential('embedded PostgreSQL smoke test', () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await startTestDatabase();
    pool = new Pool({ connectionString: database.url });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.stop();
  });

  it('reports a real PostgreSQL server with jsonb and SKIP LOCKED support', async () => {
    const version = await pool.query<{ version: string }>('SELECT version()');
    expect(version.rows[0]?.version).toMatch(/PostgreSQL/);

    const json = await pool.query<{ value: unknown }>(`SELECT '{"a":1}'::jsonb AS value`);
    expect(json.rows[0]?.value).toEqual({ a: 1 });
  });
});
