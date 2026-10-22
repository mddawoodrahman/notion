import { describe, it, expect } from "vitest";
import { resolveSslConfig } from "../../db/pool.js";

describe("SEC-002 — verified TLS by default", () => {
  it("uses certificate-verified TLS for a remote host without sslmode", () => {
    expect(
      resolveSslConfig("postgresql://user:pass@ep-pool.neon.tech/neondb", false)
    ).toBe(true);
  });

  it("uses certificate-verified TLS when the connection string requires SSL", () => {
    expect(
      resolveSslConfig("postgresql://user:pass@localhost:5432/db?sslmode=require", false)
    ).toBe(true);
  });

  it("does not enable TLS for localhost without sslmode", () => {
    expect(
      resolveSslConfig("postgresql://user:pass@localhost:5432/db", false)
    ).toBeUndefined();
  });

  it("does not enable TLS for 127.0.0.1 without sslmode", () => {
    expect(
      resolveSslConfig("postgresql://user:pass@127.0.0.1:5432/db", false)
    ).toBeUndefined();
  });

  it("disables certificate verification only with the explicit insecure opt-in", () => {
    expect(
      resolveSslConfig("postgresql://user:pass@db.internal:5432/db", true)
    ).toEqual({ rejectUnauthorized: false });
  });

  it("keeps the insecure opt-in scoped to TLS connections", () => {
    expect(
      resolveSslConfig("postgresql://user:pass@localhost:5432/db", true)
    ).toBeUndefined();
  });
});
