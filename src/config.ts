import { z } from "zod";
import { ConfigurationError } from "./errors.js";

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  NOTION_API_KEY: z.string().optional(),
  NOTION_DATABASE_ID: z.string().optional(),
  NOTION_DATA_SOURCE_ID: z.string().optional(),
  NOTION_VERSION: z.literal("2026-03-11").default("2026-03-11"),
  NOTION_WEBHOOK_VERIFICATION_TOKEN: z.string().optional(),
  // SEC-001: explicit opt-out for signature verification (development only; forbidden in production)
  ALLOW_UNSIGNED_WEBHOOKS: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  DIRECT_DATABASE_URL: z.string().optional(),
  TEST_DATABASE_URL: z.string().optional(),

  SYNC_TIMEZONE: z.string().default("Asia/Kolkata"),
  SYNC_RECONCILIATION_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  SYNC_SYNC_BODY_CONTENT: z
    .preprocess((val) => {
      if (typeof val === "string") return val.toLowerCase() === "true" || val === "1";
      return Boolean(val);
    }, z.boolean())
    .default(true),
  SYNC_LEASE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
});

export type RawConfig = z.infer<typeof rawEnvSchema>;

export interface AppConfig {
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  NOTION_API_KEY: string;
  NOTION_DATABASE_ID: string;
  NOTION_DATA_SOURCE_ID?: string;
  NOTION_VERSION: "2026-03-11";
  NOTION_WEBHOOK_VERIFICATION_TOKEN?: string;
  ALLOW_UNSIGNED_WEBHOOKS: boolean;
  DATABASE_URL: string;
  DIRECT_DATABASE_URL?: string;
  TEST_DATABASE_URL?: string;
  SYNC_TIMEZONE: string;
  SYNC_RECONCILIATION_INTERVAL_MINUTES: number;
  SYNC_MAX_ATTEMPTS: number;
  SYNC_PAGE_SIZE: number;
  SYNC_SYNC_BODY_CONTENT: boolean;
  SYNC_LEASE_SECONDS: number;
  LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
}

export function validateConfig(raw: Record<string, string | undefined>): AppConfig {
  const parsed = rawEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const errorIssues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new ConfigurationError(`Environment validation failed: ${errorIssues}`);
  }

  const data = parsed.data;
  const isProduction = data.NODE_ENV === "production";
  const isTest = data.NODE_ENV === "test";
  const allowUnsignedWebhooks = data.ALLOW_UNSIGNED_WEBHOOKS === "true";

  // Validate timezone
  try {
    Intl.DateTimeFormat(undefined, { timeZone: data.SYNC_TIMEZONE });
  } catch {
    throw new ConfigurationError(`Invalid IANA time zone: ${data.SYNC_TIMEZONE}`);
  }

  // SEC-001: unsigned webhook ingestion must never be enabled in production
  if (isProduction && allowUnsignedWebhooks) {
    throw new ConfigurationError(
      "ALLOW_UNSIGNED_WEBHOOKS=true is forbidden in production; configure NOTION_WEBHOOK_VERIFICATION_TOKEN instead"
    );
  }

  // IMP-001: outside tests, every required runtime variable must be present (no silent placeholders)
  const missing: string[] = [];
  if (!isTest) {
    if (!data.NOTION_API_KEY) missing.push("NOTION_API_KEY");
    if (!data.NOTION_DATABASE_ID) missing.push("NOTION_DATABASE_ID");
    if (!data.DATABASE_URL) missing.push("DATABASE_URL");
    if (isProduction && !data.NOTION_WEBHOOK_VERIFICATION_TOKEN) {
      missing.push("NOTION_WEBHOOK_VERIFICATION_TOKEN");
    }
  }

  if (missing.length > 0) {
    throw new ConfigurationError(
      isProduction
        ? `Missing mandatory production environment variables: ${missing.join(", ")}`
        : `Missing required environment variables (set NODE_ENV=test to use offline placeholders): ${missing.join(", ")}`
    );
  }

  // Token format sanity checks if provided
  if (data.NOTION_API_KEY && !data.NOTION_API_KEY.startsWith("secret_") && !data.NOTION_API_KEY.startsWith("ntn_")) {
    if (isProduction) {
      throw new ConfigurationError("NOTION_API_KEY must start with 'secret_' or 'ntn_'");
    }
  }

  if (data.DATABASE_URL && !data.DATABASE_URL.startsWith("postgres://") && !data.DATABASE_URL.startsWith("postgresql://")) {
    throw new ConfigurationError("DATABASE_URL must be a valid postgresql:// or postgres:// URI");
  }

  return {
    NODE_ENV: data.NODE_ENV,
    PORT: data.PORT,
    NOTION_API_KEY: data.NOTION_API_KEY || (isTest ? "secret_mock_test_key_placeholder" : ""),
    NOTION_DATABASE_ID: data.NOTION_DATABASE_ID || (isTest ? "00000000-0000-0000-0000-000000000000" : ""),
    NOTION_DATA_SOURCE_ID: data.NOTION_DATA_SOURCE_ID,
    NOTION_VERSION: data.NOTION_VERSION,
    NOTION_WEBHOOK_VERIFICATION_TOKEN: data.NOTION_WEBHOOK_VERIFICATION_TOKEN,
    ALLOW_UNSIGNED_WEBHOOKS: allowUnsignedWebhooks,
    DATABASE_URL: data.DATABASE_URL || (isTest ? "postgresql://mock:mock@localhost:5432/mock" : ""),
    DIRECT_DATABASE_URL: data.DIRECT_DATABASE_URL,
    TEST_DATABASE_URL: data.TEST_DATABASE_URL,
    SYNC_TIMEZONE: data.SYNC_TIMEZONE,
    SYNC_RECONCILIATION_INTERVAL_MINUTES: data.SYNC_RECONCILIATION_INTERVAL_MINUTES,
    SYNC_MAX_ATTEMPTS: data.SYNC_MAX_ATTEMPTS,
    SYNC_PAGE_SIZE: data.SYNC_PAGE_SIZE,
    SYNC_SYNC_BODY_CONTENT: data.SYNC_SYNC_BODY_CONTENT,
    SYNC_LEASE_SECONDS: data.SYNC_LEASE_SECONDS,
    LOG_LEVEL: data.LOG_LEVEL,
  };
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = validateConfig(process.env);
  }
  return cachedConfig;
}

export function resetConfigForTesting(overrides?: Record<string, string | undefined>): AppConfig {
  cachedConfig = validateConfig(overrides ?? process.env);
  return cachedConfig;
}
