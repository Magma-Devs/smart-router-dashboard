import type { FastifyInstance, FastifyReply } from "fastify";
import {
  findUserByEmail,
  recordSignIn,
  toPublicUser,
  upsertOAuthUser,
  type OAuthProvider,
} from "../services/users.js";
import { verifyPassword } from "../services/password.js";
import { verifyOAuthToken } from "../services/oauth.js";

/** Tighter per-IP limit on the credential surface than the global default. */
const STRICT_AUTH_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

interface SignInBody {
  email: string;
  password: string;
}

interface OAuthBody {
  token: string;
}

/**
 * Registered ONLY when AUTH_MODE=enabled (lava-connect's routes/auth.ts,
 * condensed to the flows the dashboard supports):
 *
 *  - POST /auth/sign-in          : email + password → { user }
 *  - POST /auth/oauth/:provider  : provider token (verified server-side
 *                                  against Google/GitHub/Discord) → upsert
 *                                  → { user }
 *
 * Both are consumed by the web's Auth.js callbacks — the browser never
 * calls these directly. No self-serve sign-up: accounts come from the
 * ADMIN_EMAIL seed or OAuth.
 */
export async function authRoutes(app: FastifyInstance) {
  /** The db plugin connects lazily; 503 (not 500) while it settles. */
  function dbOr503(reply: FastifyReply) {
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
        summary: "Verify email + password and return the user record",
        body: {
          type: "object" as const,
          required: ["email", "password"],
          properties: {
            email: { type: "string" as const, format: "email" },
            password: { type: "string" as const, minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const body = request.body as SignInBody;

      const user = await findUserByEmail(db, body.email);
      // Identical response for unknown email and wrong password — no
      // account enumeration through the sign-in surface.
      if (!user || !user.passwordHash) {
        return reply
          .code(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Invalid email or password" });
      }
      if (user.isSuspended) {
        return reply
          .code(403)
          .send({ statusCode: 403, error: "Forbidden", message: "Account is suspended" });
      }
      const ok = await verifyPassword(body.password, user.passwordHash);
      if (!ok) {
        return reply
          .code(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Invalid email or password" });
      }

      await recordSignIn(db, user.id);
      return { user: toPublicUser(user) };
    },
  );

  app.post(
    "/auth/oauth/:provider",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "Verify a Google/GitHub/Discord token server-side and upsert the user",
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
          properties: { token: { type: "string" as const, minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const provider = (request.params as { provider: OAuthProvider }).provider;
      const { token } = request.body as OAuthBody;

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
      if (user.isSuspended) {
        return reply
          .code(403)
          .send({ statusCode: 403, error: "Forbidden", message: "Account is suspended" });
      }

      await recordSignIn(db, user.id);
      return { user: toPublicUser(user) };
    },
  );
}
