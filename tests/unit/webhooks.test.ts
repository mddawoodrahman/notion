import { describe, it, expect, vi, afterAll } from "vitest";
import { signWebhookPayload } from "@notionhq/client";
import { buildServer } from "../../src/server.js";
import { validateConfig } from "../../src/config.js";
import { InboxRepository } from "../../db/inbox-repo.js";

describe("Secure Webhook Receiver and Durable Inbox", () => {
  const token = "my_super_secret_webhook_verification_token_1234567890";

  const testConfig = validateConfig({
    NODE_ENV: "test",
    NOTION_WEBHOOK_VERIFICATION_TOKEN: token,
  });

  const mockPool = {} as any;

  const app = buildServer({
    config: testConfig,
    pool: mockPool,
  });

  afterAll(async () => {
    await app.close();
  });

  it("handles one-time subscription handshake without enqueuing", async () => {
    const enqueueSpy = vi.spyOn(InboxRepository, "enqueueEvent");

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      payload: { verification_token: "temp_handshake_secret_token_abc" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(enqueueSpy).not.toHaveBeenCalled();

    enqueueSpy.mockRestore();
  });

  it("rejects webhook request without X-Notion-Signature header with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      payload: {
        id: "evt_1",
        type: "page.created",
        entity: { type: "page", id: "page_1" },
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false });
  });

  it("rejects invalid signature with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      headers: {
        "x-notion-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      },
      payload: {
        id: "evt_1",
        type: "page.created",
        entity: { type: "page", id: "page_1" },
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false });
  });

  it("accepts valid signature and durably stores event", async () => {
    const payload = JSON.stringify({
      id: "evt_valid_123",
      type: "page.properties_updated",
      entity: { type: "page", id: "page_abc" },
      timestamp: "2026-10-21T12:00:00.000Z",
    });

    const signature = await signWebhookPayload({
      body: payload,
      verificationToken: token,
    });

    const enqueueSpy = vi.spyOn(InboxRepository, "enqueueEvent").mockResolvedValue({
      isDuplicate: false,
      eventId: "evt_valid_123",
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      headers: {
        "content-type": "application/json",
        "x-notion-signature": signature,
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(enqueueSpy).toHaveBeenCalledWith(mockPool, {
      eventId: "evt_valid_123",
      eventType: "page.properties_updated",
      entityType: "page",
      entityId: "page_abc",
      eventTimestamp: "2026-10-21T12:00:00.000Z",
      payload: JSON.parse(payload),
    });

    enqueueSpy.mockRestore();
  });

  it("returns 200 with duplicate:true for repeated deliveries", async () => {
    const payload = JSON.stringify({
      id: "evt_dup_456",
      type: "page.properties_updated",
      entity: { type: "page", id: "page_abc" },
    });

    const signature = await signWebhookPayload({
      body: payload,
      verificationToken: token,
    });

    const enqueueSpy = vi.spyOn(InboxRepository, "enqueueEvent").mockResolvedValue({
      isDuplicate: true,
      eventId: "evt_dup_456",
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      headers: {
        "content-type": "application/json",
        "x-notion-signature": signature,
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, duplicate: true });

    enqueueSpy.mockRestore();
  });

  it("returns 400 for malformed payload failing envelope schema", async () => {
    const payload = JSON.stringify({
      // missing id and type
      foo: "bar",
    });

    const signature = await signWebhookPayload({
      body: payload,
      verificationToken: token,
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      headers: {
        "content-type": "application/json",
        "x-notion-signature": signature,
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false });
  });

  it("returns 503 if database storage fails (INV-3)", async () => {
    const payload = JSON.stringify({
      id: "evt_db_fail",
      type: "page.created",
      entity: { type: "page", id: "page_1" },
    });

    const signature = await signWebhookPayload({
      body: payload,
      verificationToken: token,
    });

    const enqueueSpy = vi.spyOn(InboxRepository, "enqueueEvent").mockRejectedValue(
      new Error("PostgreSQL connection refused")
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      headers: {
        "content-type": "application/json",
        "x-notion-signature": signature,
      },
      payload,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false });

    enqueueSpy.mockRestore();
  });

  const unsignedDevelopmentConfig = (overrides: Record<string, string> = {}) =>
    validateConfig({
      NODE_ENV: "development",
      NOTION_API_KEY: "secret_dev_placeholder_1234567890",
      NOTION_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/devdb",
      ...overrides,
    });

  it("fails closed with 503 and stores nothing when no verification token is configured (SEC-001)", async () => {
    const enqueueSpy = vi.spyOn(InboxRepository, "enqueueEvent");
    const unsignedApp = buildServer({ config: unsignedDevelopmentConfig(), pool: mockPool });

    try {
      expect(unsignedDevelopmentConfig().NODE_ENV).toBe("development");

      const res = await unsignedApp.inject({
        method: "POST",
        url: "/webhooks/notion",
        payload: {
          id: "evt_unsigned_1",
          type: "page.created",
          entity: { type: "page", id: "page_unsigned_1" },
        },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ok: false });
      expect(enqueueSpy).not.toHaveBeenCalled(); // zero inbox rows
    } finally {
      await unsignedApp.close();
      enqueueSpy.mockRestore();
    }
  });

  it("accepts unsigned deliveries only with the explicit ALLOW_UNSIGNED_WEBHOOKS=true opt-in (SEC-001)", async () => {
    const enqueueSpy = vi.spyOn(InboxRepository, "enqueueEvent").mockResolvedValue({
      isDuplicate: false,
      eventId: "evt_unsigned_ok",
    });

    const config = unsignedDevelopmentConfig({ ALLOW_UNSIGNED_WEBHOOKS: "true" });
    expect(config.ALLOW_UNSIGNED_WEBHOOKS).toBe(true);

    const unsignedApp = buildServer({ config, pool: mockPool });

    try {
      const res = await unsignedApp.inject({
        method: "POST",
        url: "/webhooks/notion",
        payload: {
          id: "evt_unsigned_ok",
          type: "page.created",
          entity: { type: "page", id: "page_unsigned_ok" },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    } finally {
      await unsignedApp.close();
      enqueueSpy.mockRestore();
    }
  });
});
