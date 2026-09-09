import { timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database, User } from "@sr/db";
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
import { normalizeIp, parseClient } from "../services/client-context.js";
import {
  lookupInvitation,
  redeemInvitation,
  type InviteLookup,
  type RedeemResult,
} from "../services/invitations.js";
import {
  consumePasswordReset,
  createPasswordReset,
  lookupPasswordReset,
  resetUrl,
  RESET_TTL_MS,
  selfServeResetIsCoolingDown,
} from "../services/password-reset.js";
import {
  clearFailures,
  lockedReply,
  recordAttempt,
  refundAttempt,
} from "../services/lockout.js";
import {
  consumeChallenge,
  consumeCode,
  isEnrolled,
  issueChallenge,
  type FirstFactor,
} from "../services/two-factor.js";
import { lazyAuditWriter, type AuditWriter } from "../services/audit.js";
import { sendPasswordResetEmail } from "../services/email-templates.js";
import { emailTransportConfigured } from "../services/email.js";
import { RESET_REQUEST_COOLING_DOWN_NOTE, RESET_REQUEST_NOTES } from "@sr/shared";
import {
  completeSetup,
  needsSetup,
  resolveSetupToken,
  setupTokenMatches,
} from "../services/setup.js";
import { requireAuth } from "../plugins/auth.js";
import { config, deploymentMode, publicWebOrigin } from "../config.js";

/** Per-IP limit for a route that tests a credential, keyed on the connection.
 *  Exported for the routes the browser calls directly — changing your password
 *  tests one too, the current password. The routes here use
 *  {@link strictAuthRateLimit}, which keys on the browser behind the web tier. */
export const STRICT_AUTH_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

/**
 * The same limit, keyed on the **browser's** address rather than the
 * connection's.
 *
 * Auth.js calls `/auth/sign-in`, `/auth/2fa/verify` and `/auth/oauth/:provider`
 * from the web tier, so keying on `request.ip` would put every person in the
 * deployment in one bucket of ten a minute — and two-factor roughly doubles the
 * calls a sign-in costs, so a team signing in together would lock each other out
 * of the code screen. Falls back to the connection address, which is what a
 * direct caller gets.
 */
function strictAuthRateLimit(internalSecret: string | undefined) {
  return {
    max: 10,
    timeWindow: "1 minute",
    keyGenerator: (request: FastifyRequest) =>
      forwardedClientIp(request, internalSecret) ?? request.ip,
  } as const;
}

/** Every email a request carries. 254 is the RFC 5321 ceiling, under the
 *  `varchar(255)` every email column uses, so an over-long address is a 400
 *  here rather than a failed INSERT — sign-in's lockout records any address. */
export const EMAIL_FIELD = { type: "string" as const, format: "email", maxLength: 254 };

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
  password?: string;
  /** Redeeming with a social account: which provider, and its token. Every
   *  provider the deployment offers, not just Google — with OAuth sign-in now
   *  link-only, redemption is the ONLY way a social account comes to exist,
   *  so a provider missing here is a provider nobody can ever sign in with. */
  oauthProvider?: OAuthProvider;
  oauthToken?: string;
  name?: string;
}

const OAUTH_PROVIDERS = ["google", "github"] as const;

/** For error copy, so a failed GitHub redemption doesn't say "Google". */
const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
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
export interface ResolvedClient extends ClientContext {
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
 * The browser never reaches the session-opening routes directly — Auth.js
 * calls them from the web tier — so `request.ip` there is the web pod and the
 * User-Agent is undici's. The web forwards what *it* saw, and this decides
 * whether to believe it: only alongside the shared internal secret, otherwise we
 * record what we observed, which for a direct caller is their own real address.
 * The routes are publicly reachable, so without that gate anyone could write a
 * false trail.
 */
export function resolveClientContext(
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
  if (!forwardedIp) {
    // Sent but not believed: either no secret is configured on this side, or
    // the caller could not produce it. Worth a line either way — the first is a
    // deployment recording its own address against every sign-in.
    const suppliedIp = request.headers[FORWARDED_IP_HEADER];
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
 * Registered ONLY when AUTH_MODE=enabled. Three routes open a session, and the
 * web's Auth.js callbacks are what call them:
 *
 *  - POST /auth/sign-in          : email + password → { user, sessionId }
 *  - POST /auth/oauth/:provider  : provider token (verified server-side)
 *                                  → the account it is linked to
 *  - POST /auth/invite/accept    : with a provider token, redeems and signs in.
 *                                  A password redemption comes from the
 *                                  browser, opens no session, and signs in
 *                                  through /auth/sign-in afterwards.
 *
 * Each returns the session's id, which the web puts in the token's `sid`
 * claim; the api resolves it on every subsequent request. Creating the session
 * here (rather than in a register call afterwards) is what lets it commit in
 * the same breath as the sign-in and carry the browser's own address. See
 * `docs/ACCOUNTS-DESIGN.md` §5.2.
 *
 * No self-serve sign-up: an account comes from first-run setup or an
 * invitation. OAuth links to an existing account and never creates one.
 */
export async function authRoutes(app: FastifyInstance) {
  const audit: AuditWriter = lazyAuditWriter(app);
  // Read from the live env at register time, not from the config snapshot —
  // that is taken at module load, before a test (or a late-loaded secrets file)
  // can set it. Same reason the auth plugin re-reads AUTH_SECRET.
  const internalSecret = process.env.INTERNAL_AUTH_SECRET ?? config.auth.internalSecret;
  const strictLimit = strictAuthRateLimit(internalSecret);

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
    authMethod: "password" | `${FirstFactor}+totp`,
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
    await clearFailures(db, user.email);

    const session = await createSession(db, { userId: user.id, authMethod, client });
    await recordSignIn(db, user.id);
    await audit.write({
      action: "signin.succeeded",
      actor: { id: user.id, kind: "user" },
      access: { ...client.access, sessionId: session.id },
    });
    return { user: toPublicUser(user), sessionId: session.id };
  }

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
      config: { rateLimit: strictLimit },
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
        access: { ...client.access, sessionId: null },
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

  /** `invite.expired` fires from wherever the expiry is first *observed* — a
   *  preview, a redemption attempt, or the admin's Invites list — which is a
   *  read, not a scheduled sweep, so there is nothing to run. */
  async function auditExpiryOnce(lookup: InviteLookup | RedeemResult): Promise<void> {
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
      config: { rateLimit: strictLimit },
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
      config: { rateLimit: strictLimit },
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
      const client = resolveClientContext(request, internalSecret);

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
        await auditExpiryOnce(result);
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
        access: { ...client.access, sessionId: session?.id ?? null },
      });
      // The session is a sign-in like any other, and the sessions list shows
      // it. Without this row the log has a session nobody signed in to.
      if (session) {
        await audit.write({
          action: "signin.succeeded",
          actor: { id: result.user.id, kind: "user" },
          access: { ...client.access, sessionId: session.id },
        });
      }

      return reply.code(201).send({
        user: toPublicUser(result.user),
        ...(session ? { sessionId: session.id } : {}),
      });
    },
  );

  app.post(
    "/auth/password/forgot",
    {
      config: { rateLimit: strictLimit },
      schema: {
        tags: ["Auth"],
        summary: "Request a reset link by email — managed deployments with a mail transport only",
        body: {
          type: "object" as const,
          required: ["email"],
          properties: { email: EMAIL_FIELD },
        },
      },
    },
    async (request, reply) => {
      if (deploymentMode() !== "managed" || !emailTransportConfigured()) {
        // Fails closed wherever nothing can deliver the link: on-prem never has
        // mail, and a managed deployment whose transport is not wired up would
        // issue a link that reaches nobody — logging it instead — and invalidate
        // any live link the member already holds. Saying so beats accepting
        // silently.
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message:
            "Self-serve password reset is not available on this deployment. Ask an administrator.",
        });
      }
      const db = dbOr503(reply);
      if (!db) return reply;
      const origin = publicWebOrigin();
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
      const { email } = request.body as { email: string };
      const client = resolveClientContext(request, internalSecret);

      // Always 202, whether or not the address exists, and whether or not the
      // account has a password at all — anything else turns this into a way to
      // ask "is this person a member?". And the answer leaves BEFORE the address
      // is looked up: an account costs a lookup, two writes and an SES round
      // trip, an unknown address one SELECT, so answering afterwards would say
      // the same thing through how long it took.
      await reply.code(202).send({ ok: true });

      try {
        await issueSelfServeReset(email, origin, client.access, request.log);
      } catch (err) {
        // Nobody is waiting on the response any more, so this is the only
        // place the failure can go.
        request.log.error({ err }, "self-serve password reset failed after answering 202");
      }
      return reply;
    },
  );

  /** The work behind `/auth/password/forgot`, done after it has answered. */
  async function issueSelfServeReset(
    email: string,
    origin: string,
    access: ResolvedClient["access"],
    log: FastifyBaseLogger,
  ): Promise<void> {
    const db = app.db;
    if (!db) return;
    const user = await findUserByEmail(db, email);
    if (!user?.passwordHash) return;

    // One link per account per cooldown. The route is public and each new link
    // kills the last, so without this anybody who knows an address can keep
    // the inbox full and every link in it dead. The link already sent stays
    // live, so somebody who asks twice loses nothing.
    if (await selfServeResetIsCoolingDown(db, user.id)) {
      await audit.write({
        action: "password.reset_requested",
        actor: { id: user.id, kind: "user" },
        access: { ...access, sessionId: null },
        note: RESET_REQUEST_COOLING_DOWN_NOTE,
      });
      return;
    }

    const created = await createPasswordReset(db, { userId: user.id, mode: "managed" });
    const hours = Math.max(1, Math.round(RESET_TTL_MS.managed / 3_600_000));
    const { delivery } = await sendPasswordResetEmail(
      {
        to: user.email,
        resetUrl: resetUrl(origin, created.rawToken),
        expiresInHours: hours,
      },
      (msg, ctx) => log.warn(ctx ?? {}, msg),
    );
    // Unlike an invitation, a failed reset has nowhere to fall back to: there
    // is no admin in this flow to hand the link to, and returning it in the
    // response would let anybody mint a reset for any address. The note is the
    // only record, which is exactly why it is a note — and why it has its own
    // wording rather than the invitation's.
    await audit.write({
      action: "password.reset_requested",
      actor: { id: user.id, kind: "user" },
      access: { ...access, sessionId: null },
      note: RESET_REQUEST_NOTES[delivery],
    });
  }

  app.post(
    "/auth/password/reset/preview",
    {
      config: { rateLimit: strictLimit },
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
      config: { rateLimit: strictLimit },
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

      // The link is a bearer credential, so who used it is unknowable; who
      // generated it is not, and that is what an auditor needs to connect an
      // admin-issued link to its redemption.
      await audit.write({
        action: "password.reset_completed",
        actor: { id: outcome.user.id, kind: "user" },
        access: { ...client.access, sessionId: null },
        note: outcome.createdBy
          ? `redeemed a link generated by admin ${outcome.createdBy}`
          : "redeemed a self-serve link",
      });
      // The ticket's `session.revoked` covers a session killed "by a password
      // reset": one row per session the reset ended.
      for (const id of outcome.revokedSessionIds) {
        await audit.write({
          action: "session.revoked",
          actor: { id: outcome.user.id, kind: "user" },
          target: { type: "session", id, name: outcome.user.email },
          access: { ...client.access, sessionId: null },
          note: "password reset",
        });
      }

      // No session. The person proves the new password works by using it —
      // and a reset link that signs you in is a reset link worth stealing.
      return { ok: true };
    },
  );

  app.post(
    "/auth/sign-in",
    {
      config: { rateLimit: strictLimit },
      schema: {
        tags: ["Auth"],
        summary: "Verify email + password, open a session, and return the user record",
        body: {
          type: "object" as const,
          required: ["email", "password"],
          properties: {
            email: EMAIL_FIELD,
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

      // Spend the attempt BEFORE the password is looked at. Counting first is
      // what keeps a parallel burst inside the per-account budget; a correct
      // password refunds it below.
      const attempt = await recordAttempt(db, body.email);
      if (attempt.locked) {
        const target = await findUserByEmail(db, body.email);
        await audit.write({
          action: "signin.blocked",
          // Named. A lockout row that doesn't say which address was locked can't be
          // acted on, and the address is right here.
          actor: { id: null, kind: "user", label: body.email.toLowerCase(), email: body.email.toLowerCase() },
          ...(target ? { target: { type: "member" as const, id: target.id, name: target.email } } : {}),
          access: { ...client.access, sessionId: null },
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
        // The password's attempt is refunded, not the window cleared: each
        // wrong factor costs one, and only a finished sign-in starts afresh
        // (see `refundAttempt`).
        await refundAttempt(db, body.email);
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
      // It refunds its attempt, as the enrolled path does: the password was
      // right, and the sign-in that follows spends one of its own — without the
      // refund, somebody who mistyped four times would be locked out by the
      // second call with the right password in hand.
      if (body.probe) {
        await refundAttempt(db, body.email);
        return { twoFactorRequired: false };
      }

      return completeSignIn(db, user, client, "password");
    },
  );

  app.post(
    "/auth/2fa/verify",
    {
      config: { rateLimit: strictLimit },
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

      // Same wall as the password, and the same counter, keyed on the same
      // address — a second counter would quietly hand an attacker five password
      // attempts and then five code attempts. Spent BEFORE the code is checked,
      // as the password's is, so a parallel burst stays inside the budget; the
      // sign-in that finally succeeds refunds it (`completeSignIn`).
      const attempt = await recordAttempt(db, email);
      if (attempt.locked) {
        await audit.write({
          action: "signin.blocked",
          actor: { id: claimed.user.id, kind: "user", label: email, email },
          target: { type: "member", id: claimed.user.id, name: email },
          access: { ...client.access, sessionId: null },
          note: `${attempt.attempts} attempts on ${email} this window`,
        });
        const locked = lockedReply(attempt.until);
        if (locked.retryAfterSec) reply.header("Retry-After", String(locked.retryAfterSec));
        return reply.code(423).send({ statusCode: 423, error: "Locked", message: locked.message });
      }

      const outcome = await consumeCode(db, claimed.user, body.code);
      if (!outcome.ok && outcome.reason === "undecryptable") {
        // Not the person's fault and not an attack: the deployment's key does
        // not open this secret. Loud in the log, named in the audit row, and
        // not counted as a wrong code against someone who typed the right one.
        request.log.error(
          { userId: claimed.user.id },
          "an enrolled two-factor secret could not be decrypted — TOTP_ENCRYPTION_KEY does not match the key it was sealed with",
        );
        await refundAttempt(db, email);
        await audit.write({
          action: "signin.failed",
          actor: { id: claimed.user.id, kind: "user", label: email, email },
          access: { ...client.access, sessionId: null },
          note: "two-factor secret could not be decrypted (TOTP_ENCRYPTION_KEY)",
        });
        return refuse();
      }
      if (!outcome.ok) {
        await audit.write({
          action: "signin.failed",
          actor: { id: claimed.user.id, kind: "user", label: email, email },
          access: { ...client.access, sessionId: null },
          // The one place the distinction is recorded. A run of these against
          // one account means somebody holds a correct password, which reads
          // very differently from a run of "wrong password".
          note: "wrong two-factor code",
        });
        return refuse();
      }

      return completeSignIn(db, claimed.user, client, `${claimed.firstFactor}+totp`);
    },
  );

  app.post(
    "/auth/oauth/:provider",
    {
      config: { rateLimit: strictLimit },
      schema: {
        tags: ["Auth"],
        summary: "Verify a Google or GitHub token server-side and open a session — or, for an account with an authenticator, return a challenge for its code",
        params: {
          type: "object" as const,
          required: ["provider"],
          properties: {
            provider: { type: "string" as const, enum: ["google", "github"] },
          },
        },
        body: {
          type: "object" as const,
          required: ["token"],
          properties: {
            token: { type: "string" as const, minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const provider = (request.params as { provider: OAuthProvider }).provider;
      const { token } = request.body as OAuthBody;
      const client = resolveClientContext(request, internalSecret);

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

      // An account with an authenticator is asked for its code here too, as it
      // is after a password: the provider proved who holds the Google or GitHub
      // account, which is one factor, and MAG-2730's rule is two for everyone.
      // Same shape as the password path — a challenge and **no session** — so
      // there is still nothing a half-authenticated caller can hold; the code
      // step at `/auth/2fa/verify` opens the session and records it as
      // `<provider>+totp`.
      if (isEnrolled(user)) {
        const challenge = await issueChallenge(db, user.id, provider);
        return {
          twoFactorRequired: true,
          challenge: challenge.token,
          expiresAt: challenge.expiresAt.toISOString(),
          email: user.email,
        };
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
        access: { ...client.access, sessionId: session.id },
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
