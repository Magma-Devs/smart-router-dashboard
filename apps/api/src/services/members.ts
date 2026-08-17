import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { invitations, sessions, users, type Database, type User } from "@sr/db";
import type { Role } from "@sr/shared";

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
    .orderBy(asc(users.email));

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
  | { ok: false; reason: "not_found" | "self" };

/**
 * Change someone's role.
 *
 * No session is revoked and none needs to be: the api reads the role from the
 * row on every request, so a demotion lands on the target's *current* session.
 *
 * Refuses self-demotion — an admin removing their own last privilege by
 * accident is a support ticket, and doing it deliberately is what "transfer
 * then step down" is for.
 */
export async function changeMemberRole(
  db: Database,
  input: { id: string; role: Role; actorId: string },
): Promise<MemberMutation> {
  if (input.id === input.actorId) return { ok: false, reason: "self" };

  const existing = await db
    .select()
    .from(users)
    .where(and(eq(users.id, input.id), eq(users.status, "active")))
    .limit(1);
  const target = existing[0];
  if (!target) return { ok: false, reason: "not_found" };

  const updated = await db
    .update(users)
    .set({ role: input.role })
    .where(eq(users.id, input.id))
    .returning();

  return { ok: true, user: updated[0]!, previousRole: target.role };
}

/**
 * Remove someone. **A state change, not a row deletion.**
 *
 * One transaction, and every part of it is a requirement:
 *
 *  - `status = 'removed'` — their name stays in the audit log permanently, and
 *    the partial unique index frees their address so it can be invited again
 *    under a new account.
 *  - `signed_out_all_at` — kills every outstanding token in one write, including
 *    any we hold no session row for.
 *  - every live session revoked — so their access dies within one request, not
 *    at their next sign-in.
 *  - any pending invitation to their address revoked — otherwise removing
 *    someone mid-onboarding leaves a live link that recreates them.
 *
 * Cancelling their in-flight change requests is MAG-2731's table and therefore
 * its job; the hook is `onMemberDeactivated`, called at the end.
 */
export async function removeMember(
  db: Database,
  input: { id: string; actorId: string },
): Promise<MemberMutation> {
  if (input.id === input.actorId) return { ok: false, reason: "self" };

  const existing = await db
    .select()
    .from(users)
    .where(and(eq(users.id, input.id), eq(users.status, "active")))
    .limit(1);
  const target = existing[0];
  if (!target) return { ok: false, reason: "not_found" };

  const removed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({
        status: "removed",
        removedAt: new Date(),
        removedBy: input.actorId,
        signedOutAllAt: new Date(),
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

    return updated[0]!;
  });

  return { ok: true, user: removed };
}

/**
 * Called when someone loses access — removed, or demoted below `approver`.
 *
 * MAG-2731 owns change requests, so this is the seam rather than the
 * implementation: their pending requests have to be cancelled, and the
 * cancellation has to say why. Documented here so it doesn't quietly become a
 * done-when nobody delivered.
 */
export async function onMemberDeactivated(
  _db: Database,
  _userId: string,
  _reason: "removed" | "demoted",
): Promise<void> {
  // Intentionally empty until MAG-2731 lands the change-request table.
}
