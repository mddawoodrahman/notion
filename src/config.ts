import { z } from 'zod';

/**
 * The only Notion API version this service is written against. The Notion API
 * treats `Notion-Version` as an enum; an unknown value is a configuration error,
 * never a silent fallback.
 */
export const SUPPORTED_NOTION_VERSION = '2026-03-11' as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\//;

/** Placeholders that are only injected when NODE_ENV=test. Never used in production. */
const TEST_MODE_DEFAULTS = {
  NOTION_API_KEY: 'ntn_test_mode_placeholder',
  NOTION_DATABASE_ID: '00000000-0000-4000-8000-000000000000',
  NOTION_VERSION: SUPPORTED_NOTION_VERSION,
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/notion_test',
  SYNC_TIMEZONE: 'UTC',
} as const;

export interface ConfigIssueLike {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

export interface NotionConfig {
  readonly apiKey: string;
  readonly databaseId: string;
  readonly dataSourceId?: string;
  readonly version: typeof SUPPORTED_NOTION_VERSION;
}

export interface SyncConfig {
  readonly timezone: string;
  readonly reconciliationIntervalMinutes: number;
  readonly maxAttempts: number;
  readonly pageSize: number;
  readonly syncBodyContent: boolean;
  readonly leaseSeconds: number;
}

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly testMode: boolean;
  readonly isProduction: boolean;
  readonly port: number;
  readonly logLevel: string;
  readonly notion: NotionConfig;
  readonly webhook: { readonly verificationToken?: string };
  readonly database: { readonly url: string; readonly directUrl?: string };
  readonly sync: SyncConfig;
}

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  NOTION_API_KEY: z.string().min(1),
  NOTION_DATABASE_ID: z.string().regex(UUID_PATTERN),
  NOTION_DATA_SOURCE_ID: z
    .string()
    .regex(UUID_PATTERN)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  NOTION_VERSION: z.literal(SUPPORTED_NOTION_VERSION),
  NOTION_WEBHOOK_VERIFICATION_TOKEN: z
    .string()
    .min(32)
    .optional()
    .or(z.literal('').transform(() => undefined)),

  DATABASE_URL: z
    .string()
    .refine((value) => POSTGRES_URL_PATTERN.test(value), {
      message: 'must start with postgres:// or postgresql://',
    }),
  DIRECT_DATABASE_URL: z
    .string()
    .refine((value) => POSTGRES_URL_PATTERN.test(value), {
      message: 'must start with postgres:// or postgresql://',
    })
    .optional()
    .or(z.literal('').transform(() => undefined)),

  SYNC_TIMEZONE: z.string().refine(isIanaTimezone, {
    message: 'must be a valid IANA timezone',
  }),
  SYNC_RECONCILIATION_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  SYNC_SYNC_BODY_CONTENT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  SYNC_LEASE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
});

export type RawConfig = z.input<typeof rawSchema>;

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}

function normaliseUuid(value: string): string {
  const hex = value.replace(/-/g, '').toLowerCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Message text that names variables, never values. */
export function configErrorSummary(issues: ReadonlyArray<ConfigIssueLike>): string {
  return issues
    .map((issue) => {
      const name = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${name}: ${issue.message}`;
    })
    .join('; ');
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly issues: ReadonlyArray<string>;

  constructor(issues: ReadonlyArray<ConfigIssueLike>) {
    const summary = configErrorSummary(issues);
    super(`Invalid configuration — ${summary}`);
    this.issues = summary.split('; ');
  }
}

/**
 * Parse an environment object into the single authoritative config object.
 * Throws `ConfigError` naming the offending variables and no values.
 */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues);
  }

  const raw = parsed.data;
  const testMode = raw.NODE_ENV === 'test';

  const config: AppConfig = {
    env: raw.NODE_ENV,
    testMode,
    isProduction: raw.NODE_ENV === 'production',
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    notion: {
      apiKey: raw.NOTION_API_KEY,
      databaseId: normaliseUuid(raw.NOTION_DATABASE_ID),
      ...(raw.NOTION_DATA_SOURCE_ID === undefined
        ? {}
        : { dataSourceId: normaliseUuid(raw.NOTION_DATA_SOURCE_ID) }),
      version: raw.NOTION_VERSION,
    },
    webhook: {
      ...(raw.NOTION_WEBHOOK_VERIFICATION_TOKEN === undefined
        ? {}
        : { verificationToken: raw.NOTION_WEBHOOK_VERIFICATION_TOKEN }),
    },
    database: {
      url: raw.DATABASE_URL,
      ...(raw.DIRECT_DATABASE_URL === undefined ? {} : { directUrl: raw.DIRECT_DATABASE_URL }),
    },
    sync: {
      timezone: raw.SYNC_TIMEZONE,
      reconciliationIntervalMinutes: raw.SYNC_RECONCILIATION_INTERVAL_MINUTES,
      maxAttempts: raw.SYNC_MAX_ATTEMPTS,
      pageSize: raw.SYNC_PAGE_SIZE,
      syncBodyContent: raw.SYNC_SYNC_BODY_CONTENT,
      leaseSeconds: raw.SYNC_LEASE_SECONDS,
    },
  };

  return deepFreeze(config);
}

/**
 * Variables required for full operation that are currently absent.
 * In production, event ingestion fails closed without a verification token, so
 * readiness must report `config` rather than pretending to be ready.
 */
export function validateBaseEnv(config: AppConfig): string[] {
  const missing: string[] = [];
  if (config.isProduction && config.webhook.verificationToken === undefined) {
    missing.push('NOTION_WEBHOOK_VERIFICATION_TOKEN');
  }
  return missing;
}

/**
 * Load config from `process.env`. Only `NODE_ENV=test` may run without real
 * credentials, and it is explicit so production can never silently degrade.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): AppConfig {
  const withTestDefaults: Record<string, string | undefined> =
    env['NODE_ENV'] === 'test'
      ? { ...TEST_MODE_DEFAULTS, ...env }
      : { ...env };
  return parseConfig(withTestDefaults);
}

function deepFreeze<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    const child = value[key];
    if (child !== null && typeof child === 'object') {
      deepFreeze(child as object);
    }
  }
  return Object.freeze(value);
}
