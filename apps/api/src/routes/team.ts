import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "@sr/db";
import { isRole, type Role } from "@sr/shared";
import { requireRole } from "../plugins/auth.js";
import { noopAuditWriter, type AuditWriter } from "../services/audit.js";
import {
  createInvitation,
  inviteUrl,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  type DeploymentMode,
} from "../services/invitations.js";
import { config } from "../config.js";

interface InviteBody {
  email: string;
  role: string;
}

/**
 * Team management. Everything here is admin-only and lives under `/api/` — the
 * auth plugin treats all of `/auth/*` as public, so an admin surface placed
 * there would ship wide open.
 *
 * Invitation *redemption* is the unauthenticated half and lives in
 * `routes/auth.ts`, because the person redeeming has no account yet.
 */
export async function teamRoutes(app: FastifyInstance) {
  const audit: AuditWriter = noopAuditWriter(app.log);
  const mode: DeploymentMode = config.deploymentMode;

  function dbOr503(reply: FastifyReply): Database | null {
    if (!app.db) {
      void reply
        .code(503)
        .send({ statusCode: 503, error: "Service Unavailable", message: "auth database not ready" });
      return null;
    }
    return app.db;
  }

  /** Where invite links point. Without it we can't build one, and returning a
   *  link to a host we guessed would be worse than saying so. */
  function webOrigin(reply: FastifyReply): string | null {
    const origin = config.publicWebOrigin;
    if (!origin) {
      void reply.code(500).send({
        statusCode: 500,
        error: "Internal Server Error",
        message: "PUBLIC_WEB_ORIGIN is not configured, so invitation links cannot be built",
      });
      return null;
    }
    return origin;
  }

  app.get(
    "/api/team/invites",
    { schema: { tags: ["Team"], summary: "Invitations not yet redeemed, newest first" } },
    async (request, reply) => {
      if (!requireRole(request, reply, "admin")) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;

      const rows = await listInvitations(db);
      const now = Date.now();
      return {
        invites: rows.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          createdAt: i.createdAt.toISOString(),
          expiresAt: i.expiresAt.toISOString(),
          resendCount: i.resendCount,
          // One field rather than three booleans — the screen shows a single
          // state per row and this is where the precedence is decided.
          state: i.revokedAt ? "revoked" : i.expiresAt.getTime() <= now ? "expired" : "pending",
        })),
      };
    },
  );

  app.post(
    "/api/team/invites",
    {
      schema: {
        tags: ["Team"],
        summary: "Invite an address. On-prem returns the link — there is no mail server.",
        body: {
          type: "object" as const,
          required: ["email", "role"],
          properties: {
            email: { type: "string" as const, format: "email" },
            role: { type: "string" as const, enum: ["read_only", "requester", "approver", "admin"] },
          },
        },
      },
    },
    async (request, reply) => {
      const me = requireRole(request, reply, "admin");
      if (!me) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;
      const origin = webOrigin(reply);
      if (!origin) return reply;

      const body = request.body as InviteBody;
      if (!isRole(body.role)) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: "Bad Request", message: "Unknown role" });
      }

      const result = await createInvitation(db, {
        email: body.email,
        role: body.role as Role,
        createdBy: me.id,
        mode,
      });
      if (!result.ok) {
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message:
            result.reason === "already_member"
              ? "That address already belongs to a member."
              : "That address already has a pending invitation.",
        });
      }

      const { invitation, rawToken } = result.created;
      await audit.write({
        action: "member.invited",
        actor: { id: me.id, kind: "user" },
        target: { type: "invite", id: invitation.id, name: invitation.email },
        changes: [{ field: "role", from: "(new)", to: invitation.role }],
      });

      return reply.code(201).send({
        invite: {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt.toISOString(),
          state: "pending",
        },
        // On-prem has no mail server, so the admin copies this and hands it
        // over. Shown once; it is not stored anywhere it can be read back.
        url: mode === "onprem" ? inviteUrl(origin, rawToken) : undefined,
        delivery: mode === "onprem" ? "link" : "email",
      });
    },
  );

  app.post(
    "/api/team/invites/:id/resend",
    {
      schema: {
        tags: ["Team"],
        summary: "Mint a fresh link, invalidating the previous one",
        params: {
          type: "object" as const,
          required: ["id"],
          properties: { id: { type: "string" as const, format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const me = requireRole(request, reply, "admin");
      if (!me) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;
      const origin = webOrigin(reply);
      if (!origin) return reply;

      const { id } = request.params as { id: string };
      const result = await resendInvitation(db, id, mode);
      if (!result) {
        return reply.code(410).send({
          statusCode: 410,
          error: "Gone",
          message: "That invitation has already been redeemed or revoked.",
        });
      }

      await audit.write({
        action: "invite.resent",
        actor: { id: me.id, kind: "user" },
        target: { type: "invite", id: result.invitation.id, name: result.invitation.email },
      });

      return {
        invite: {
          id: result.invitation.id,
          email: result.invitation.email,
          role: result.invitation.role,
          expiresAt: result.invitation.expiresAt.toISOString(),
          state: "pending",
        },
        url: mode === "onprem" ? inviteUrl(origin, result.rawToken) : undefined,
        delivery: mode === "onprem" ? "link" : "email",
      };
    },
  );

  app.delete(
    "/api/team/invites/:id",
    {
      schema: {
        tags: ["Team"],
        summary: "Revoke an invitation — the link dies immediately",
        params: {
          type: "object" as const,
          required: ["id"],
          properties: { id: { type: "string" as const, format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const me = requireRole(request, reply, "admin");
      if (!me) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;

      const { id } = request.params as { id: string };
      const revoked = await revokeInvitation(db, id, me.id);
      if (!revoked) {
        return reply.code(410).send({
          statusCode: 410,
          error: "Gone",
          message: "That invitation has already been redeemed or revoked.",
        });
      }

      await audit.write({
        action: "invite.revoked",
        actor: { id: me.id, kind: "user" },
        target: { type: "invite", id: revoked.id, name: revoked.email },
      });

      return { ok: true };
    },
  );
}
