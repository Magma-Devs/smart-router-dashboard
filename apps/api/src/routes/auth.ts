import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database, User } from "@sr/db";
import { findUserByEmail, recordSignIn, toPublicUser } from "../services/users.js";
import { validatePassword, verifyPassword } from "../services/password.js";
import { createSession, revokeSession, type ClientContext } from "../services/sessions.js";
import { normalizeIp, parseClient } from "../services/client-context.js";
import { lookupInvitation, redeemInvitation, type InviteLookup } from "../services/invitations.js";
import {
  consumePasswordReset,
  createPasswordReset,
  lookupPasswordReset,
  resetUrl,
  RESET_TTL_MS,
} from "../services/password-reset.js";
import { checkLock, clearFailures, recordFailure } from "../services/lockout.js";
import {
  consumeChallenge,
  consumeCode,
  isEnrolled,
  issueChallenge,
} from "../services/two-factor.js";
import { lazyAuditWriter, type AuditWriter } from "../services/audit.js";
import { sendPasswordResetEmail } from "../services/email-templates.js";
import { EMAIL_DELIVERY_NOTES } from "@sr/shared";
import {
  completeSetup,
  needsSetup,
  resolveSetupToken,
  setupTokenMatches,
} from "../services/setup.js";
import { requireAuth } from "../plugins/auth.js";
import { config } from "../config.js";

/**
 * Tighter per-IP limit on the credential surface than the global default.
 *
 * Keyed on the **browser's** address, not the connection's. Auth.js calls
 * `/auth/sign-in` and `/auth/2fa/verify` from the web tier, so keying on
 * `request.ip` would put every person in the deployment in one bucket of ten a
 * minute — and two-factor roughly doubles the calls a sign-in costs, so a team
 * signing in together would lock each other out of the code screen. Falls back
 * to the connection address, which is what a direct caller gets.
 */
function strictAuthRateLimit(internalSecret: string | undefined) {
  return {
    max: 10,
    timeWindow: "1 minute",
    keyGenerator: (request: FastifyRequest) =>
      forwardedClientIp(request, internalSecret) ?? request.ip,
  } as const;
}

/** One message for every dead reset link. MAG-2870: "The same message for both
 *  cases. Telling someone a link was already used also tells an attacker it was
 *  already used." */
const RESET_GONE = "This link has expired.";

interface SignInBody {
  email: string;
  password: string;
  /** Check the password and report which step comes next, without opening a
   *  session. The login form asks first — it has to know whether to show the
   *  code screen — and Auth.js signs in afterwards through this same route.
   *  Without it that pair of calls opens two sessions for one sign-in. */
  probe?: boolean;
}

interface TwoFactorVerifyBody {
  challenge: string;
  code: string;
}

interface InvitePreviewBody {
  token: string;
}

interface InviteAcceptBody {
  token: string;
  password: string;
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

/** Constant-time comparison that doesn't leak length through early return. */
function secretsMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * What the caller looks like, in the two shapes that need it.
 *
 * `raw` goes to `createSession`, which parses and normalises on the way in.
 * `access` is the audit shape and is **already** parsed and normalised — the
 * `client` column is a 128-char device string, not a raw User-Agent, and `ip`
 * is `inet`.
 *
 * Both live here rather than being derived at each emission site because
 * getting it wrong is invisible: a standalone audit write that throws is
 * swallowed by contract, so an over-long User-Agent doesn't fail the request,
 * it silently deletes the row. Most real browsers exceed 128 characters, so
 * that lands as "Mac Chrome users are logged and iPhone users aren't" — a log
 * that looks healthy while missing most of its rows.
 */
interface ResolvedClient extends ClientContext {
  access: { ip: string | null; client: string | null };
}

/** Set by the web tier beside `X-Internal-Auth`, and believed only with it.
 *  Headers rather than a body field because the rate limiter runs in
 *  `onRequest`, before a body exists, and it has to key on the same address
 *  this records — otherwise every sign-in in the deployment shares one bucket. */
export const FORWARDED_IP_HEADER = "x-forwarded-client-ip";
export const FORWARDED_UA_HEADER = "x-forwarded-client-ua";

/** The forwarded address, or null when nothing vouches for one. Shared with the
 *  rate limiter so the two cannot disagree about who is calling. */
export function forwardedClientIp(
  request: FastifyRequest,
  expected: string | undefined,
): string | null {
  if (!expected) return null;
  const supplied = request.headers["x-internal-auth"];
  if (typeof supplied !== "string" || !secretsMatch(supplied, expected)) return null;
  const ip = request.headers[FORWARDED_IP_HEADER];
  return typeof ip === "string" && ip ? ip : null;
}

/**
 * Decide what to record as the caller's device.
 *
 * The browser never reaches `/auth/sign-in` directly — Auth.js calls it from
 * the web tier — so `request.ip` here is the web pod and the User-Agent is
 * undici's. The web forwards what *it* saw, and this decides whether to believe
 * it: only alongside the shared internal secret, otherwise we record what we
 * observed, which for a direct caller is their own real address. The route is
 * publicly reachable, so without that gate anyone could write a false trail.
 */
function resolveClientContext(
  request: FastifyRequest,
  expected: string | undefined,
): ResolvedClient {
  const withAccess = (raw: ClientContext): ResolvedClient => ({
    ...raw,
    access: { ip: normalizeIp(raw.ip), client: parseClient(raw.userAgent) },
  });

  const observed: ClientContext = {
    ip: request.ip ?? null,
    userAgent: request.headers["user-agent"] ?? null,
  };

  const forwardedIp = forwardedClientIp(request, expected);
  const suppliedIp = request.headers[FORWARDED_IP_HEADER];
  if (!forwardedIp) {
    // Sent but not believed: either no secret is configured on this side, or
    // the caller could not produce it. Worth a line either way — the first is a
    // deployment recording its own address against every sign-in.
    if (typeof suppliedIp === "string" && suppliedIp) {
      request.log.warn("forwarded client address supplied without a valid internal secret");
    }
    return withAccess(observed);
  }

  const forwardedUa = request.headers[FORWARDED_UA_HEADER];
  return withAccess({
    ip: forwardedIp,
    userAgent: typeof forwardedUa === "string" && forwardedUa ? forwardedUa : observed.userAgent,
  });
}

/**
 * Registered ONLY when AUTH_MODE=enabled:
 *
 *  - POST /auth/sign-in          : email + password → { user, sessionId }
 *  - POST /auth/sign-out         : revoke the calling session
 *
 * Email and password is the only way in — the ticket is explicit ("that is the
 * only way in"), and social sign-in was removed rather than left configurable.
 * A personal Google/GitHub/Discord account sits outside the customer's IT
 * control, so when someone leaves their company that account keeps working; the
 * gap SSO exists to close is the one social login reopens. SSO arrives as its
 * own task when a customer asks for it.
 *
 * Sign-in is consumed by the web's Auth.js credentials callback — the browser
 * never calls it directly. It opens a session row and returns its id, which the
 * web puts in the token's `sid` claim; the api resolves it on every subsequent
 * request. Creating the session here (rather than in a register call afterwards)
 * is what lets it commit in the same breath as the sign-in and carry the
 * browser's own address. See `docs/ACCOUNTS-DESIGN.md` §5.2.
 *
 * Accounts come into existence in exactly two places: first-run setup, and
 * invite redemption. There is no self-serve sign-up.
 */
export async function authRoutes(app: FastifyInstance) {
  const audit: AuditWriter = lazyAuditWriter(app);
  // Read from the live env at register time, not from the config snapshot —
  // that is taken at module load, before a test (or a late-loaded secrets file)
  // can set it. Same reason the auth plugin re-reads AUTH_SECRET.
  const internalSecret = process.env.INTERNAL_AUTH_SECRET ?? config.auth.internalSecret;
  const STRICT_AUTH_RATE_LIMIT = strictAuthRateLimit(internalSecret);

  /**
   * Everything that happens once a sign-in is genuinely complete.
   *
   * Both paths end here — an account with no authenticator finishes at
   * `/auth/sign-in`, an enrolled one at `/auth/2fa/verify` — and the point of
   * one function is that the session row, the sign-in stamp and the
   * `signin.succeeded` row cannot fall out of step between them. `authMethod`
   * is what tells the two apart afterwards, on the account's own sessions list.
   */
  async function completeSignIn(
    db: Database,
    user: User,
    client: ResolvedClient,
    authMethod: "password" | "password+totp",
  ) {
    // Cleared HERE and nowhere else, and that placement is the whole point.
    //
    // It used to sit at the end of the password check, which was correct while
    // the password was the only factor. With a second one it is a hole: an
    // attacker holding a correct password would reset the counter on every
    // attempt, so five wrong codes could never accumulate and the per-account
    // lockout would simply never trip for them — against exactly the person it
    // most needs to stop. A failure counter for sign-ins clears when a sign-in
    // succeeds, and a sign-in has not succeeded until both factors have passed.
    // One transaction, because these four are one event. A session row whose
    // signin.succeeded never landed is a device with no record of arriving,
    // which is the row an investigation goes looking for; and the id is handed
    // to the web to sign into a token, so it must not name a session a later
    // failure rolled back. The writer propagates rather than swallows when it
    // is given a transaction, so a failed audit write takes the sign-in with it.
    return db.transaction(async (tx) => {
      await clearFailures(tx, user.email);

      const session = await createSession(tx, { userId: user.id, authMethod, client });
      await recordSignIn(tx, user.id);
      await audit.write(
        {
          action: "signin.succeeded",
          actor: { id: user.id, kind: "user" },
          access: { ...client.access, sessionId: session.id },
        },
        tx,
      );
      return { user: toPublicUser(user), sessionId: session.id };
    });
  }

  /** The db plugin connects lazily; 503 (not 500) while it settles. */
  function dbOr503(reply: FastifyReply): Database | null {
    if (!app.db) {
      void reply.code(503).send({
        statusCode: 503,
        error: "Service Unavailable",
        message: "auth database not ready",
      });
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
      const client = resolveClientContext(request, internalSecret);

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
        request.log.warn({ ip: client.ip }, "first-run setup attempted with an incorrect token");
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
        // Managed only. On a deployment we host, this page is run by a Magma
        // operator and the account it creates stays after handover — so it is
        // marked, and the member list shows it as ours rather than leaving an
        // admin nobody on the customer's side recognises. On-prem the same page
        // creates the customer's own first admin; there is no Magma account.
        //
        // Read from the live env: `config` snapshots at module load.
        isMagmaAccount: (process.env.DEPLOYMENT_MODE ?? config.deploymentMode) === "managed",
      });
      if (!outcome.ok) {
        // Lost the race against another first-run request.
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "This deployment has already been set up",
        });
      }

      // Deliberately opens NO session.
      //
      // It used to, and returned the id — but the web ignores it and signs in
      // through Auth.js with the password just typed, which opens a second one.
      // Every first run therefore left a session nobody had ever used, alive for
      // its full thirty days, showing up on the operator's own "active sessions"
      // list as a device they did not recognise. On the one screen whose job is
      // spotting a session that should not be there, that is the worst possible
      // noise.
      //
      // Nobody is locked out by this: creating the account is followed by an
      // ordinary sign-in, and `setup-routes.test.ts` asserts exactly that.
      await audit.write({
        action: "setup.completed",
        actor: { id: outcome.user.id, kind: "user" },
        target: { type: "member", id: outcome.user.id, name: outcome.user.email },
        // No session id — there is no session yet. The address and the device
        // are what make this row worth reading, and both survive.
        access: { ...client.access, sessionId: null },
      });

      return reply.code(201).send({ user: toPublicUser(outcome.user) });
    },
  );

  /** One message for every dead-invite reason. A link that was revoked, one
   *  that expired, and one that was already used are all "this link no longer
   *  works" to the person holding it — and distinguishing them out loud would
   *  tell a stranger which of those a guessed token hit. */
  const INVITE_GONE =
    "That invitation link is no longer valid. Ask an administrator for a new one.";

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
        return reply.code(lookup.reason === "not_found" ? 404 : 410).send({
          statusCode: lookup.reason === "not_found" ? 404 : 410,
          error: "Gone",
          message: INVITE_GONE,
        });
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
          required: ["token", "password"],
          properties: {
            token: { type: "string" as const, minLength: 1 },
            password: { type: "string" as const, minLength: 1 },
            name: { type: "string" as const },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const body = request.body as InviteAcceptBody;
      const client = resolveClientContext(request, internalSecret);

      const problem = await validatePassword(body.password, request.log);
      if (problem) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: "Bad Request", message: problem.message });
      }

      const result = await redeemInvitation(db, {
        rawToken: body.token,
        password: body.password,
        name: body.name ?? null,
      });

      if (!result.ok) {
        return reply.code(result.reason === "not_found" ? 404 : 410).send({
          statusCode: result.reason === "not_found" ? 404 : 410,
          error: "Gone",
          message: INVITE_GONE,
        });
      }

      // No session opened here either — same reason as first-run setup above.
      // The page signs in with the password just chosen, and that sign-in is the
      // one real session. Opening one here as well left every redeemed
      // invitation showing two devices on the new member's account page, one of
      // which they had never used.
      //
      // No access context: the catalog files this under people, not access.
      // Defensible — "this invitation became an account" is complete without an
      // address, and the sign-in it implies is recorded separately.
      await audit.write({
        action: "invite.redeemed",
        actor: { id: result.user.id, kind: "user" },
        target: { type: "invite", id: result.invitation.id, name: result.invitation.email },
      });

      return reply.code(201).send({ user: toPublicUser(result.user) });
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
          message:
            "Self-serve password reset is not available on this deployment. Ask an administrator.",
        });
      }
      const db = dbOr503(reply);
      if (!db) return reply;
      const origin = process.env.PUBLIC_WEB_ORIGIN ?? config.publicWebOrigin;
      if (!origin) {
        // Loud rather than a link to nowhere. Managed mode cannot function
        // without this, and a reset email carrying a broken host is worse than
        // no email: the person stops trying.
        request.log.error("PUBLIC_WEB_ORIGIN is not set — cannot build a password-reset link");
        return reply.code(500).send({
          statusCode: 500,
          error: "Internal Server Error",
          message: "PUBLIC_WEB_ORIGIN is not configured, so reset links cannot be built",
        });
      }
      const { email } = request.body as ForgotBody;
      const client = resolveClientContext(request, internalSecret);

      const user = await findUserByEmail(db, email);
      if (user?.passwordHash) {
        const created = await createPasswordReset(db, { userId: user.id, mode: "managed" });
        const hours = Math.max(1, Math.round(RESET_TTL_MS.managed / 3_600_000));
        const { delivery } = await sendPasswordResetEmail(
          {
            to: user.email,
            resetUrl: resetUrl(origin, created.rawToken),
            expiresInHours: hours,
          },
          (msg, ctx) => request.log.warn(ctx ?? {}, msg),
        );
        // Unlike an invitation, a failed reset has nowhere to fall back to:
        // there is no admin in this flow to hand the link to, and returning it
        // in the response would let anybody mint a reset for any address. The
        // note is the only record, which is exactly why it is a note.
        await audit.write({
          action: "password.reset_requested",
          actor: { id: user.id, kind: "user" },
          access: { ...client.access, sessionId: null },
          note: EMAIL_DELIVERY_NOTES[delivery],
        });
      }

      // Always 202, whether or not the address exists, and whether or not the
      // account has a password at all. Anything else turns this into a way to
      // ask "is this person a member?".
      return reply.code(202).send({ ok: true });
    },
  );

  app.post(
    "/auth/password/reset/preview",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "What a reset link is for — the address it changes. Does not spend it",
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
      const { token } = request.body as { token: string };

      const lookup = await lookupPasswordReset(db, token);
      if (!lookup.ok) {
        // One answer for used, expired, never-issued and belonging to a removed
        // account. MAG-2870 asks for the same message on both of the two the
        // holder can distinguish, and the reason generalises: telling them
        // apart tells a stranger which of them a guessed token hit.
        return reply.code(410).send({ statusCode: 410, error: "Gone", message: RESET_GONE });
      }

      // The address only. Not the name, not the role — the page needs to say
      // which account is being changed, and nothing else.
      return { email: lookup.user.email };
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
      const client = resolveClientContext(request, internalSecret);

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
        access: { ...client.access, sessionId: null },
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
            probe: {
              type: "boolean" as const,
              description:
                "Verify the password and report whether a code is needed, without opening a session.",
            },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const body = request.body as SignInBody;
      const client = resolveClientContext(request, internalSecret);

      // Per-account lockout, checked before the password is even looked at.
      // The per-IP limiter alone is walked past by anyone rotating addresses.
      const lock = await checkLock(db, body.email);
      if (lock.locked) {
        await audit.write({
          action: "signin.blocked",
          // Named. A lockout row that doesn't say which account was locked
          // can't be acted on, and the address is right here.
          actor: { id: null, kind: "user", label: body.email, email: body.email },
          access: { ...client.access, sessionId: null },
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
      const ok = user?.passwordHash
        ? await verifyPassword(body.password, user.passwordHash)
        : false;
      if (!user || !ok) {
        // Counted on the submitted address whether or not it exists, so a
        // lockout says nothing about whether an account is there.
        await recordFailure(db, body.email);
        await audit.write({
          action: "signin.failed",
          // `label` carries the typed address when no account backs it. Without
          // it you cannot tell a typo from a run of guesses across a list of
          // addresses — the investigation this row exists for.
          actor: { id: user?.id ?? null, kind: "user", label: body.email, email: body.email },
          access: { ...client.access, sessionId: null },
          note: user ? "wrong password" : "unknown address",
        });
        return reply
          .code(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Invalid email or password" });
      }

      // The password was right. If this account has an authenticator, that is
      // as far as this request goes: it returns a challenge and **no session**.
      //
      // No session is the security property, not an implementation detail. The
      // auth plugin refuses any token whose `sid` resolves to nothing, so there
      // is no shape a half-authenticated caller can take — as opposed to
      // opening the session now and hanging a `pending` flag off it, where
      // every route's correctness would rest on remembering to read the flag.
      //
      // Nothing is written to the audit log here. `signin.succeeded` would be a
      // lie about a sign-in that has not happened, and the log's own vocabulary
      // has no half-way event — deliberately. A code that then fails writes
      // `signin.failed`, which is the row an investigation wants: a run of
      // those against one account is somebody holding a correct password.
      if (isEnrolled(user)) {
        const challenge = await issueChallenge(db, user.id);
        return {
          twoFactorRequired: true,
          challenge: challenge.token,
          expiresAt: challenge.expiresAt.toISOString(),
        };
      }

      // A probe stops here. The login form asks this route what the next step
      // is before handing the sign-in to Auth.js, which calls this same route
      // again — so completing here would open a session the browser never
      // addresses, leaving an unused device on the account's own sessions list
      // and two `signin.succeeded` rows, one of them from an address nobody
      // signed in from. Only accounts without an authenticator reach this line,
      // which is why the enrolled path above never had the problem.
      if (body.probe) return { twoFactorRequired: false };

      return completeSignIn(db, user, client, "password");
    },
  );

  app.post(
    "/auth/2fa/verify",
    {
      config: { rateLimit: STRICT_AUTH_RATE_LIMIT },
      schema: {
        tags: ["Auth"],
        summary: "Second step: spend a challenge with a 6-digit code and open the session",
        body: {
          type: "object" as const,
          required: ["challenge", "code"],
          properties: {
            challenge: { type: "string" as const, minLength: 1 },
            code: { type: "string" as const, minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const body = request.body as TwoFactorVerifyBody;
      const client = resolveClientContext(request, internalSecret);

      /** One message for every way this can fail. The ticket: "a wrong code
       *  gives a generic error with no hint about which factor failed" — and
       *  that has to cover a dead challenge too, since "your challenge expired"
       *  versus "wrong code" is itself the hint. */
      const refuse = () =>
        reply
          .code(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Invalid email or password" });

      // Spent before the code is checked, on purpose: a challenge that survived
      // a wrong code would let someone try code after code against a single
      // password verification, which is the exact thing the second factor is
      // there to stop. A wrong code costs a fresh sign-in.
      const claimed = await consumeChallenge(db, body.challenge);
      if (!claimed.ok) return refuse();

      const email = claimed.user.email;

      // Same wall as the password. Deliberately the SAME counter, keyed on the
      // same address — a second counter would quietly hand an attacker five
      // password attempts and then five code attempts.
      const lock = await checkLock(db, email);
      if (lock.locked) {
        await audit.write({
          action: "signin.blocked",
          actor: { id: claimed.user.id, kind: "user", label: email, email },
          access: { ...client.access, sessionId: null },
          note: "too many failed attempts",
        });
        return reply.code(423).send({
          statusCode: 423,
          error: "Locked",
          message: "Too many failed attempts. Try again later.",
        });
      }

      const outcome = await consumeCode(db, claimed.user, body.code);
      if (!outcome.ok) {
        const lockState = await recordFailure(db, email);
        await audit.write({
          action: "signin.failed",
          actor: { id: claimed.user.id, kind: "user", label: email, email },
          access: { ...client.access, sessionId: null },
          // The one place the distinction is recorded. A run of these against
          // one account means somebody holds a correct password, which reads
          // very differently from a run of "wrong password".
          note: "wrong two-factor code",
        });
        if (lockState.locked) {
          await audit.write({
            action: "signin.blocked",
            actor: { id: claimed.user.id, kind: "user", label: email, email },
            access: { ...client.access, sessionId: null },
            note: "too many failed attempts",
          });
        }
        return refuse();
      }

      return completeSignIn(db, claimed.user, client, "password+totp");
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
