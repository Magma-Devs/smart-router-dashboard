import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "@sr/db";
import { isRole, roleAtLeast, toCsv, type Role } from "@sr/shared";
import { requireRole, type AuthUser } from "../plugins/auth.js";
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
import { clearEnrolment, isEnrolled, revokeChallenges } from "../services/two-factor.js";
import { revokeAllForUser } from "../services/sessions.js";
import { config } from "../config.js";
import { EMAIL_DELIVERY_NOTES } from "@sr/shared";
import { sendInvitationEmail } from "../services/email-templates.js";

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
      void reply.code(503).send({
        statusCode: 503,
        error: "Service Unavailable",
        message: "auth database not ready",
      });
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


  /**
   * The grace period's other end.
   *
   * The first admin on a fresh install may defer 2FA — but only while they are
   * one person poking at a box. Inviting somebody makes them an admin over
   * another person's access, and the ticket ends the countdown at exactly that
   * moment: "the invite screen is blocked until 2FA is set up".
   *
   * There is no flag to write. The countdown "ending" IS this refusal, which is
   * what the ticket describes and is the honest implementation — a stored
   * "grace revoked" bit would be a second source of truth for a question the
   * account row already answers.
   *
   * It sits on invite creation AND resend: a resend is an invitation being sent,
   * and blocking only the first would leave "invite, fail, resend" as a way
   * around it for anybody who had a pending row already.
   */
  function requireEnrolledToInvite(me: AuthUser, reply: FastifyReply): boolean {
    if (isEnrolled(me.user)) return true;
    void reply.code(403).send({
      statusCode: 403,
      error: "Forbidden",
      code: "TWO_FACTOR_REQUIRED",
      message:
        "Set up two-factor authentication before inviting anyone. You are about to give somebody else access to this deployment.",
    });
    return false;
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
            role: {
              type: "string" as const,
              enum: ["read_only", "requester", "approver", "admin"],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const me = requireRole(request, reply, "admin");
      if (!me) return reply;
      // Before the configuration check below, deliberately. "Set up 2FA first"
      // is an answer about the caller; "PUBLIC_WEB_ORIGIN is unset" is an answer
      // about the deployment, and reporting the deployment's problem to someone
      // who was never going to be allowed through tells them something they had
      // no business learning.
      if (!requireEnrolledToInvite(me, reply)) return reply;
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
      const sent = await deliverInviteLink(app, {
        to: invitation.email,
        url: inviteUrl(origin, rawToken),
        expiresAt: invitation.expiresAt,
        mode,
      });

      // No `changes`: the catalog marks this verb carriesChanges:false, and the
      // role is already on the target. Same class as member.removed. The note
      // carries what became of the link — the one fact about delivery an
      // auditor needs, and the reason there is no separate email-log table.
      await audit.write({
        action: "member.invited",
        actor: { id: me.id, kind: "user" },
        target: { type: "invite", id: invitation.id, name: invitation.email },
        note: sent.note,
      });

      return reply.code(201).send({
        invite: {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt.toISOString(),
          state: "pending",
        },
        // Present whenever the admin has to carry it: always on-prem, and on
        // managed only when the send did not happen. Shown once; it is not
        // stored anywhere it can be read back.
        url: sent.url,
        delivery: sent.delivery,
        /** Managed, but the admin is holding the link — the send failed or no
         *  transport is configured. The screen says so rather than reusing the
         *  on-prem wording, which would blame a deployment shape. */
        deliveryFallback: sent.fallback,
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
      if (!requireEnrolledToInvite(me, reply)) return reply;
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

      const sent = await deliverInviteLink(app, {
        to: result.invitation.email,
        url: inviteUrl(origin, result.rawToken),
        expiresAt: result.invitation.expiresAt,
        mode,
      });

      await audit.write({
        action: "invite.resent",
        actor: { id: me.id, kind: "user" },
        target: { type: "invite", id: result.invitation.id, name: result.invitation.email },
        note: sent.note,
      });

      return {
        invite: {
          id: result.invitation.id,
          email: result.invitation.email,
          role: result.invitation.role,
          expiresAt: result.invitation.expiresAt.toISOString(),
          state: "pending",
        },
        url: sent.url,
        delivery: sent.delivery,
        deliveryFallback: sent.fallback,
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

  app.post(
    "/api/team/members/:id/2fa/reset",
    {
      schema: {
        tags: ["Team"],
        summary: "Clear someone's authenticator — the lost-phone path",
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
      const target = await findUserById(db, id);
      if (!target || target.status !== "active") {
        return reply
          .code(404)
          .send({ statusCode: 404, error: "Not Found", message: "No such member." });
      }

      if (!isEnrolled(target)) {
        // Not an error worth failing on — the outcome the admin wanted is
        // already true — but 409 rather than a silent 200, because "I reset it
        // and they still cannot get in" is the support ticket this prevents.
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "That member has not set up two-factor authentication.",
        });
      }

      // Three writes, and each one is load-bearing:
      //
      //  1. the secret is destroyed, not disabled — there is nothing left to
      //     restore, and nothing an admin could ever read back;
      //  2. any live challenge is retired, so a second step already in flight
      //     against the old secret cannot still be completed;
      //  3. their sessions end, because the account is being reset precisely
      //     when nobody is sure who is holding it.
      //
      // The admin never sees or sets the replacement. The member enrols again
      // on their next sign-in, from a secret only they will ever hold — which
      // is the same rule as passwords, and for the same reason: an admin who
      // could set someone's second factor could sign in as them.
      await clearEnrolment(db, target.id);
      await revokeChallenges(db, target.id);
      await revokeAllForUser(db, target.id, { reason: "admin", by: me.id });

      await audit.write({
        action: "2fa.reset",
        actor: { id: me.id, kind: "user" },
        // Both people named, as the ticket requires: the row has to answer
        // "who cleared whose" without a join.
        target: { type: "member", id: target.id, name: target.email },
        access: { ip: me.session.ip, client: me.session.client, sessionId: me.sessionId },
        note: `two-factor reset for ${target.email}`,
      });

      // The member is told. On managed that is an email (MAG-2870's transport);
      // on-prem there is no mail server and never will be, so it is the
      // enrolment screen they meet at their next sign-in, which says an
      // administrator reset it. Either way they cannot miss it: their sessions
      // just ended and the next screen explains why.
      return { ok: true, notified: config.deploymentMode === "managed" ? "email" : "on_next_signin" };
    },
  );
}

/**
 * Deliver an invitation link, and say what happened to it.
 *
 * The whole managed/on-prem fork lives here so both the create and the resend
 * route answer identically. Three outcomes, two shapes:
 *
 *  - **on-prem** — nothing is sent, ever. The link comes back for the admin to
 *    carry, which is the design, not a degraded mode.
 *  - **managed, sent** — the link does NOT come back. It is in the recipient's
 *    inbox and nowhere else, which is the point of having a transport.
 *  - **managed, not sent** — SES refused it, or no transport is configured. The
 *    link comes back anyway.
 *
 * That last case is the one worth being deliberate about. Returning 201 with no
 * link and no explanation would leave an admin believing an invitation is on its
 * way to somebody who will never receive it, and nothing on the screen or in the
 * log would say otherwise. The invitation row is already committed by this
 * point, so failing the request would be worse: it would report failure for
 * something that half happened.
 */
async function deliverInviteLink(
  app: FastifyInstance,
  opts: { to: string; url: string; expiresAt: Date; mode: "managed" | "onprem" },
): Promise<{ url?: string; delivery: "email" | "link"; fallback: boolean; note: string }> {
  if (opts.mode === "onprem") {
    return { url: opts.url, delivery: "link", fallback: false, note: EMAIL_DELIVERY_NOTES.link };
  }

  const days = Math.max(1, Math.round((opts.expiresAt.getTime() - Date.now()) / 86_400_000));
  const { delivery } = await sendInvitationEmail(
    { to: opts.to, inviteUrl: opts.url, expiresInDays: days },
    (msg, ctx) => app.log.warn(ctx ?? {}, msg),
  );

  if (delivery === "sent") {
    return { delivery: "email", fallback: false, note: EMAIL_DELIVERY_NOTES.sent };
  }
  return {
    url: opts.url,
    delivery: "link",
    fallback: true,
    note: EMAIL_DELIVERY_NOTES[delivery],
  };
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
        // Defensive, as on /api/account/password: setup and invite redemption
        // both set a hash, so an account without one can't currently exist.
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message: `${target.email} has no password set, so there is nothing to reset.`,
        });
      }

      const created = await createPasswordReset(db, {
        userId: target.id,
        mode:
          (process.env.DEPLOYMENT_MODE as "managed" | "onprem" | undefined) ??
          config.deploymentMode,
        // The column an auditor reads: an admin started this, not the holder.
        createdBy: me.id,
      });

      // Access context is required here by the catalog, and rightly: an admin
      // minting a reset link for somebody else is the first half of an account
      // takeover, so "from where" is part of the record.
      await audit.write({
        action: "password.reset_link_generated",
        actor: { id: me.id, kind: "user" },
        target: { type: "member", id: target.id, name: target.email },
        access: { ip: me.session.ip, client: me.session.client, sessionId: me.sessionId },
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
          /** Ours, not one of the customer's people — managed deployments
           *  only. Sent to everyone who can read the list, and never used to
           *  filter it: the whole point of the flag is that the account is
           *  visible. */
          isMagmaAccount: m.isMagmaAccount,
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
    {
      schema: { tags: ["Team"], summary: "The member list as CSV — the artifact auditors ask for" },
    },
    async (request, reply) => {
      if (!requireRole(request, reply, "read_only")) return reply;
      const conn = db(reply);
      if (!conn) return reply;

      const members = await listMembers(conn);
      const csv = toCsv(
        // `magma_account` is appended rather than slotted next to the identity
        // columns, so a reviewer holding an older export can still diff the two
        // side by side.
        ["name", "email", "role", "two_factor", "last_active", "joined", "magma_account"],
        members.map((m) => [
          m.name,
          m.email,
          m.role,
          // Real since MAG-2730 — it was blank while 2FA did not exist, because
          // "no" would have been true then and wrong the day it shipped. Under
          // the enforcement rule only the first admin can read "no", and only
          // during their grace period, so a second "no" in this column is the
          // thing a reviewer should stop on.
          m.twoFactorEnabled ? "yes" : "no",
          m.lastActiveAt?.toISOString() ?? "",
          m.joinedAt.toISOString(),
          // Unlike two_factor, "no" here is simply true: the flag is known in
          // both modes, and on-prem the honest answer for every row is no.
          m.isMagmaAccount ? "yes" : "no",
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
            role: {
              type: "string" as const,
              enum: ["read_only", "requester", "approver", "admin"],
            },
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
              message:
                "You cannot change your own role. To step down, promote someone else and ask " +
                "them to demote you — the last move is never your own.",
            })
          : reply
              .code(404)
              .send({ statusCode: 404, error: "Not Found", message: "No such member." });
      }

      await audit.write({
        action: "member.role_changed",
        actor: { id: me.id, kind: "user" },
        target: { type: "member", id: result.user.id, name: result.user.email },
        changes: [{ field: "role", from: result.previousRole ?? "", to: result.user.role }],
      });

      // Losing the ability to approve has the same consequence as leaving, for
      // anything currently waiting on them.
      if (
        !roleAtLeast(result.user.role, "approver") &&
        roleAtLeast(result.previousRole, "approver")
      ) {
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
          : reply
              .code(404)
              .send({ statusCode: 404, error: "Not Found", message: "No such member." });
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
