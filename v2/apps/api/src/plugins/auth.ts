import fp from "fastify-plugin";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Basic-auth gate ported from the Python backend. Disabled by default in dev
 * (AUTH_ENABLED!=="true"); when enabled, guards everything except public
 * probes (/health, /version, /api/auth/*). Constant-time credential compare.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  const PUBLIC = ["/health", "/health/ready", "/version", "/api/auth/login", "/api/auth/status"];
  // The OpenAPI explorer + spec are dev-only (swagger plugin is gated on prod),
  // so leave them ungated when present.
  const PUBLIC_PREFIXES = ["/docs"];

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.auth.enabled) return;
    if (PUBLIC.some((p) => request.url === p || request.url.startsWith(`${p}?`))) return;
    if (PUBLIC_PREFIXES.some((p) => request.url.startsWith(p))) return;

    const header = request.headers.authorization;
    if (!header?.startsWith("Basic ")) {
      reply.header("WWW-Authenticate", 'Basic realm="smart-router-dashboard"');
      reply.status(401).send({ error: "Unauthorized", message: "Authentication required", statusCode: 401 });
      return;
    }
    const [user, pass] = Buffer.from(header.slice(6), "base64").toString().split(":");
    if (!user || !pass || !safeEqual(user, config.auth.username) || !safeEqual(pass, config.auth.password)) {
      reply.status(401).send({ error: "Unauthorized", message: "Invalid credentials", statusCode: 401 });
    }
  });
});
