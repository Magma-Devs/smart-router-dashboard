import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "@sr/db";
import { requireAuth } from "../plugins/auth.js";
import { noopAuditWriter, type AuditWriter } from "../services/audit.js";
import { validatePassword, verifyPassword } from "../services/password.js";
import { changeOwnPassword } from "../services/password-reset.js";
import {
  listActiveSessions,
  revokeSession,
  signOutEverywhere,
} from "../services/sessions.js";

interface ChangePasswordBody {
  current: string;
  next: string;
}

/**
 * The account's own surface: your password, your sessions. Everything here acts
 * on the caller and nobody else, which is why it needs no role beyond having a
 * session at all.
 */
export async function accountRoutes(app: FastifyInstance) {
  const audit: AuditWriter = noopAuditWriter(app.log);

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
        // An OAuth-only account has no password to change. Saying so beats a
        // "current password is wrong" message about a password that never was.
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "This account signs in with Google and has no password to change.",
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
