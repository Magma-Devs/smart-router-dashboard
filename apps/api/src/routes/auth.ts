import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "@sr/db";
import {
  findUserByEmail,
  recordSignIn,
  toPublicUser,
  upsertOAuthUser,
  OAuthAccountNotFoundError,
  type OAuthProvider,
} from "../services/users.js";
import { validatePassword, verifyPassword } from "../services/password.js";
import { verifyOAuthToken } from "../services/oauth.js";
import { createSession, revokeSession, type ClientContext } from "../services/sessions.js";
import {
  lookupInvitation,
  redeemInvitation,
  type InviteLookup,
} from "../services/invitations.js";
import {
  consumePasswordReset,
  createPasswordReset,
  resetUrl,
} from "../services/password-reset.js";
import { checkLock, clearFailures, recordFailure } from "../services/lockout.js";
import { lazyAuditWriter, type AuditWriter } from "../services/audit.js";
import {
  completeSetup,
  needsSetup,
  resolveSetupToken,
  setupTokenMatches,
} from "../services/setup.js";
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

interface InvitePreviewBody {
  token: string;
}

interface InviteAcceptBody {
  token: string;
  password?: string;
  googleIdToken?: string;
  name?: string;
}

interface ForgotBody {
  email: string;
}

interface ResetBody {
  token: string;
  password: string;
}

interface SetupBody {
  token: string;
  email: string;
  password: string;
  name?: string;
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
  const audit: AuditWriter = lazyAuditWriter(app);
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

  app.get(
    "/auth/bootstrap",
    {
      schema: {
        tags: ["Auth"],
        summary: "Whether this deployment still needs its first admin, and which shape it is",
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      // Deliberately says nothing about the setup token. Anyone can ask whether
      // an install is unclaimed — that is visible from the login page anyway —
      // but only someone with log or filesystem access can claim it.
      return { needsSetup: await needsSetup(db), mode: config.deploymentMode };
    },
  );

  app.post(
    "/auth/setup",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "Create the first admin on a fresh install. Requires the installer's setup token.",
        body: {
          type: "object" as const,
          required: ["token", "email", "password"],
          properties: {
            token: { type: "string" as const, minLength: 1 },
            email: { type: "string" as const, format: "email" },
            password: { type: "string" as const, minLength: 1 },
            name: { type: "string" as const },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const body = request.body as SetupBody;
      const client = resolveClientContext(request, undefined, internalSecret);

      // Cheap check first, so an already-claimed install doesn't become a
      // token-guessing oracle. The authoritative check runs inside the
      // transaction below, under a lock.
      if (!(await needsSetup(db))) {
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "This deployment has already been set up",
        });
      }

      if (!setupTokenMatches(body.token, resolveSetupToken(app.log))) {
        request.log.warn(
          { ip: client.ip },
          "first-run setup attempted with an incorrect token",
        );
        return reply.code(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "That setup token is not correct. It is printed by the installer.",
        });
      }

      const problem = await validatePassword(body.password, request.log);
      if (problem) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: "Bad Request", message: problem.message });
      }

      const outcome = await completeSetup(db, {
        email: body.email,
        password: body.password,
        name: body.name ?? null,
      });
      if (!outcome.ok) {
        // Lost the race against another first-run request.
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "This deployment has already been set up",
        });
      }

      const session = await createSession(db, {
        userId: outcome.user.id,
        authMethod: "password",
        client,
      });
      await recordSignIn(db, outcome.user.id);
      await audit.write({
        action: "setup.completed",
        actor: { id: outcome.user.id, kind: "user" },
        target: { type: "member", id: outcome.user.id, name: outcome.user.email },
        access: { ip: client.ip, client: client.userAgent, sessionId: session.id },
      });

      return reply
        .code(201)
        .send({ user: toPublicUser(outcome.user), sessionId: session.id });
    },
  );

  /** One message for every dead-invite reason. A link that was revoked, one
   *  that expired, and one that was already used are all "this link no longer
   *  works" to the person holding it — and distinguishing them out loud would
   *  tell a stranger which of those a guessed token hit. */
  const INVITE_GONE = "That invitation link is no longer valid. Ask an administrator for a new one.";

  /** `invite.expired` fires from wherever the expiry is first *observed* —
   *  which is a read, not a scheduled sweep, so there is nothing to run. */
  async function auditExpiryOnce(lookup: InviteLookup): Promise<void> {
    if (lookup.ok || !lookup.justExpired || !lookup.invitation) return;
    await audit.write({
      action: "invite.expired",
      actor: { id: null, kind: "system" },
      target: { type: "invite", id: lookup.invitation.id, name: lookup.invitation.email },
    });
  }

  app.post(
    "/auth/invite/preview",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "What an invitation link is for, so the redemption page can show it",
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
      const { token } = request.body as InvitePreviewBody;

      const lookup = await lookupInvitation(db, token);
      if (!lookup.ok) {
        await auditExpiryOnce(lookup);
        return reply
          .code(lookup.reason === "not_found" ? 404 : 410)
          .send({ statusCode: lookup.reason === "not_found" ? 404 : 410, error: "Gone", message: INVITE_GONE });
      }

      // Only what the page needs to render, and nothing about the account it
      // will become. The address is already in the holder's possession.
      return {
        email: lookup.invitation.email,
        role: lookup.invitation.role,
        expiresAt: lookup.invitation.expiresAt.toISOString(),
      };
    },
  );

  app.post(
    "/auth/invite/accept",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "Redeem an invitation: create the account and open a session",
        body: {
          type: "object" as const,
          required: ["token"],
          properties: {
            token: { type: "string" as const, minLength: 1 },
            password: { type: "string" as const, minLength: 1 },
            googleIdToken: { type: "string" as const, minLength: 1 },
            name: { type: "string" as const },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const body = request.body as InviteAcceptBody;
      const client = resolveClientContext(request, undefined, internalSecret);

      let verifiedEmail: string | undefined;
      let provider: { column: "googleId"; id: string } | undefined;

      if (body.googleIdToken) {
        try {
          const profile = await verifyOAuthToken("google", body.googleIdToken);
          if (!profile.email) throw new Error("no verified email");
          verifiedEmail = profile.email;
          provider = { column: "googleId", id: profile.providerId };
        } catch {
          return reply.code(401).send({
            statusCode: 401,
            error: "Unauthorized",
            message: "Google sign-in could not be verified.",
          });
        }
      } else if (body.password) {
        const problem = await validatePassword(body.password, request.log);
        if (problem) {
          return reply
            .code(400)
            .send({ statusCode: 400, error: "Bad Request", message: problem.message });
        }
      } else {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "Choose a password or sign in with Google.",
        });
      }

      const result = await redeemInvitation(db, {
        rawToken: body.token,
        password: body.password,
        verifiedEmail,
        provider,
        name: body.name ?? null,
      });

      if (!result.ok) {
        if (result.reason === "email_mismatch") {
          // Named deliberately: an honest person who signed in with the wrong
          // Google account needs to know which address to use. They already
          // hold the link, so this reveals nothing they didn't have.
          const lookup = await lookupInvitation(db, body.token);
          const invited = lookup.ok ? lookup.invitation.email : "the invited address";
          return reply.code(403).send({
            statusCode: 403,
            error: "Forbidden",
            message: `This invitation is for ${invited}. Sign in with that account to accept it.`,
          });
        }
        return reply
          .code(result.reason === "not_found" ? 404 : 410)
          .send({ statusCode: result.reason === "not_found" ? 404 : 410, error: "Gone", message: INVITE_GONE });
      }

      const session = await createSession(db, {
        userId: result.user.id,
        authMethod: provider ? "google" : "invite",
        client,
      });
      await recordSignIn(db, result.user.id);
      await audit.write({
        action: "invite.redeemed",
        actor: { id: result.user.id, kind: "user" },
        target: { type: "invite", id: result.invitation.id, name: result.invitation.email },
        access: { ip: client.ip, client: client.userAgent, sessionId: session.id },
      });

      return reply
        .code(201)
        .send({ user: toPublicUser(result.user), sessionId: session.id });
    },
  );

  app.post(
    "/auth/password/forgot",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "Request a reset link (managed only — on-prem has no mail server)",
        body: {
          type: "object" as const,
          required: ["email"],
          properties: { email: { type: "string" as const, format: "email" } },
        },
      },
    },
    async (request, reply) => {
      if ((process.env.DEPLOYMENT_MODE ?? config.deploymentMode) !== "managed") {
        // On-prem has nowhere to send it. Saying so is better than accepting
        // the request and silently doing nothing.
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Self-serve password reset is not available on this deployment. Ask an administrator.",
        });
      }
      const db = dbOr503(reply);
      if (!db) return reply;
      const { email } = request.body as ForgotBody;
      const client = resolveClientContext(request, undefined, internalSecret);

      const user = await findUserByEmail(db, email);
      if (user?.passwordHash) {
        const created = await createPasswordReset(db, { userId: user.id, mode: "managed" });
        await audit.write({
          action: "password.reset_requested",
          actor: { id: user.id, kind: "user" },
          access: { ip: client.ip, client: client.userAgent, sessionId: null },
        });
        // TODO(slice: email adapter) — managed delivery. Until the adapter
        // lands the link is logged, which is visible to an operator and to
        // nobody else. It is never returned in the response.
        request.log.warn(
          { resetFor: user.email, expiresAt: created.expiresAt },
          "password reset link generated (no mail transport configured)",
        );
      }

      // Always 202, whether or not the address exists, and whether or not the
      // account has a password at all. Anything else turns this into a way to
      // ask "is this person a member?".
      return reply.code(202).send({ ok: true });
    },
  );

  app.post(
    "/auth/password/reset",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "Set a new password from a reset link. Does not sign anyone in.",
        body: {
          type: "object" as const,
          required: ["token", "password"],
          properties: {
            token: { type: "string" as const, minLength: 1 },
            password: { type: "string" as const, minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const body = request.body as ResetBody;
      const client = resolveClientContext(request, undefined, internalSecret);

      const problem = await validatePassword(body.password, request.log);
      if (problem) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: "Bad Request", message: problem.message });
      }

      const outcome = await consumePasswordReset(db, body.token, body.password);
      if (!outcome.ok) {
        return reply.code(410).send({
          statusCode: 410,
          error: "Gone",
          message: "That reset link is no longer valid. Ask for a new one.",
        });
      }

      await audit.write({
        action: "password.reset_completed",
        actor: { id: outcome.user.id, kind: "user" },
        access: { ip: client.ip, client: client.userAgent, sessionId: null },
      });

      // No session. The person proves the new password works by using it —
      // and a reset link that signs you in is a reset link worth stealing.
      return { ok: true };
    },
  );

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

      // Per-account lockout, checked before the password is even looked at.
      // The per-IP limiter alone is walked past by anyone rotating addresses.
      const lock = await checkLock(db, body.email);
      if (lock.locked) {
        await audit.write({
          action: "signin.blocked",
          actor: { id: null, kind: "user", },
          access: { ip: client.ip, client: client.userAgent, sessionId: null },
          note: "too many failed attempts",
        });
        return reply.code(423).send({
          statusCode: 423,
          error: "Locked",
          message: "Too many failed attempts. Try again later.",
        });
      }

      const user = await findUserByEmail(db, body.email);
      // Identical response for unknown email and wrong password — no
      // account enumeration through the sign-in surface.
      const ok = user?.passwordHash ? await verifyPassword(body.password, user.passwordHash) : false;
      if (!user || !ok) {
        // Counted on the submitted address whether or not it exists, so a
        // lockout says nothing about whether an account is there.
        await recordFailure(db, body.email);
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

      await clearFailures(db, body.email);

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
        if (err instanceof OAuthAccountNotFoundError) {
          // Not 401: the token was fine, the account simply doesn't exist. A
          // person who was never invited should be told that, not left
          // retrying their password.
          return reply
            .code(403)
            .send({ statusCode: 403, error: "Forbidden", message: err.message });
        }
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
