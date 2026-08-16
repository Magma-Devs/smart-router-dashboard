import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "@sr/db";
import {
  findUserByEmail,
  recordSignIn,
  toPublicUser,
  upsertOAuthUser,
  type OAuthProvider,
} from "../services/users.js";
import { verifyPassword } from "../services/password.js";
import { verifyOAuthToken } from "../services/oauth.js";
import { createSession, revokeSession, type ClientContext } from "../services/sessions.js";
import { noopAuditWriter, type AuditWriter } from "../services/audit.js";
import { requireAuth } from "../plugins/auth.js";
import { config } from "../config.js";

/** Tighter per-IP limit on the credential surface than the global default. */
const STRICT_AUTH_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

interface ForwardedClientContext {
  ip?: unknown;
  userAgent?: unknown;
}

interface SignInBody {
  email: string;
  password: string;
  clientContext?: ForwardedClientContext;
}

interface OAuthBody {
  token: string;
  clientContext?: ForwardedClientContext;
}

/** Constant-time comparison that doesn't leak length through early return. */
function secretsMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Decide what to record as the caller's device.
 *
 * The browser never reaches `/auth/sign-in` directly — Auth.js calls it from
 * the web tier — so `request.ip` here is the web pod and the User-Agent is
 * undici's. The web therefore forwards what *it* saw, and this is where we
 * decide whether to believe it.
 *
 * The route is publicly reachable, so an unauthenticated caller could otherwise
 * put any address on their own sign-in attempts, which is a way to write a false
 * audit trail. Forwarded context is honoured only alongside the shared internal
 * secret; otherwise we fall back to what we observed ourselves — which for a
 * direct caller is their own real address.
 */
function resolveClientContext(
  request: FastifyRequest,
  forwarded: ForwardedClientContext | undefined,
  expected: string | undefined,
): ClientContext {
  const observed: ClientContext = {
    ip: request.ip ?? null,
    userAgent: request.headers["user-agent"] ?? null,
  };

  if (!expected || !forwarded) return observed;

  const supplied = request.headers["x-internal-auth"];
  if (typeof supplied !== "string" || !secretsMatch(supplied, expected)) {
    request.log.warn("clientContext supplied without a valid internal secret — ignoring");
    return observed;
  }

  return {
    ip: typeof forwarded.ip === "string" && forwarded.ip ? forwarded.ip : observed.ip,
    userAgent:
      typeof forwarded.userAgent === "string" && forwarded.userAgent
        ? forwarded.userAgent
        : observed.userAgent,
  };
}

/**
 * Registered ONLY when AUTH_MODE=enabled:
 *
 *  - POST /auth/sign-in          : email + password → { user, sessionId }
 *  - POST /auth/oauth/:provider  : provider token (verified server-side)
 *                                  → upsert → { user, sessionId }
 *  - POST /auth/sign-out         : revoke the calling session
 *
 * The first two are consumed by the web's Auth.js callbacks — the browser never
 * calls them directly. Each opens a session row and returns its id, which the
 * web puts in the token's `sid` claim; the api resolves it on every subsequent
 * request. Creating the session here (rather than in a register call afterwards)
 * is what lets it commit in the same breath as the sign-in and carry the
 * browser's own address. See `docs/ACCOUNTS-DESIGN.md` §5.2.
 *
 * No self-serve sign-up: accounts come from the ADMIN_EMAIL seed or OAuth until
 * invitations land in slice 3.
 */
export async function authRoutes(app: FastifyInstance) {
  const audit: AuditWriter = noopAuditWriter(app.log);
  // Read from the live env at register time, not from the config snapshot —
  // that is taken at module load, before a test (or a late-loaded secrets file)
  // can set it. Same reason the auth plugin re-reads AUTH_SECRET.
  const internalSecret = process.env.INTERNAL_AUTH_SECRET ?? config.auth.internalSecret;

  /** The db plugin connects lazily; 503 (not 500) while it settles. */
  function dbOr503(reply: FastifyReply): Database | null {
    if (!app.db) {
      void reply
        .code(503)
        .send({ statusCode: 503, error: "Service Unavailable", message: "auth database not ready" });
      return null;
    }
    return app.db;
  }

  app.post(
    "/auth/sign-in",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "Verify email + password, open a session, and return the user record",
        body: {
          type: "object" as const,
          required: ["email", "password"],
          properties: {
            email: { type: "string" as const, format: "email" },
            password: { type: "string" as const, minLength: 1 },
            clientContext: {
              type: "object" as const,
              description:
                "The browser's own IP and User-Agent, forwarded by the web tier. Honoured only with a valid X-Internal-Auth header.",
              properties: {
                ip: { type: "string" as const },
                userAgent: { type: "string" as const },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const body = request.body as SignInBody;
      const client = resolveClientContext(request, body.clientContext, internalSecret);

      const user = await findUserByEmail(db, body.email);
      // Identical response for unknown email and wrong password — no
      // account enumeration through the sign-in surface.
      const ok = user?.passwordHash ? await verifyPassword(body.password, user.passwordHash) : false;
      if (!user || !ok) {
        await audit.write({
          action: "signin.failed",
          actor: { id: user?.id ?? null, kind: "user" },
          access: { ip: client.ip, client: client.userAgent, sessionId: null },
          note: user ? "wrong password" : "unknown address",
        });
        return reply
          .code(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Invalid email or password" });
      }

      const session = await createSession(db, {
        userId: user.id,
        authMethod: "password",
        client,
      });
      await recordSignIn(db, user.id);
      await audit.write({
        action: "signin.succeeded",
        actor: { id: user.id, kind: "user" },
        access: { ip: client.ip, client: client.userAgent, sessionId: session.id },
      });

      return { user: toPublicUser(user), sessionId: session.id };
    },
  );

  app.post(
    "/auth/oauth/:provider",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "Verify a Google/GitHub/Discord token server-side, upsert the user, open a session",
        params: {
          type: "object" as const,
          required: ["provider"],
          properties: {
            provider: { type: "string" as const, enum: ["google", "github", "discord"] },
          },
        },
        body: {
          type: "object" as const,
          required: ["token"],
          properties: {
            token: { type: "string" as const, minLength: 1 },
            clientContext: {
              type: "object" as const,
              properties: {
                ip: { type: "string" as const },
                userAgent: { type: "string" as const },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const provider = (request.params as { provider: OAuthProvider }).provider;
      const { token, clientContext } = request.body as OAuthBody;
      const client = resolveClientContext(request, clientContext, internalSecret);

      let profile;
      try {
        profile = await verifyOAuthToken(provider, token);
      } catch (err) {
        request.log.warn({ provider, err: (err as Error).message }, "oauth verification failed");
        return reply
          .code(401)
          .send({ statusCode: 401, error: "Unauthorized", message: `${provider} token verification failed` });
      }

      let user;
      try {
        user = await upsertOAuthUser(db, provider, profile);
      } catch (err) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: "Bad Request", message: (err as Error).message });
      }
      if (user.status !== "active") {
        return reply
          .code(403)
          .send({ statusCode: 403, error: "Forbidden", message: "This account is no longer active" });
      }

      const session = await createSession(db, {
        userId: user.id,
        authMethod: provider,
        client,
      });
      await recordSignIn(db, user.id);
      await audit.write({
        action: "signin.succeeded",
        actor: { id: user.id, kind: "user" },
        access: { ip: client.ip, client: client.userAgent, sessionId: session.id },
      });

      return { user: toPublicUser(user), sessionId: session.id };
    },
  );

  app.post(
    "/auth/sign-out",
    {
      schema: {
        tags: ["Auth"],
        summary: "Revoke the calling session (this device only)",
      },
    },
    async (request, reply) => {
      // Under /auth/* so an already-dead session still gets a clean answer
      // rather than the global gate's 401 — but it does need a live one to
      // know which session to close.
      const authUser = requireAuth(request, reply);
      if (!authUser) return reply;

      const db = dbOr503(reply);
      if (!db) return reply;

      await revokeSession(db, authUser.sessionId, { reason: "self", by: authUser.id });
      await audit.write({
        action: "signout",
        actor: { id: authUser.id, kind: "user" },
        access: {
          ip: authUser.session.ip,
          client: authUser.session.client,
          sessionId: authUser.sessionId,
        },
      });

      return { ok: true };
    },
  );
}
