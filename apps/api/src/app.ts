import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { swaggerPlugin } from "./plugins/swagger.js";
import { prometheusPlugin } from "./plugins/prometheus.js";
import { authPlugin } from "./plugins/auth.js";
import { dbPlugin } from "./plugins/db.js";
import { healthRoutes } from "./routes/health.js";
import { versionRoutes } from "./routes/version.js";
import { metricRoutes } from "./routes/metrics.js";
import { configRoutes } from "./routes/config.js";
import { upstreamRoutes } from "./routes/upstreams.js";
import { authRoutes } from "./routes/auth.js";
import { auditRoutes } from "./routes/audit.js";

/** Build the Fastify app with all plugins + routes registered. */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Not `true`: this api is publicly reachable, and trusting every hop lets
    // any caller set X-Forwarded-For to whatever it likes — which both defeats
    // the per-IP rate limit and lets an attacker choose the address recorded
    // against their sign-in attempts. See config.server.trustProxy.
    trustProxy: config.server.trustProxy,
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

  // AUTH_MODE=enabled flips on: Postgres users (lazy connect + migrate +
  // admin seed), HS256 JWT validation, a global /api/* auth gate, and the
  // /auth/* routes the web's Auth.js callbacks consume. AUTH_MODE=disabled
  // (default) registers none of this — zero-dependency boot, open routes.
  // Mode is re-read from the live env (not the config snapshot) so tests
  // can flip it per-app-instance.
  const authMode = process.env.AUTH_MODE ?? config.auth.mode;
  if (authMode === "enabled") {
    await app.register(dbPlugin);
    await app.register(authPlugin);
    await app.register(authRoutes);
    // Inside the gate on purpose: the audit log is Postgres-backed and every
    // route on it needs a live session, so it must not exist at all when auth
    // is disabled.
    await app.register(auditRoutes);
  }

  await app.register(healthRoutes);
  await app.register(versionRoutes);
  await app.register(metricRoutes);
  await app.register(configRoutes);
  await app.register(upstreamRoutes);

  return app;
}
