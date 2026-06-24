import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", { schema: { tags: ["Health"], summary: "Liveness probe" } }, async () => ({ health: "ok" }));

  app.get("/health/ready", { schema: { tags: ["Health"], summary: "Readiness probe (pings Prometheus)" } }, async (_request, reply) => {
    const ready = await app.prom.ping();
    if (!ready) reply.status(503);
    return {
      status: ready ? "ready" : "not_ready",
      components: { prometheus: ready ? "ok" : "ping_failed" },
    };
  });
}
