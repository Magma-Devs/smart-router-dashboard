import type { FastifyInstance } from "fastify";

export async function configRoutes(app: FastifyInstance) {
  // The live router topology (chains, interfaces, backing endpoints) the
  // dashboard reflects — Helm values or the router's native config.
  app.get("/api/config/routers", { schema: { tags: ["Config"], summary: "Live router topology and configuration load status" } }, async () =>
    app.routerConfig.getConfiguration(),
  );
}
