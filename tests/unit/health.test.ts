import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../../src/server.js";
import { validateConfig } from "../../src/config.js";

describe("Health and Readiness Endpoints", () => {
  const testConfig = validateConfig({
    NODE_ENV: "test",
    PORT: "3000",
  });

  const app = buildServer({
    config: testConfig,
    checkDbReady: async () => true,
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200 ok", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /ready returns 200 ready when database is available", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/ready",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ready");
    expect(body.timestamp).toBeDefined();
  });

  it("GET /ready returns 503 not_ready when database is unavailable", async () => {
    const failingApp = buildServer({
      config: testConfig,
      checkDbReady: async () => false,
    });

    const res = await failingApp.inject({
      method: "GET",
      url: "/ready",
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("not_ready");
    expect(body.reason).toBe("database_unavailable");
    await failingApp.close();
  });
});
