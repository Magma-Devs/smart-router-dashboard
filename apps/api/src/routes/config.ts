import type { FastifyInstance } from "fastify";
import type { RouterConfigResponse } from "@sr/shared";
import { config } from "../config.js";

export async function configRoutes(app: FastifyInstance) {
  // The live router topology (chains, interfaces, backing endpoints) the
  // dashboard reflects — read from the mounted helm-values config. It also
  // tells the Try-me drawer who sends the router leg: this api, or the browser.
  app.get(
    "/api/config/routers",
    { schema: { tags: ["Config"], summary: "Live router topology from helm-values" } },
    async (): Promise<RouterConfigResponse> => ({
      routers: app.routerConfig.getRouters(),
      routerRelay: config.routerRelay.enabled,
    }),
  );
}
