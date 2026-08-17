import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "@sr/db";
import {
  findUserByEmail,
  recordSignIn,
  toPublicUser,
  upsertOAuthUser,
  providerKey,
  OAuthAccountNotFoundError,
  type OAuthProvider,
} from "../services/users.js";
import { validatePassword, verifyPasswordOrDecoy } from "../services/password.js";
import { verifyOAuthToken } from "../services/oauth.js";
import { createSession, revokeSession, type ClientContext } from "../services/sessions.js";
import {
  lookupInvitation,
  redeemInvitation,
  type InviteLookup,
} from "../services/invitations.js";
import { consumePasswordReset } from "../services/password-reset.js";
import { clearFailures, lockedReply, recordAttempt } from "../services/lockout.js";
import { lazyAuditWriter, type AuditWriter } from "../services/audit.js";
import {
  completeSetup,
  needsSetup,
  resolveSetupToken,
  setupTokenMatches,
} from "../services/setup.js";
import { requireAuth } from "../plugins/auth.js";
import { config, deploymentMode } from "../config.js";

/** Tighter per-IP limit on the credential surface than the global default. */
/** Per-IP limit for every route that tests a credential. Exported because
 *  changing your password tests one too — the current password. */
export const STRICT_AUTH_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

/** Every email a request carries. 254 is the RFC 5321 ceiling, under the
 *  `varchar(255)` every email column uses, so an over-long address is a 400
 *  here rather than a failed INSERT — sign-in's lockout records any address. */
export const EMAIL_FIELD = { type: "string" as const, format: "email", maxLength: 254 };

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
  /** Redeeming with a social account: which provider, and its token. Every
   *  provider the deployment offers, not just Google — with OAuth sign-in now
   *  link-only, redemption is the ONLY way a social account comes to exist,
   *  so a provider missing here is a provider nobody can ever sign in with. */
  oauthProvider?: OAuthProvider;
  oauthToken?: string;
  name?: string;
}

const OAUTH_PROVIDERS = ["google", "github", "discord"] as const;

/** For error copy, so a failed GitHub redemption doesn't say "Google". */
const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
  discord: "Discord",
};

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
/** The IP and User-Agent an event is attributed to — this request's, or the
 *  browser's own when our web tier forwards it with the internal secret. */
export function resolveClientContext(
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
      return { needsSetup: await needsSetup(db), mode: deploymentMode() };
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
            email: EMAIL_FIELD,
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

      // No session is opened here, deliberately. The web signs the new admin
      // in straight afterwards through the ordinary credentials path — it has
      // no way to hand an api-minted session to Auth.js — so a session opened
      // now is one nobody ever presents: a row that outlives setup by its full
      // TTL and shows up in Active Sessions as a device the admin never used.
      // The account exists and its password is known to the person who just
      // typed it; that is what "signed in afterwards" rests on.
      await audit.write({
        action: "setup.completed",
        actor: { id: outcome.user.id, kind: "user" },
        target: { type: "member", id: outcome.user.id, name: outcome.user.email },
        access: { ip: client.ip, client: client.userAgent, sessionId: null },
      });

      return reply.code(201).send({ user: toPublicUser(outcome.user) });
    },
  );

  /** One message for every dead-invite reason. A link that was revoked, one
   *  that expired, and one that was already used are all "this link no longer
   *  works" to the person holding it — and distinguishing them out loud would
   *  tell a stranger which of those a guessed token hit. */
  const INVITE_GONE = "That invitation link is no longer valid. Ask an administrator for a new one.";

  /**
   * One reply for every dead invitation — one message AND one status.
   *
   * The message was already uniform. The status was not: `not_found` answered
   * 404 and the rest 410, which told a stranger exactly what the uniform
   * message was there to withhold — whether a guessed token had hit a real
   * invitation. 410 for all of them: as far as the holder of a link is
   * concerned, "never existed" and "no longer works" are the same event.
   */
  function replyInviteGone(reply: FastifyReply) {
    return reply
      .code(410)
      .send({ statusCode: 410, error: "Gone", message: INVITE_GONE });
  }

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
        return replyInviteGone(reply);
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
            oauthProvider: { type: "string" as const, enum: [...OAUTH_PROVIDERS] },
            oauthToken: { type: "string" as const, minLength: 1 },
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
      let provider: { column: ReturnType<typeof providerKey>; id: string } | undefined;
      const oauthProvider = body.oauthToken ? body.oauthProvider : undefined;

      if (body.oauthToken && !oauthProvider) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "Say which provider that token is from.",
        });
      }

      if (oauthProvider && body.oauthToken) {
        try {
          const profile = await verifyOAuthToken(oauthProvider, body.oauthToken);
          if (!profile.email) throw new Error("no verified email");
          verifiedEmail = profile.email;
          provider = { column: providerKey(oauthProvider), id: profile.providerId };
        } catch {
          return reply.code(401).send({
            statusCode: 401,
            error: "Unauthorized",
            message: `${PROVIDER_LABEL[oauthProvider]} sign-in could not be verified.`,
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
          message: "Choose a password, or accept with a linked account.",
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
        return replyInviteGone(reply);
      }

      // A session is opened for the OAuth path and only for it, and the
      // asymmetry is the point rather than an oversight.
      //
      // The Google caller is the web tier finishing a sign-in it cannot start
      // again: it holds a one-shot id_token, not a password, so there is no
      // second round-trip to fall back on and the session has to come from
      // here. The password caller is a browser that is about to sign in the
      // ordinary way a moment later with credentials it just chose — a session
      // minted here would be one nobody ever presents, exactly the stray row
      // `/auth/setup` stopped creating.
      const session =
        provider && oauthProvider
          ? await createSession(db, {
              userId: result.user.id,
              authMethod: oauthProvider,
              client,
            })
          : null;
      if (session) await recordSignIn(db, result.user.id);
      await audit.write({
        action: "invite.redeemed",
        actor: { id: result.user.id, kind: "user" },
        target: { type: "invite", id: result.invitation.id, name: result.invitation.email },
        access: { ip: client.ip, client: client.userAgent, sessionId: session?.id ?? null },
      });

      return reply.code(201).send({
        user: toPublicUser(result.user),
        ...(session ? { sessionId: session.id } : {}),
      });
    },
  );

  app.post(
    "/auth/password/forgot",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "Self-serve reset — not available until email delivery exists (MAG-2870)",
        body: {
          type: "object" as const,
          required: ["email"],
          properties: { email: EMAIL_FIELD },
        },
      },
    },
    async (_request, reply) => {
      // There is no way to deliver a link — email is MAG-2870 — so this fails
      // closed, the same on every deployment and for every address. Issuing one
      // would look delivered while reaching nobody, and would invalidate any
      // live link the member already holds.
      return reply.code(404).send({
        statusCode: 404,
        error: "Not Found",
        message: "Self-serve password reset is not available on this deployment. Ask an administrator.",
      });
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

      // The link is a bearer credential, so who used it is unknowable; who
      // generated it is not, and that is what an auditor needs to connect an
      // admin-issued link to its redemption.
      await audit.write({
        action: "password.reset_completed",
        actor: { id: outcome.user.id, kind: "user" },
        access: { ip: client.ip, client: client.userAgent, sessionId: null },
        note: outcome.createdBy
          ? `redeemed a link generated by admin ${outcome.createdBy}`
          : "redeemed a self-serve link",
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
            email: EMAIL_FIELD,
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

      // Spend the attempt BEFORE the password is looked at. Counting first is
      // what keeps a parallel burst inside the per-account budget; a correct
      // password refunds it below.
      const attempt = await recordAttempt(db, body.email);
      if (attempt.locked) {
        const target = await findUserByEmail(db, body.email);
        await audit.write({
          action: "signin.blocked",
          actor: { id: null, kind: "user" },
          ...(target ? { target: { type: "member" as const, id: target.id, name: target.email } } : {}),
          access: { ip: client.ip, client: client.userAgent, sessionId: null },
          note: `${attempt.attempts} attempts on ${body.email.toLowerCase()} this window`,
        });
        const locked = lockedReply(attempt.until);
        if (locked.retryAfterSec) reply.header("Retry-After", String(locked.retryAfterSec));
        return reply.code(423).send({ statusCode: 423, error: "Locked", message: locked.message });
      }

      const user = await findUserByEmail(db, body.email);
      // Identical response for unknown email and wrong password — and identical
      // cost: the decoy runs one bcrypt when there is no hash, so the timing
      // doesn't answer the question the response refuses to.
      const ok = await verifyPasswordOrDecoy(body.password, user?.passwordHash);
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
