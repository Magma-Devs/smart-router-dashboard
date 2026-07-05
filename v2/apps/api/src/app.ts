import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { swaggerPlugin } from "./plugins/swagger.js";
import { prometheusPlugin } from "./plugins/prometheus.js";
import { healthRoutes } from "./routes/health.js";
import { versionRoutes } from "./routes/version.js";
import { metricRoutes } from "./routes/metrics.js";
import { configRoutes } from "./routes/config.js";

/** Build the Fastify app with all plugins + routes registered. */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true,
    logger: {
      level: config.logLevel,
      transport: config.isDev ? { target: "pino-pretty" } : undefined,
    },
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.server.corsOrigins, credentials: true });
  await app.register(rateLimit, { max: config.server.rateLimitMax, timeWindow: "1 minute" });

  await app.register(errorHandlerPlugin);
  // Swagger must be registered before the routes so their schemas are collected.
  await app.register(swaggerPlugin);
  await app.register(prometheusPlugin);

  await app.register(healthRoutes);
  await app.register(versionRoutes);
  await app.register(metricRoutes);
  await app.register(configRoutes);

  return app;
}
