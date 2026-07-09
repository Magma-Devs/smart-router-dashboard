import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Bind session JWTs to a known issuer/audience so another HS256 token
 *  signed with `AUTH_SECRET` can't be confused with a session token. The
 *  web side (`apps/web/src/auth.config.ts`) sets these on the encode
 *  side; we enforce them on the verify side. */
export const SESSION_JWT_ISSUER = "smart-router-dashboard-web";
export const SESSION_JWT_AUDIENCE = "smart-router-dashboard-api";

export type UserRole = "admin" | "member";

/** JWT payload — must stay in sync with what Auth.js (web) signs. */
export interface AuthClaims {
  /** User UUID. Auth.js puts this in the `sub` claim. */
  sub: string;
  email: string;
  role: UserRole;
  /** Issued-at, seconds since epoch (standard JWT claim). */
  iat?: number;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthClaims;
    user: AuthClaims;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth plugin's onRequest hook; null when no/invalid Bearer. */
    authUser: AuthClaims | null;
  }
}

/** Routes that stay public in AUTH_MODE=enabled. Everything the browser
 *  calls for data (/api/*) requires a Bearer token. */
function isPublicPath(url: string): boolean {
  // Strip the querystring before matching.
  const path = url.split("?")[0] ?? url;
  return (
    path === "/health" ||
    path.startsWith("/health/") ||
    path === "/version" ||
    path.startsWith("/auth/") ||
    path === "/docs" ||
    path.startsWith("/docs/")
  );
}

/**
 * Registered ONLY when AUTH_MODE=enabled (ported from lava-connect's
 * plugins/auth.ts, minus the Redis session registry):
 *
 *  1. `@fastify/jwt` — validates the HS256 JWT Auth.js (web) signs with
 *     the shared AUTH_SECRET.
 *  2. An onRequest hook decodes the Bearer into `request.authUser`
 *     (silent failure — null).
 *  3. A global gate: any non-public route without a valid token gets 401.
 *     This flips the whole /api/* surface to authenticated in one place
 *     instead of requiring each handler to opt in.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  // Read at register time, not module-load time — test setups inject
  // AUTH_SECRET dynamically and the config snapshot would miss it.
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_MODE=enabled requires AUTH_SECRET — generate one with `openssl rand -base64 32` (must match the web's).",
    );
  }

  await app.register(jwt, {
    secret,
    sign: {
      algorithm: "HS256",
      iss: SESSION_JWT_ISSUER,
      aud: SESSION_JWT_AUDIENCE,
    },
    verify: {
      algorithms: ["HS256"],
      allowedIss: SESSION_JWT_ISSUER,
      allowedAud: SESSION_JWT_AUDIENCE,
    },
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  app.decorateRequest("authUser", null);

  app.addHook("onRequest", async (request, reply) => {
    // Decode for everyone (so even public routes can read authUser)…
    try {
      await request.jwtVerify();
      request.authUser = request.user;
    } catch {
      request.authUser = null;
    }

    // …then gate the protected surface. CORS preflights pass through —
    // the browser sends them without headers and @fastify/cors answers.
    if (request.method === "OPTIONS") return;
    if (isPublicPath(request.url)) return;
    if (!request.authUser) {
      return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "Authentication required" });
    }
  });
});

/** Reject with 401 unless a valid Bearer token was supplied. For handlers
 *  that want an explicit check (the global gate already covers /api/*). */
export function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): AuthClaims | null {
  if (!request.authUser) {
    void reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "Authentication required" });
    return null;
  }
  return request.authUser;
}
