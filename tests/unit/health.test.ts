import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { parseConfig } from '../../src/config.js';

const testConfig = parseConfig({
  NODE_ENV: 'test',
  NOTION_API_KEY: 'ntn_test_key_value',
  NOTION_DATABASE_ID: '1f0e8f6a-2a8f-4b3f-9d1b-5c2f4e6a7b8c',
  NOTION_VERSION: '2026-03-11',
  DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/notion_test',
  SYNC_TIMEZONE: 'Asia/Kolkata',
});

describe('health and readiness', () => {
  it('GET /health is liveness only and leaks nothing', async () => {
    const checkDatabase = vi.fn(async () => undefined);
    const app = await buildApp({ config: testConfig, checkDatabase });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(typeof body['uptime_s']).toBe('number');
    expect(JSON.stringify(body)).not.toMatch(/postgres|password|ntn_|3000/);
    expect(checkDatabase).not.toHaveBeenCalled();

    await app.close();
  });

  it('GET /ready returns 200 when the database probe succeeds', async () => {
    const app = await buildApp({
      config: testConfig,
      checkDatabase: async () => undefined,
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ready: true });

    await app.close();
  });

  it('GET /ready returns 503 with a fixed reason when the database probe fails', async () => {
    const app = await buildApp({
      config: testConfig,
      checkDatabase: async () => {
        throw new Error('connect ECONNREFUSED postgres://user:pass@127.0.0.1:5432/db');
      },
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ready: false, reason: 'db' });
    expect(response.payload).not.toContain('postgres://');

    await app.close();
  });

  it('GET /ready reports config when production lacks a webhook token', async () => {
    const production = parseConfig({
      NODE_ENV: 'production',
      NOTION_API_KEY: 'ntn_test_key_value',
      NOTION_DATABASE_ID: '1f0e8f6a-2a8f-4b3f-9d1b-5c2f4e6a7b8c',
      NOTION_VERSION: '2026-03-11',
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/notion_test',
      SYNC_TIMEZONE: 'Asia/Kolkata',
    });
    const app = await buildApp({
      config: production,
      checkDatabase: async () => undefined,
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ready: false, reason: 'config' });

    await app.close();
  });

  it('returns 404 JSON for unknown routes without a stack trace', async () => {
    const app = await buildApp({ config: testConfig, checkDatabase: async () => undefined });

    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.payload).not.toMatch(/stack|node_modules/);

    await app.close();
  });
});
