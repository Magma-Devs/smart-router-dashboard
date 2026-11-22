import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { sessions, users, type Database } from "@sr/db";
import type { Role } from "@sr/shared";

/**
 * The one person every visitor is when Ask runs with accounts off
 * (`ASK_DATA_GUEST=true`). Ask's history, runs and budget checks key on a
 * `users` row and a live `sessions` row, so the guest is both, at fixed ids.
 * It has no password and no linked provider, and its address is on the
 * reserved `.invalid` domain, so no sign-in can reach it.
 */
export const ASK_GUEST_USER_ID = "a5c0a5c0-0000-4000-8000-000000000001";
export const ASK_GUEST_SESSION_ID = "a5c0a5c0-0000-4000-8000-000000000002";
const ASK_GUEST_EMAIL = "ask-guest@guest.invalid";

export interface AskPerson {
  id: string;
  role: Role;
  sessionId: string;
}

/** The guest as Ask's routes see it. Read-only: it never holds the off switch. */
export const askGuest: AskPerson = {
  id: ASK_GUEST_USER_ID,
  role: "read_only",
  sessionId: ASK_GUEST_SESSION_ID,
};

/**
 * Guest mode's boot step, after migrations: the guest row active and its
 * session live, whatever an earlier accounts-mode boot left. The session runs
 * ten years from each boot, so a running deployment never outlives it.
 */
export async function ensureAskGuest(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({
        id: ASK_GUEST_USER_ID,
        email: ASK_GUEST_EMAIL,
        name: "Guest",
        role: "read_only",
        status: "active",
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { status: "active", role: "read_only", removedAt: null, removedBy: null },
      });
    const expiresAt = sql`now() + interval '10 years'`;
    await tx
      .insert(sessions)
      .values({
        id: ASK_GUEST_SESSION_ID,
        userId: ASK_GUEST_USER_ID,
        expiresAt,
        authMethod: "ask_guest",
      })
      .onConflictDoUpdate({
        target: sessions.id,
        set: { expiresAt, revokedAt: null, revokedBy: null, revokedReason: null },
      });
  });
}

/**
 * Accounts mode's boot step, after migrations and before the first-run check:
 * a guest an earlier guest-mode boot left is removed and its session revoked,
 * so it counts as no account, appears as no member and can run nothing. Its
 * chats stay with it until retention deletes them.
 */
export async function retireAskGuest(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(sessions)
      .set({ revokedAt: sql`now()`, revokedReason: "ask_guest_retired" })
      .where(and(eq(sessions.id, ASK_GUEST_SESSION_ID), isNull(sessions.revokedAt)));
    await tx
      .update(users)
      .set({ status: "removed", removedAt: sql`now()` })
      .where(and(eq(users.id, ASK_GUEST_USER_ID), ne(users.status, "removed")));
  });
}
