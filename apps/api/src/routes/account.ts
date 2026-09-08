import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "@sr/db";
import { requireAuth } from "../plugins/auth.js";
import { lazyAuditWriter, type AuditWriter } from "../services/audit.js";
import { validatePassword, verifyPassword } from "../services/password.js";
import { changeOwnPassword } from "../services/password-reset.js";
import { listActiveSessions, revokeSession, signOutEverywhere } from "../services/sessions.js";
import {
  beginEnrolment,
  confirmEnrolment,
  isEnrolled,
  twoFactorStatus,
} from "../services/two-factor.js";

interface ChangePasswordBody {
  current: string;
  next: string;
}

interface ConfirmTwoFactorBody {
  code: string;
}

/**
 * The account's own surface: your password, your sessions. Everything here acts
 * on the caller and nobody else, which is why it needs no role beyond having a
 * session at all.
 */
export async function accountRoutes(app: FastifyInstance) {
  const audit: AuditWriter = lazyAuditWriter(app);

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
    "/api/account/me",
    {
      schema: {
        tags: ["Account"],
        summary: "Who the caller is right now — read from the row, not the token",
      },
    },
    async (request, reply) => {
      const me = requireAuth(request, reply);
      if (!me) return reply;

      // Deliberately from `me.user`, which the auth plugin resolved by joining
      // the session to the live account on this request. The token carries a
      // `role` claim too, but it is stamped once at sign-in and never refreshed
      // — so a promotion or demotion would not reach the browser until the
      // person signed in again, and the screen would disagree with the api for
      // up to the 30-day session lifetime.
      //
      // The api was always right, because it authorises from this same row.
      // This endpoint is what lets the UI be right as well.
      // The 2FA block is what the header countdown and the forced-enrolment
      // screen both read, and it comes from `twoFactorStatus` rather than being
      // recomputed here — the api gate and the invite route consult the same
      // function, so the screen cannot say "12 days left" about an account the
      // gate has already shut.
      //
      // Note what is absent: the secret. It is never returned by any API after
      // enrolment, which is a stated requirement of the ticket — this endpoint
      // says whether one exists, never what it is.
      const twoFactor = twoFactorStatus(me.user);

      return {
        id: me.user.id,
        email: me.user.email,
        name: me.user.name,
        avatarUrl: me.user.avatarUrl,
        role: me.user.role,
        twoFactor: {
          enrolled: twoFactor.enrolled,
          enrolmentRequired: twoFactor.enrolmentRequired,
          graceEndsAt: twoFactor.graceEndsAt?.toISOString() ?? null,
          daysLeft: twoFactor.daysLeft,
        },
      };
    },
  );

  app.post(
    "/api/account/2fa/begin",
    {
      schema: {
        tags: ["Account"],
        summary: "Start enrolment — returns a QR and the same secret as text, once",
      },
    },
    async (request, reply) => {
      const me = requireAuth(request, reply);
      if (!me) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;

      // An enrolled account cannot quietly re-enrol. The ticket gives exactly
      // one route back from a lost phone — an admin reset, which is logged and
      // names both people — and self-service re-enrolment would be a second one
      // that names nobody: whoever holds a stolen session could move the second
      // factor onto their own phone and lock the owner out, with an audit log
      // showing nothing but a `2fa.enrolled` the owner would assume was theirs.
      if (isEnrolled(me.user)) {
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message:
            "Two-factor authentication is already set up for this account. An administrator can reset it if you have lost your phone.",
        });
      }

      let offer;
      try {
        offer = await beginEnrolment(db, me.user);
      } catch (err) {
        // The one failure worth its own message: the deployment has no
        // TOTP_ENCRYPTION_KEY. A 500 here reads as "the dashboard is broken"
        // when it is one unset variable, and the person hitting it is locked
        // out of a dashboard they can otherwise see.
        request.log.error({ err }, "two-factor enrolment could not seal a secret");
        return reply.code(503).send({
          statusCode: 503,
          error: "Service Unavailable",
          message:
            "Two-factor authentication is not configured on this deployment. TOTP_ENCRYPTION_KEY is not set.",
        });
      }

      // The secret and the QR leave the server exactly once, in this response
      // body. Never in a URL, never in a log line — the URI carries the secret
      // and an address bar is a place things are kept.
      return { secret: offer.secret, qrSvg: offer.qrSvg, issuer: offer.issuer };
    },
  );

  app.post(
    "/api/account/2fa/confirm",
    {
      schema: {
        tags: ["Account"],
        summary: "Prove a code from the offered secret and turn 2FA on",
        body: {
          type: "object" as const,
          required: ["code"],
          properties: { code: { type: "string" as const, minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const me = requireAuth(request, reply);
      if (!me) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;
      const { code } = request.body as ConfirmTwoFactorBody;

      const outcome = await confirmEnrolment(db, me.user, code);
      if (!outcome.ok) {
        if (outcome.reason === "no_pending") {
          return reply.code(409).send({
            statusCode: 409,
            error: "Conflict",
            message: "Start again — there is no pending authenticator to confirm.",
          });
        }
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "That code is not right. Check your authenticator app and try again.",
        });
      }

      await audit.write({
        action: "2fa.enrolled",
        actor: { id: me.id, kind: "user" },
        target: { type: "member", id: me.id, name: me.user.email },
        access: { ip: me.session.ip, client: me.session.client, sessionId: me.sessionId },
      });

      // No session is revoked. The person is at their keyboard with the phone
      // they just enrolled; signing them out of it would be theatre.
      return { ok: true };
    },
  );

  app.post(
    "/api/account/password",
    {
      schema: {
        tags: ["Account"],
        summary: "Change your own password. Signs out your other devices.",
        body: {
          type: "object" as const,
          required: ["current", "next"],
          properties: {
            current: { type: "string" as const, minLength: 1 },
            next: { type: "string" as const, minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const me = requireAuth(request, reply);
      if (!me) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;
      const body = request.body as ChangePasswordBody;

      if (!me.user.passwordHash) {
        // Defensive. Both ways an account is created — first-run setup and
        // invite redemption — set a hash, so this is unreachable today; it was
        // reachable while social sign-in existed. Kept because the column is
        // nullable, and because "your current password is wrong" about a
        // password that never existed is the worst way to find out.
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "This account has no password set.",
        });
      }

      if (!(await verifyPassword(body.current, me.user.passwordHash))) {
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "That current password is not correct.",
        });
      }

      const problem = await validatePassword(body.next, request.log);
      if (problem) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: "Bad Request", message: problem.message });
      }

      await changeOwnPassword(db, me.id, body.next, me.sessionId);
      await audit.write({
        action: "password.changed",
        actor: { id: me.id, kind: "user" },
        access: { ip: me.session.ip, client: me.session.client, sessionId: me.sessionId },
      });

      return { ok: true };
    },
  );

  app.get(
    "/api/account/sessions",
    { schema: { tags: ["Account"], summary: "Your live sessions, newest first" } },
    async (request, reply) => {
      const me = requireAuth(request, reply);
      if (!me) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;

      const rows = await listActiveSessions(db, me.id);
      return {
        sessions: rows.map((s) => ({
          id: s.id,
          client: s.client,
          ip: s.ip,
          authMethod: s.authMethod,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          /** Marked so nobody revokes the device they're reading this on by
           *  accident — and so "sign out everywhere else" is meaningful. */
          current: s.id === me.sessionId,
        })),
      };
    },
  );

  app.delete(
    "/api/account/sessions/:id",
    {
      schema: {
        tags: ["Account"],
        summary: "Sign out one device",
        params: {
          type: "object" as const,
          required: ["id"],
          properties: { id: { type: "string" as const, format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const me = requireAuth(request, reply);
      if (!me) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;

      const { id } = request.params as { id: string };
      // Scoped to the caller's own sessions: the id is a UUID a person could
      // otherwise guess their way around.
      const mine = (await listActiveSessions(db, me.id)).some((s) => s.id === id);
      if (!mine) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: "Not Found", message: "No such session." });
      }

      await revokeSession(db, id, { reason: "self", by: me.id });
      await audit.write({
        action: "session.revoked",
        actor: { id: me.id, kind: "user" },
        target: { type: "session", id, name: "own device" },
        access: { ip: me.session.ip, client: me.session.client, sessionId: me.sessionId },
      });

      return { ok: true };
    },
  );

  app.delete(
    "/api/account/sessions",
    { schema: { tags: ["Account"], summary: "Sign out everywhere, including here" } },
    async (request, reply) => {
      const me = requireAuth(request, reply);
      if (!me) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;

      // Everything, this device included — and the cutoff too, so a token we
      // hold no row for dies with the rest.
      const count = await signOutEverywhere(db, me.id, { reason: "sign_out_all", by: me.id });
      await audit.write({
        action: "signout",
        actor: { id: me.id, kind: "user" },
        access: { ip: me.session.ip, client: me.session.client, sessionId: me.sessionId },
        note: `signed out of ${count} device${count === 1 ? "" : "s"}`,
      });

      return { ok: true, revoked: count };
    },
  );
}
