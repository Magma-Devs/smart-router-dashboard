import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "@sr/db";
import { isRole, roleAtLeast, toCsv, type Role } from "@sr/shared";
import { requireRole } from "../plugins/auth.js";
import { lazyAuditWriter, type AuditWriter } from "../services/audit.js";
import {
  createInvitation,
  inviteUrl,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  type DeploymentMode,
} from "../services/invitations.js";
import { createPasswordReset, resetUrl } from "../services/password-reset.js";
import {
  changeMemberRole,
  countAdmins,
  listMembers,
  onMemberDeactivated,
  removeMember,
} from "../services/members.js";
import { findUserById } from "../services/users.js";
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
  const audit: AuditWriter = lazyAuditWriter(app);
  // Read from the live env at register time. `config` snapshots at module load,
  // which is before a test — or anything that loads secrets late — can set it.
  const mode: DeploymentMode =
    (process.env.DEPLOYMENT_MODE as DeploymentMode | undefined) ?? config.deploymentMode;
  const publicWebOrigin = process.env.PUBLIC_WEB_ORIGIN ?? config.publicWebOrigin;

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
    const origin = publicWebOrigin;
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

/** Split out so the invite routes above stay readable — same registration. */
export async function teamPasswordRoutes(app: FastifyInstance) {
  const audit: AuditWriter = lazyAuditWriter(app);

  app.post(
    "/api/team/members/:id/reset-link",
    {
      schema: {
        tags: ["Team"],
        summary: "Generate a password-reset link for a member (on-prem: no mail server)",
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
      const db = app.db;
      if (!db) {
        return reply.code(503).send({
          statusCode: 503,
          error: "Service Unavailable",
          message: "auth database not ready",
        });
      }
      const origin = process.env.PUBLIC_WEB_ORIGIN ?? config.publicWebOrigin;
      if (!origin) {
        return reply.code(500).send({
          statusCode: 500,
          error: "Internal Server Error",
          message: "PUBLIC_WEB_ORIGIN is not configured, so reset links cannot be built",
        });
      }

      const { id } = request.params as { id: string };
      const target = await findUserById(db, id);
      if (!target || target.status !== "active") {
        return reply
          .code(404)
          .send({ statusCode: 404, error: "Not Found", message: "No such member." });
      }
      if (!target.passwordHash) {
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message: `${target.email} signs in with Google and has no password to reset.`,
        });
      }

      const created = await createPasswordReset(db, {
        userId: target.id,
        mode: (process.env.DEPLOYMENT_MODE as "managed" | "onprem" | undefined) ?? config.deploymentMode,
        // The column an auditor reads: an admin started this, not the holder.
        createdBy: me.id,
      });

      await audit.write({
        action: "password.reset_link_generated",
        actor: { id: me.id, kind: "user" },
        target: { type: "member", id: target.id, name: target.email },
      });

      // An admin never sets someone else's password — they hand over a link and
      // the holder chooses the value. Shown once.
      return {
        url: resetUrl(origin, created.rawToken),
        expiresAt: created.expiresAt.toISOString(),
      };
    },
  );
}

interface RoleBody {
  role: string;
}

/** The member list and the two mutations that act on somebody else. Split from
 *  the invite routes above only for length — same registration. */
export async function teamMemberRoutes(app: FastifyInstance) {
  const audit: AuditWriter = lazyAuditWriter(app);

  function db(reply: FastifyReply): Database | null {
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
    "/api/team/members",
    { schema: { tags: ["Team"], summary: "Everyone with access — the access-review list" } },
    async (request, reply) => {
      // Readable by every role, including read-only. This *is* the review, and
      // a review only some people can see is not one.
      if (!requireRole(request, reply, "read_only")) return reply;
      const conn = db(reply);
      if (!conn) return reply;

      const [members, admins] = await Promise.all([listMembers(conn), countAdmins(conn)]);
      return {
        members: members.map((m) => ({
          id: m.id,
          name: m.name,
          email: m.email,
          role: m.role,
          twoFactorEnabled: m.twoFactorEnabled,
          lastActiveAt: m.lastActiveAt?.toISOString() ?? null,
          joinedAt: m.joinedAt.toISOString(),
        })),
        adminCount: admins,
        /** Prompt, never a block: while there is one admin the screen suggests
         *  adding a second. Preventing anything here would make admin
         *  untransferable, and a departing employee unremovable. */
        soleAdmin: admins === 1,
      };
    },
  );

  app.get(
    "/api/team/members.csv",
    { schema: { tags: ["Team"], summary: "The member list as CSV — the artifact auditors ask for" } },
    async (request, reply) => {
      if (!requireRole(request, reply, "read_only")) return reply;
      const conn = db(reply);
      if (!conn) return reply;

      const members = await listMembers(conn);
      const csv = toCsv(
        ["name", "email", "role", "two_factor", "last_active", "joined"],
        members.map((m) => [
          m.name,
          m.email,
          m.role,
          // Not "no" — 2FA doesn't exist yet (MAG-2730), and "no" would be true
          // today and wrong the day it ships.
          m.twoFactorEnabled === null ? "" : m.twoFactorEnabled ? "yes" : "no",
          m.lastActiveAt?.toISOString() ?? "",
          m.joinedAt.toISOString(),
        ]),
      );

      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="members.csv"')
        .send(csv);
    },
  );

  app.patch(
    "/api/team/members/:id",
    {
      schema: {
        tags: ["Team"],
        summary: "Change a member's role. Takes effect on their current session.",
        params: {
          type: "object" as const,
          required: ["id"],
          properties: { id: { type: "string" as const, format: "uuid" } },
        },
        body: {
          type: "object" as const,
          required: ["role"],
          properties: {
            role: { type: "string" as const, enum: ["read_only", "requester", "approver", "admin"] },
          },
        },
      },
    },
    async (request, reply) => {
      const me = requireRole(request, reply, "admin");
      if (!me) return reply;
      const conn = db(reply);
      if (!conn) return reply;

      const { id } = request.params as { id: string };
      const { role } = request.body as RoleBody;
      if (!isRole(role)) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: "Bad Request", message: "Unknown role" });
      }

      const result = await changeMemberRole(conn, { id, role, actorId: me.id });
      if (!result.ok) {
        return result.reason === "self"
          ? reply.code(409).send({
              statusCode: 409,
              error: "Conflict",
              message: "You cannot change your own role. Promote someone else first, then step down.",
            })
          : reply.code(404).send({ statusCode: 404, error: "Not Found", message: "No such member." });
      }

      await audit.write({
        action: "member.role_changed",
        actor: { id: me.id, kind: "user" },
        target: { type: "member", id: result.user.id, name: result.user.email },
        changes: [{ field: "role", from: result.previousRole ?? "", to: result.user.role }],
      });

      // Losing the ability to approve has the same consequence as leaving, for
      // anything currently waiting on them.
      if (!roleAtLeast(result.user.role, "approver") && roleAtLeast(result.previousRole, "approver")) {
        await onMemberDeactivated(conn, result.user.id, "demoted");
      }

      return { member: { id: result.user.id, email: result.user.email, role: result.user.role } };
    },
  );

  app.delete(
    "/api/team/members/:id",
    {
      schema: {
        tags: ["Team"],
        summary: "Remove a member — a state change, not a deletion",
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
      const conn = db(reply);
      if (!conn) return reply;

      const { id } = request.params as { id: string };
      const result = await removeMember(conn, { id, actorId: me.id });
      if (!result.ok) {
        return result.reason === "self"
          ? reply.code(409).send({
              statusCode: 409,
              error: "Conflict",
              message: "You cannot remove yourself.",
            })
          : reply.code(404).send({ statusCode: 404, error: "Not Found", message: "No such member." });
      }

      // No `changes`: MAG-2770's catalog says this verb carries no diff, and it
      // is right — "removed" is self-describing, and `status: active -> removed`
      // adds nothing a reader didn't get from the verb. Sending it anyway made
      // the writer report a `changes-not-expected` violation, which is exactly
      // the cross-side mismatch the emission test exists to catch.
      await audit.write({
        action: "member.removed",
        actor: { id: me.id, kind: "user" },
        target: { type: "member", id: result.user.id, name: result.user.email },
      });
      await onMemberDeactivated(conn, result.user.id, "removed");

      return { ok: true };
    },
  );
}
