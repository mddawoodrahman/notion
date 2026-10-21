import type { FastifyPluginAsync } from "fastify";

export interface HealthRouteOptions {
  checkDbReady?: () => Promise<boolean>;
}

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (fastify, opts) => {
  fastify.get("/health", async (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  fastify.get("/ready", async (_request, reply) => {
    try {
      if (opts.checkDbReady) {
        const isDbReady = await opts.checkDbReady();
        if (!isDbReady) {
          return reply.status(503).send({ status: "not_ready", reason: "database_unavailable" });
        }
      }

      return reply.status(200).send({
        status: "ready",
        timestamp: new Date().toISOString(),
      });
    } catch {
      return reply.status(503).send({ status: "not_ready", reason: "database_check_failed" });
    }
  });
};
