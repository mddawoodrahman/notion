import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/config.js";
import { ConfigurationError } from "../../src/errors.js";

describe("Configuration and Environment Validation", () => {
  it("loads safely in test environment without live credentials", () => {
    const config = validateConfig({
      NODE_ENV: "test",
      PORT: "4000",
      NOTION_VERSION: "2026-03-11",
    });

    expect(config.NODE_ENV).toBe("test");
    expect(config.PORT).toBe(4000);
    expect(config.NOTION_VERSION).toBe("2026-03-11");
    expect(config.SYNC_TIMEZONE).toBe("Asia/Kolkata");
  });

  it("fails fast in production if NOTION_API_KEY is missing", () => {
    expect(() => {
      validateConfig({
        NODE_ENV: "production",
        NOTION_DATABASE_ID: "12345678-1234-1234-1234-123456789abc",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        NOTION_WEBHOOK_VERIFICATION_TOKEN: "token123456789012345678901234567890",
      });
    }).toThrowError(ConfigurationError);
  });

  it("fails fast in production if DATABASE_URL is missing", () => {
    expect(() => {
      validateConfig({
        NODE_ENV: "production",
        NOTION_API_KEY: "secret_1234567890",
        NOTION_DATABASE_ID: "12345678-1234-1234-1234-123456789abc",
        NOTION_WEBHOOK_VERIFICATION_TOKEN: "token123456789012345678901234567890",
      });
    }).toThrowError(ConfigurationError);
  });

  it("fails fast in production if NOTION_WEBHOOK_VERIFICATION_TOKEN is missing", () => {
    expect(() => {
      validateConfig({
        NODE_ENV: "production",
        NOTION_API_KEY: "secret_1234567890",
        NOTION_DATABASE_ID: "12345678-1234-1234-1234-123456789abc",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      });
    }).toThrowError(ConfigurationError);
  });

  it("rejects non-pinned NOTION_VERSION", () => {
    expect(() => {
      validateConfig({
        NODE_ENV: "test",
        NOTION_VERSION: "2022-06-28" as unknown as "2026-03-11",
      });
    }).toThrowError(ConfigurationError);
  });

  it("rejects invalid timezone", () => {
    expect(() => {
      validateConfig({
        NODE_ENV: "test",
        SYNC_TIMEZONE: "Invalid/Not_A_Timezone",
      });
    }).toThrowError(ConfigurationError);
  });

  it("rejects invalid DATABASE_URL protocol", () => {
    expect(() => {
      validateConfig({
        NODE_ENV: "test",
        DATABASE_URL: "mysql://user:pass@localhost/db",
      });
    }).toThrowError(ConfigurationError);
  });

  it("does not expose secret values in error messages", () => {
    const sensitiveSecret = "secret_topsecretvalue12345678";
    try {
      validateConfig({
        NODE_ENV: "production",
        NOTION_API_KEY: sensitiveSecret,
        // intentionally missing DATABASE_URL
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      expect((err as Error).message).not.toContain(sensitiveSecret);
    }
  });
});
