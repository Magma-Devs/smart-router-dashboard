import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { roleAtLeast, type Role } from "@sr/shared";
import type { Session, User } from "@sr/db";
import { checkSession, touchSession, type SessionRejection } from "../services/sessions.js";
import { totpKeyConfigured, twoFactorStatus } from "../services/two-factor.js";

/** Bind session JWTs to a known issuer/audience so another HS256 token
 *  signed with `AUTH_SECRET` can't be confused with a session token. The
 *  web side (`apps/web/src/auth.config.ts`) sets these on the encode
 *  side; we enforce them on the verify side. */
export const SESSION_JWT_ISSUER = "smart-router-dashboard-web";
export const SESSION_JWT_AUDIENCE = "smart-router-dashboard-api";

/** JWT payload — must stay in sync with what Auth.js (web) signs. */
export interface AuthClaims {
  /** User UUID. Auth.js puts this in the `sub` claim. */
  sub: string;
  email: string;
  /** Role *at issue time*. Advisory only — authorisation reads the live row
   *  below, because a token minted before a demotion still carries the old
   *  value. Kept in the token so the web can render affordances without a
   *  round-trip. */
  role: Role;
  /** Session id — the row in `sessions` this token addresses. Required: a
   *  token without one cannot be checked against anything and is refused. */
  sid?: string;
  /** Issued-at, seconds since epoch (standard JWT claim). Compared to the
   *  account's `signed_out_all_at` cutoff. */
  iat?: number;
}

/**
 * What handlers actually read. Everything here comes from the database on this
 * request, not from the token — which is what "role is read at the moment of
 * the action" means in practice.
 */
export interface AuthUser {
  id: string;
  email: string;
  /** Live role from the user row. */
  role: Role;
  sessionId: string;
  user: User;
  session: Session;
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
    authUser: AuthUser | null;
  }
}

/** Machine-readable reasons, so the web can tell "sign in again" from "you are
 *  not allowed" and stop retrying instead of looping through the edge gate. */
export const AUTH_ERROR_CODES = {
  required: "AUTH_REQUIRED",
  sessionInvalid: "SESSION_INVALID",
  accountInactive: "ACCOUNT_INACTIVE",
  forbidden: "FORBIDDEN",
  unavailable: "AUTH_UNAVAILABLE",
  /** Signed in, but the dashboard stays shut until an authenticator is set up.
   *  Distinct from `forbidden` on purpose: the web has somewhere to send this
   *  person, and looping them back to the login page would be a dead end —
   *  their password is fine and signing in again changes nothing. */
  twoFactorRequired: "TWO_FACTOR_REQUIRED",
} as const;

type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

function sendAuthError(
  reply: FastifyReply,
  statusCode: number,
  code: AuthErrorCode,
  message: string,
): FastifyReply {
  const error =
    statusCode === 401
      ? "Unauthorized"
      : statusCode === 403
        ? "Forbidden"
        : statusCode === 503
          ? "Service Unavailable"
          : "Error";
  if (!reply.sent) void reply.status(statusCode).send({ error, message, statusCode, code });
  return reply;
}

/** Routes that stay public in AUTH_MODE=enabled. Everything the browser
 *  calls for data (/api/*) requires a Bearer token.
 *
 *  NOTE: this makes *all* of `/auth/*` public. Unauthenticated flows belong
 *  there; anything admin-only must live under `/api/` or it ships wide open. */
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

/** How a failed session lookup is reported. `user_inactive` is the only one
 *  that isn't "sign in again" — a suspended or removed person signing in again
 *  won't help, and saying so beats an infinite login loop. */
function rejectionResponse(reason: SessionRejection): {
  status: number;
  code: AuthErrorCode;
  message: string;
} {
  if (reason === "user_inactive") {
    return {
      status: 403,
      code: AUTH_ERROR_CODES.accountInactive,
      message: "This account is no longer active",
    };
  }
  return {
    status: 401,
    code: AUTH_ERROR_CODES.sessionInvalid,
    message: "Session has ended, please sign in again",
  };
}

/**
 * Registered ONLY when AUTH_MODE=enabled:
 *
 *  1. `@fastify/jwt` — validates the HS256 JWT Auth.js (web) signs with the
 *     shared AUTH_SECRET.
 *  2. An onRequest hook resolves the token's `sid` to a live session **and the
 *     live user row**, and puts both on `request.authUser`.
 *  3. A global gate: any non-public route without a usable session gets 401.
 *
 * **Why every request hits the database.** lava-connect splits this into a cheap
 * claims-only check for GETs and a `requireAuthFresh` variant for mutations,
 * because its session registry lives in Redis and doesn't carry the user row.
 * Here one indexed join returns both, so the split buys nothing and costs
 * correctness: with it, a removed person keeps reading the dashboard until they
 * happen to attempt a write. "Their access dies immediately" has to mean all of
 * it. The same request already makes multi-second Prometheus round-trips, so
 * this is not the expensive part of anything.
 *
 * **Why it fails closed.** The db plugin connects lazily, so `app.db` can be
 * null for a while after boot. During that window authenticated routes answer
 * 503 rather than trusting the token on its own — an auth check that quietly
 * stops checking is worse than one that is briefly unavailable.
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

  // Checked at boot, not at first use, because of what "at first use" would
  // mean here. MAG-2730's gate shuts the dashboard to anyone without an
  // authenticator; enrolment is the only way through it; and enrolment needs
  // this key to seal a secret. Missing it therefore locks out **every account
  // at once, with no route back in** — an outage that would present as "the
  // dashboard stopped working for everybody overnight" and be traced to one
  // unset variable. The same posture AUTH_SECRET takes, for a worse failure.
  if (!totpKeyConfigured()) {
    throw new Error(
      "AUTH_MODE=enabled requires TOTP_ENCRYPTION_KEY — two-factor secrets are encrypted at rest and without it nobody can enrol, which locks out every account. Generate one with `openssl rand -base64 32`.",
    );
  }

  // Required for the same reason, and it fails in the opposite direction:
  // quietly. Without it the api ignores the address the web forwards and
  // records its own instead, so every session row and every access event in the
  // audit log carries the web pod — on a log whose whole job is answering
  // "where was this signed in from". Nothing looks wrong; the addresses are
  // simply all the same one. The per-IP limiter degrades with it, putting the
  // deployment in a single bucket. Both are worth a startup error over.
  if (!(process.env.INTERNAL_AUTH_SECRET ?? "").trim()) {
    throw new Error(
      "AUTH_MODE=enabled requires INTERNAL_AUTH_SECRET — without it the api records its own address on every sign-in instead of the browser's, and the per-IP limit keys on the web tier. Generate one with `openssl rand -base64 32` (must match the web's).",
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
    // CORS preflights carry no headers and are answered by @fastify/cors.
    if (request.method === "OPTIONS") return;

    const isPublic = isPublicPath(request.url);

    let claims: AuthClaims | null;
    try {
      await request.jwtVerify();
      claims = request.user;
    } catch {
      // Bad signature, wrong issuer/audience, expired — all indistinguishable
      // to the caller on purpose.
      claims = null;
    }

    if (!claims) {
      if (isPublic) return;
      return sendAuthError(reply, 401, AUTH_ERROR_CODES.required, "Authentication required");
    }

    // A token with no `sid` addresses no session, so nothing can be revoked and
    // nothing can be checked. Refused rather than trusted — the alternative is a
    // class of token that silently bypasses the whole store.
    if (!claims.sid) {
      if (isPublic) return;
      return sendAuthError(
        reply,
        401,
        AUTH_ERROR_CODES.sessionInvalid,
        "Session token is missing its session id, please sign in again",
      );
    }

    const db = app.db;
    if (!db) {
      if (isPublic) return;
      return sendAuthError(reply, 503, AUTH_ERROR_CODES.unavailable, "auth database not ready");
    }

    const check = await checkSession(db, claims.sid, claims.iat);
    if (!check.ok) {
      if (isPublic) return;
      const { status, code, message } = rejectionResponse(check.reason);
      request.log.debug({ sid: claims.sid, reason: check.reason }, "session rejected");
      return sendAuthError(reply, status, code, message);
    }

    request.authUser = {
      id: check.user.id,
      email: check.user.email,
      role: check.user.role,
      sessionId: check.session.id,
      user: check.user,
      session: check.session,
    };

    /**
     * The must-enrol gate.
     *
     * Everyone who uses the dashboard sets up an authenticator. The single
     * exception is the first admin on a fresh install, during their grace
     * period — and `twoFactorStatus` is the only thing that decides whether
     * someone is in it, so the gate, the invite route and the header countdown
     * cannot end up disagreeing about whose clock is running.
     *
     * It runs here, in the hook, rather than on each route. A gate that has to
     * be added per route is a gate somebody forgets on the route that matters,
     * and "which endpoints did we remember" is not a thing a security review
     * should have to establish by reading forty files.
     *
     * `escapeHatch` is deliberately tiny: the enrolment pair, and the identity
     * read the enrolment screen needs to render itself. Nothing else — the
     * point of a blocked dashboard is that it is blocked.
     */
    if (!isPublic && twoFactorStatus(check.user).enrolmentRequired) {
      const path = request.url.split("?")[0] ?? request.url;
      const escapeHatch =
        path === "/api/account/2fa/begin" ||
        path === "/api/account/2fa/confirm" ||
        path === "/api/account/me";
      if (!escapeHatch) {
        return sendAuthError(
          reply,
          403,
          AUTH_ERROR_CODES.twoFactorRequired,
          "Set up two-factor authentication to continue.",
        );
      }
    }

    // Heartbeat, throttled to one write a minute. Never a reason to fail the
    // request it rode in on.
    void touchSession(db, check.session).catch((err: unknown) => {
      request.log.warn({ err }, "session heartbeat failed");
    });
  });
});

/** Reject with 401 unless the request carries a live session. The global gate
 *  already covers `/api/*`; this is for handlers that want the value. */
export function requireAuth(request: FastifyRequest, reply: FastifyReply): AuthUser | null {
  if (!request.authUser) {
    sendAuthError(reply, 401, AUTH_ERROR_CODES.required, "Authentication required");
    return null;
  }
  return request.authUser;
}

/**
 * Reject with 401 (no session) or 403 (insufficient role).
 *
 * The role compared is the one on the live user row loaded this request, not
 * the one in the token — so a demotion takes effect on the target's *current*
 * session rather than at their next sign-in.
 */
export function requireRole(
  request: FastifyRequest,
  reply: FastifyReply,
  minimum: Role,
): AuthUser | null {
  const authUser = requireAuth(request, reply);
  if (!authUser) return null;
  if (!roleAtLeast(authUser.role, minimum)) {
    sendAuthError(
      reply,
      403,
      AUTH_ERROR_CODES.forbidden,
      `This action requires the ${minimum} role or higher`,
    );
    return null;
  }
  return authUser;
}
