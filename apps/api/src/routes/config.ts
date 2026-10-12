import type { FastifyInstance } from "fastify";

export async function configRoutes(app: FastifyInstance) {
  // Saved router topology and availability of its mounted configuration.
  app.get("/api/config/routers", { schema: { tags: ["Config"], summary: "Configured router topology and configuration availability" } }, async () => app.routerConfig.getConfiguration());
}
