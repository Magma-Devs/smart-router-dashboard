import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config } from "../config.js";

export const swaggerPlugin = fp(async (app: FastifyInstance) => {
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Smart Router Dashboard API",
        description:
          "REST API for the Smart Router observability dashboard. A stateless " +
          "Prometheus proxy — every metric maps to a real smartrouter_* / " +
          "rpc_endpoint_* series; unbacked values are returned as null (never invented).",
        version: config.build.version,
      },
      tags: [
        { name: "Health", description: "Liveness / readiness probes" },
        { name: "Version", description: "Build provenance" },
        { name: "Auth", description: "Sign-in flows (AUTH_MODE=enabled only) — consumed by the web's Auth.js callbacks" },
        { name: "Metrics", description: "Prometheus-backed metrics: overview, chains, upstreams, traffic, methods" },
        { name: "Config", description: "Live router topology read from the mounted helm-values" },
      ],
    },
  });

  // Serve the explorer at /docs outside production (avoids handing attackers a
  // ready-made endpoint map in prod). Flip via NODE_ENV.
  if (!config.isProd) {
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: { docExpansion: "list", deepLinking: true },
    });
  }
});
