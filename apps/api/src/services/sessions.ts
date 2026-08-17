import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { sessions, users, type Database, type Session, type User } from "@sr/db";
import { normalizeIp, parseClient } from "./client-context.js";

/**
 * Server-side sessions — one row per sign-in, addressed by the JWT's `sid`
 * claim and resolved on every authenticated request.
 *
 * This is what makes revocation immediate instead of "at their next sign-in",
 * and it is the difference between the dashboard being able to answer "who is
 * signed in, from where, and can you cut them off" and not.
 *
 * There is deliberately **no cache**. A cache is precisely the thing that would
 * turn "revoked" into "revoked eventually", and the same request already makes
 * multi-second Prometheus round-trips, so one indexed lookup is noise. See
 * `docs/ACCOUNTS-DESIGN.md` §5.4.
 */

/** 30 days, no idle timeout — people use this dashboard all day and shouldn't
 *  be retyping passwords. Must match the web's Auth.js `session.maxAge`. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How stale `last_seen_at` may get before we spend a write on it. The column
 *  feeds a "last active" column in a member list, which does not need
 *  second-level accuracy — and a write per request would be absurd. */
export const TOUCH_INTERVAL_MS = 60_000;

/** Why a session ended. Closed set; `sessions.revoked_reason` is a varchar so
 *  later slices can extend this without a migration. */
export type RevokeReason = "self" | "sign_out_all" | "password_change" | "member_removed" | "admin";

/** What the api could observe about the caller's device. Both halves are
 *  best-effort: a sign-in must never fail for lack of them. */
export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

export interface CreateSessionInput {
  userId: string;
  /** `password` · `google` · `github` · `discord` · `invite`. */
  authMethod: string;
  client: ClientContext;
}

/**
 * Why a session id did not resolve to a usable session. The caller maps these
 * to responses; keeping the rules here rather than in the auth plugin means
 * they are testable in one place and can't drift between call sites.
 */
export type SessionRejection = "not_found" | "revoked" | "expired" | "user_inactive" | "signed_out";

export type SessionCheck =
  { ok: true; session: Session; user: User } | { ok: false; reason: SessionRejection };

/** Open a session. Returns the row so the caller can put its id in the token. */
export async function createSession(db: Database, input: CreateSessionInput): Promise<Session> {
  const rows = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      authMethod: input.authMethod,
      ip: normalizeIp(input.client.ip),
      userAgent: input.client.userAgent ?? null,
      client: parseClient(input.client.userAgent),
    })
    .returning();

  const created = rows[0];
  if (!created) throw new Error("session insert returned no row");

  // Signing in is activity. Without this the member list shows "last active: —"
  // for somebody who arrived ten seconds ago, because `touchSession` is
  // throttled to once a minute and has therefore never run for a new session.
  await db.update(users).set({ lastActiveAt: created.createdAt }).where(eq(users.id, input.userId));

  return created;
}

/**
 * Resolve a session id to its live session and account, applying every reason a
 * token may no longer be honoured:
 *
 *  1. the session row is gone, revoked, or past its expiry;
 *  2. the account is suspended or removed;
 *  3. the token predates the account's bulk revocation cutoff.
 *
 * (3) is the second half of the revocation story: `signed_out_all_at` kills
 * every outstanding token in one write without enumerating rows, while
 * `revoked_at` kills one device. Neither replaces the other (design §5.3).
 *
 * `tokenIssuedAtSec` is the JWT's `iat`. The comparison is `<=`, not `<`:
 * both sides have one-second resolution, so a token minted in the same second
 * as the revocation must lose — otherwise an attacker who races the user's
 * sign-out keeps a live session.
 */
export async function checkSession(
  db: Database,
  sessionId: string,
  tokenIssuedAtSec: number | undefined,
): Promise<SessionCheck> {
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };

  const { session, user } = row;
  if (session.revokedAt) return { ok: false, reason: "revoked" };
  if (session.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (user.status !== "active") return { ok: false, reason: "user_inactive" };

  if (user.signedOutAllAt) {
    const cutoffSec = Math.floor(user.signedOutAllAt.getTime() / 1000);
    if ((tokenIssuedAtSec ?? 0) <= cutoffSec) return { ok: false, reason: "signed_out" };
  }

  return { ok: true, session, user };
}

/**
 * Record that a session was used, at most once per `TOUCH_INTERVAL_MS`.
 * Best-effort by contract: the caller does not await a failure path, because a
 * heartbeat is never a reason to fail the request it rode in on.
 */
export async function touchSession(db: Database, session: Session): Promise<void> {
  if (Date.now() - session.lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return;
  const now = new Date();
  await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, session.id));
  await db.update(users).set({ lastActiveAt: now }).where(eq(users.id, session.userId));
}

/**
 * Revoke one session. Returns false when there was nothing live to revoke, so
 * the caller can 404 rather than reporting a revocation that didn't happen.
 * Never deletes: a revoked session is evidence, and MAG-2770's access events
 * reference it.
 */
export async function revokeSession(
  db: Database,
  sessionId: string,
  opts: { reason: RevokeReason; by?: string | null },
): Promise<boolean> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: opts.reason, revokedBy: opts.by ?? null })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length > 0;
}

/**
 * Revoke every live session for one account and return how many were closed.
 *
 * Callers that need *every* outstanding token gone — password change, removal —
 * must also stamp `users.signed_out_all_at`; see `signOutEverywhere`.
 */
export async function revokeAllForUser(
  db: Database,
  userId: string,
  opts: { reason: RevokeReason; by?: string | null; except?: string },
): Promise<number> {
  const where = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (opts.except) where.push(sql`${sessions.id} <> ${opts.except}`);

  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: opts.reason, revokedBy: opts.by ?? null })
    .where(and(...where))
    .returning({ id: sessions.id });
  return revoked.length;
}

/**
 * The full stop: close every session row *and* stamp the cutoff, so tokens we
 * have no row for (and any minted in the same instant) are refused too.
 */
export async function signOutEverywhere(
  db: Database,
  userId: string,
  opts: { reason: RevokeReason; by?: string | null },
): Promise<number> {
  const count = await revokeAllForUser(db, userId, opts);
  await db.update(users).set({ signedOutAllAt: new Date() }).where(eq(users.id, userId));
  return count;
}

/** Live sessions for one account, newest first. Powers the account page. */
export async function listActiveSessions(db: Database, userId: string): Promise<Session[]> {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(sessions.createdAt));
}
