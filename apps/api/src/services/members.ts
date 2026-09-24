import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { invitations, sessions, users, type Database, type User } from "@sr/db";
import { roleAtLeast, type Role } from "@sr/shared";
import type { AuditWriter } from "./audit.js";

/**
 * The member list, and the two mutations that act on somebody else.
 *
 * The list is the access-review artifact: "who still has access" is a question
 * nothing else can answer for us, because we hold the accounts and don't sync
 * with anyone's identity system. Nothing tells us when someone leaves the
 * customer's company — the list is the answer, and it stays a list.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §6.4.
 */

export interface MemberRow {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  status: "active" | "suspended" | "removed";
  /** Populated by MAG-2730. Null until then — and rendered as an em dash
   *  rather than "No", which would be true today and misleading tomorrow. */
  twoFactorEnabled: boolean | null;
  lastActiveAt: Date | null;
  joinedAt: Date;
}

/** Active members, most privileged first, then alphabetically. Removed people
 *  are excluded: their record survives for the audit log, not for this screen. */
export async function listMembers(db: Database): Promise<MemberRow[]> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.status, "active"))
    // `user_role` is declared least to most privileged, so descending puts
    // admins first.
    .orderBy(desc(users.role), asc(users.email));

  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    twoFactorEnabled: null,
    lastActiveAt: u.lastActiveAt,
    joinedAt: u.createdAt,
  }));
}

/** How many admins remain. Drives the "add a second admin" prompt — which is a
 *  prompt and never a block, because admin has to stay transferable. */
export async function countAdmins(db: Database): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.status, "active"), eq(users.role, "admin")));
  return rows[0]?.count ?? 0;
}

export type MemberMutation =
  | { ok: true; user: User; previousRole?: Role }
  | { ok: false; reason: "not_found" | "self" | "not_admin" };

/**
 * Lock the actor's and the target's rows for the rest of the transaction, and
 * read them back. Locked in id order, so two admins acting on each other queue
 * rather than deadlock.
 *
 * `requireRole` checked the actor when the request arrived. This check holds
 * when the write lands. Without it, two admins removing or demoting each other
 * at once both pass, and nobody is left who can manage the team.
 */
async function lockActorAndTarget(
  tx: Database,
  actorId: string,
  targetId: string,
): Promise<{ actorIsAdmin: boolean; target: User | undefined }> {
  const rows = await tx
    .select()
    .from(users)
    .where(inArray(users.id, [actorId, targetId]))
    .orderBy(asc(users.id))
    .for("update");
  const actor = rows.find((r) => r.id === actorId);
  const target = rows.find((r) => r.id === targetId);
  return {
    actorIsAdmin: actor?.status === "active" && actor.role === "admin",
    target: target?.status === "active" ? target : undefined,
  };
}

/**
 * Change someone's role.
 *
 * No session is revoked and none needs to be: the api reads the role from the
 * row on every request, so a demotion lands on the target's *current* session.
 *
 * Refuses self-demotion — an admin removing their own last privilege by
 * accident is a support ticket, and doing it deliberately is what "transfer
 * then step down" is for.
 *
 * The audit row is written inside the transaction, so it and the change it
 * records commit or roll back together. Setting the role someone already has
 * changes nothing and records nothing.
 */
export async function changeMemberRole(
  db: Database,
  input: { id: string; role: Role; actorId: string },
  audit: AuditWriter,
): Promise<MemberMutation> {
  if (input.id === input.actorId) return { ok: false, reason: "self" };

  return db.transaction(async (tx): Promise<MemberMutation> => {
    const { actorIsAdmin, target } = await lockActorAndTarget(tx, input.actorId, input.id);
    if (!actorIsAdmin) return { ok: false, reason: "not_admin" };
    if (!target) return { ok: false, reason: "not_found" };
    if (target.role === input.role) return { ok: true, user: target, previousRole: target.role };

    const updated = await tx
      .update(users)
      .set({ role: input.role })
      .where(eq(users.id, input.id))
      .returning();
    const user = updated[0]!;

    await audit.write(
      {
        action: "member.role_changed",
        actor: { id: input.actorId, kind: "user" },
        target: { type: "member", id: user.id, name: user.email },
        changes: [{ field: "role", from: target.role, to: user.role }],
      },
      tx,
    );
    // Losing the ability to approve has the same consequence as leaving, for
    // anything currently waiting on them.
    if (!roleAtLeast(user.role, "approver") && roleAtLeast(target.role, "approver")) {
      await onMemberDeactivated(tx, user.id, "demoted");
    }

    return { ok: true, user, previousRole: target.role };
  });
}

/**
 * Remove someone. **A state change, not a row deletion.**
 *
 * One transaction, and every part of it is a requirement:
 *
 *  - `status = 'removed'` — their name stays in the audit log permanently, and
 *    the partial unique index frees their address so it can be invited again
 *    under a new account.
 *  - provider ids cleared — those columns are unique across every row, removed
 *    ones included, so a kept id would make the new account's Google (or
 *    GitHub) sign-in collide with the old one.
 *  - `signed_out_all_at` — the account-wide cutoff, so no token issued before
 *    the removal is honoured even if a session row were missed.
 *  - every live session revoked — so their access dies within one request, not
 *    at their next sign-in.
 *  - any pending invitation to their address revoked — two admins inviting
 *    the same address at once can both pass the one-pending check, and the
 *    invitation they did not use would otherwise recreate them.
 *  - the audit row — written with the transaction, so a removal the log can't
 *    record doesn't happen.
 *
 * Cancelling their in-flight change requests is MAG-2731's table and therefore
 * its job; the hook is `onMemberDeactivated`, called inside the transaction.
 */
export async function removeMember(
  db: Database,
  input: { id: string; actorId: string },
  audit: AuditWriter,
): Promise<MemberMutation> {
  if (input.id === input.actorId) return { ok: false, reason: "self" };

  return db.transaction(async (tx): Promise<MemberMutation> => {
    const { actorIsAdmin, target } = await lockActorAndTarget(tx, input.actorId, input.id);
    if (!actorIsAdmin) return { ok: false, reason: "not_admin" };
    if (!target) return { ok: false, reason: "not_found" };

    const updated = await tx
      .update(users)
      .set({
        status: "removed",
        removedAt: new Date(),
        removedBy: input.actorId,
        signedOutAllAt: new Date(),
        googleId: null,
        githubId: null,
        discordId: null,
      })
      .where(eq(users.id, input.id))
      .returning();

    await tx
      .update(sessions)
      .set({
        revokedAt: new Date(),
        revokedReason: "member_removed",
        revokedBy: input.actorId,
      })
      .where(and(eq(sessions.userId, input.id), isNull(sessions.revokedAt)));

    await tx
      .update(invitations)
      .set({ revokedAt: new Date(), revokedBy: input.actorId })
      .where(
        and(
          sql`lower(${invitations.email}) = ${target.email.toLowerCase()}`,
          isNull(invitations.redeemedAt),
          isNull(invitations.revokedAt),
        ),
      );

    const user = updated[0]!;
    // No `changes`: MAG-2770's catalog says this verb carries no diff, and it
    // is right — "removed" is self-describing, and `status: active -> removed`
    // adds nothing a reader didn't get from the verb.
    await audit.write(
      {
        action: "member.removed",
        actor: { id: input.actorId, kind: "user" },
        target: { type: "member", id: user.id, name: user.email },
      },
      tx,
    );
    await onMemberDeactivated(tx, user.id, "removed");

    return { ok: true, user };
  });
}

/**
 * Called when someone loses access — removed, or demoted below `approver`.
 *
 * MAG-2731 owns change requests, so this is the seam rather than the
 * implementation: their pending requests have to be cancelled, and the
 * cancellation has to say why. It runs inside the removal or demotion
 * transaction, so the cancellation and the change it follows land together.
 * MAG-2729's done-when lists the cancellation; it is delivered with MAG-2731's
 * table, not here.
 */
export async function onMemberDeactivated(
  _db: Database,
  _userId: string,
  _reason: "removed" | "demoted",
): Promise<void> {
  // Intentionally empty until MAG-2731 lands the change-request table.
}
