import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { verifyWebhookSignature } from "@notionhq/client";
import pg from "pg";
import { InboxRepository } from "../db/inbox-repo.js";
import { AppConfig, getConfig } from "../src/config.js";
import { logger } from "../src/logger.js";

const webhookEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  entity: z
    .object({
      type: z.string().optional(),
      id: z.string().optional(),
    })
    .optional(),
  timestamp: z.string().optional(),
}).passthrough();

export interface WebhookRouteOptions {
  pool?: pg.Pool;
  config?: AppConfig;
}

export const webhookRoutes: FastifyPluginAsync<WebhookRouteOptions> = async (fastify, opts) => {
  const config = opts.config ?? getConfig();
  const pool = opts.pool;

  fastify.post("/webhooks/notion", async (request, reply) => {
    const rawBody = request.rawBody ?? Buffer.from("");
    const body = request.body as Record<string, any> | undefined;

    // 1. One-time verification handshake check (SPEC §8.1)
    if (body && typeof body.verification_token === "string" && !body.type) {
      const token = body.verification_token;
      const last4 = token.slice(-4);
      logger.warn(
        { tokenSuffix: `***${last4}` },
        "Received Notion webhook verification token handshake"
      );
      return reply.status(200).send({ ok: true });
    }

    // 2. Verification token availability (SEC-001): fail closed unless explicitly opted out.
    const verificationToken = config.NOTION_WEBHOOK_VERIFICATION_TOKEN;
    const allowUnsigned = config.ALLOW_UNSIGNED_WEBHOOKS;
    if (!verificationToken && !allowUnsigned) {
      logger.error("Rejecting webhook: NOTION_WEBHOOK_VERIFICATION_TOKEN is not configured");
      return reply.status(503).send({ ok: false });
    }

    // 3. Signature verification (SPEC §8.2)
    if (verificationToken) {
      const signature = request.headers["x-notion-signature"] as string | undefined;
      if (!signature) {
        logger.warn({ ip: request.ip }, "Rejected webhook delivery: missing X-Notion-Signature");
        return reply.status(401).send({ ok: false });
      }

      try {
        const isValid = await verifyWebhookSignature({
          body: rawBody,
          signature,
          verificationToken,
        });

        if (!isValid) {
          logger.warn({ ip: request.ip }, "Rejected webhook delivery: signature verification failed");
          return reply.status(401).send({ ok: false });
        }
      } catch (err) {
        logger.error({ err, ip: request.ip }, "Error executing webhook signature verification");
        return reply.status(401).send({ ok: false });
      }
    } else {
      logger.warn(
        { ip: request.ip },
        "Accepting unsigned webhook delivery because ALLOW_UNSIGNED_WEBHOOKS=true (development only)"
      );
    }

    // 4. Envelope validation (SPEC §8.4)
    const parseResult = webhookEnvelopeSchema.safeParse(body);
    if (!parseResult.success) {
      logger.warn({ issues: parseResult.error.issues }, "Rejected webhook: invalid envelope schema");
      return reply.status(400).send({ ok: false });
    }

    const event = parseResult.data;

    // 5. Durable storage into sync_inbox (INV-3)
    if (!pool) {
      logger.error("Database pool not available for webhook ingestion");
      return reply.status(503).send({ ok: false });
    }

    try {
      const enqueueResult = await InboxRepository.enqueueEvent(pool, {
        eventId: event.id,
        eventType: event.type,
        entityType: event.entity?.type,
        entityId: event.entity?.id,
        eventTimestamp: event.timestamp,
        payload: event as Record<string, unknown>,
      });

      if (enqueueResult.isDuplicate) {
        logger.info({ eventId: event.id }, "Acknowledged duplicate webhook event delivery");
        return reply.status(200).send({ ok: true, duplicate: true });
      }

      logger.info(
        { eventId: event.id, eventType: event.type, entityId: event.entity?.id },
        "Durable webhook event stored in sync_inbox"
      );
      return reply.status(200).send({ ok: true });
    } catch (dbErr) {
      logger.error({ err: dbErr, eventId: event.id }, "Failed to durably store webhook event in database");
      return reply.status(503).send({ ok: false });
    }
  });
};
