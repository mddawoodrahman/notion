import { describe, expect, it } from 'vitest';

import { configErrorSummary, loadConfig, parseConfig, validateBaseEnv } from '../../src/config.js';

const validEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  NOTION_API_KEY: 'ntn_test_key_value',
  NOTION_DATABASE_ID: '1f0e8f6a-2a8f-4b3f-9d1b-5c2f4e6a7b8c',
  NOTION_VERSION: '2026-03-11',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/notion_sync',
  SYNC_TIMEZONE: 'Asia/Kolkata',
} as const;

describe('config', () => {
  it('parses a valid environment into a frozen typed config', () => {
    const config = parseConfig(validEnv);

    expect(config.env).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.notion.apiKey).toBe('ntn_test_key_value');
    expect(config.notion.databaseId).toBe('1f0e8f6a-2a8f-4b3f-9d1b-5c2f4e6a7b8c');
    expect(config.notion.dataSourceId).toBeUndefined();
    expect(config.notion.version).toBe('2026-03-11');
    expect(config.database.url).toContain('postgresql://');
    expect(config.sync.reconciliationIntervalMinutes).toBe(30);
    expect(config.sync.maxAttempts).toBe(8);
    expect(config.sync.pageSize).toBe(100);
    expect(config.sync.syncBodyContent).toBe(true);
    expect(config.sync.leaseSeconds).toBe(300);
    expect(config.webhook.verificationToken).toBeUndefined();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.sync)).toBe(true);
  });

  it('fails fast naming the missing variable, without printing any value', () => {
    const env: Record<string, string | undefined> = { ...validEnv };
    delete env.NOTION_API_KEY;

    expect(() => parseConfig(env)).toThrowError(/NOTION_API_KEY/);
    try {
      parseConfig(env);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('ntn_test_key_value');
      expect(message).not.toContain('postgresql://user:pass');
    }
  });

  it('rejects an unsupported Notion version (pinned, not a free-form knob)', () => {
    expect(() => parseConfig({ ...validEnv, NOTION_VERSION: '2022-06-28' })).toThrowError(
      /NOTION_VERSION/,
    );
  });

  it('rejects a non-UUID database id', () => {
    expect(() => parseConfig({ ...validEnv, NOTION_DATABASE_ID: 'not-a-uuid' })).toThrowError(
      /NOTION_DATABASE_ID/,
    );
  });

  it('accepts UUIDs without dashes and normalises them', () => {
    const config = parseConfig({
      ...validEnv,
      NOTION_DATABASE_ID: '1f0e8f6a2a8f4b3f9d1b5c2f4e6a7b8c',
    });
    expect(config.notion.databaseId).toBe('1f0e8f6a-2a8f-4b3f-9d1b-5c2f4e6a7b8c');
  });

  it('enforces the Notion page-size ceiling of 100', () => {
    expect(() => parseConfig({ ...validEnv, SYNC_PAGE_SIZE: '101' })).toThrowError(
      /SYNC_PAGE_SIZE/,
    );
  });

  it('parses boolean body-sync flag and false value', () => {
    expect(parseConfig({ ...validEnv, SYNC_SYNC_BODY_CONTENT: 'false' }).sync.syncBodyContent).toBe(
      false,
    );
  });

  it('validates the IANA timezone', () => {
    expect(() => parseConfig({ ...validEnv, SYNC_TIMEZONE: 'Mars/Olympus' })).toThrowError(
      /SYNC_TIMEZONE/,
    );
  });

  it('requires a webhook token only in production readiness, not at parse time', () => {
    const config = parseConfig({ ...validEnv, NODE_ENV: 'production' });
    expect(config.webhook.verificationToken).toBeUndefined();
    expect(validateBaseEnv(config)).toEqual(['NOTION_WEBHOOK_VERIFICATION_TOKEN']);

    const ready = parseConfig({
      ...validEnv,
      NODE_ENV: 'production',
      NOTION_WEBHOOK_VERIFICATION_TOKEN: 'a'.repeat(40),
    });
    expect(ready.webhook.verificationToken).toHaveLength(40);
    expect(validateBaseEnv(ready)).toEqual([]);
  });

  it('allows placeholder credentials only in explicit test mode', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.testMode).toBe(true);
    expect(config.notion.apiKey).toBeTruthy();
    expect(config.database.url).toMatch(/^postgres/);

    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrowError(/NOTION_API_KEY/);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrowError(/NOTION_API_KEY/);
  });

  it('rejects a weak webhook token', () => {
    expect(() =>
      parseConfig({ ...validEnv, NOTION_WEBHOOK_VERIFICATION_TOKEN: 'short' }),
    ).toThrowError(/NOTION_WEBHOOK_VERIFICATION_TOKEN/);
  });

  it('summarises issues with variable names only', () => {
    const summary = configErrorSummary([
      { path: ['NOTION_API_KEY'], message: 'Required' },
      { path: ['DATABASE_URL'], message: 'Invalid url' },
    ]);
    expect(summary).toContain('NOTION_API_KEY');
    expect(summary).toContain('DATABASE_URL');
  });
});
