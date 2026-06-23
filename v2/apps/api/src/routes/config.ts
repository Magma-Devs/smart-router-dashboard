import type { FastifyInstance } from "fastify";

export async function configRoutes(app: FastifyInstance) {
  // The live router topology (chains, interfaces, backing endpoints) the
  // dashboard reflects — read from the mounted helm-values config.
  app.get("/api/config/routers", async () => ({ routers: app.routerConfig.getRouters() }));
}
