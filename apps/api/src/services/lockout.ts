import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { loginAttempts, type Database } from "@sr/db";

/**
 * Per-account lockout: a budget of attempts per address per window, counted
 * whether or not an account exists, so a lockout says nothing about membership.
 * It fences the identity rather than one network path — the only limit a
 * spoofed `X-Forwarded-For` cannot sidestep. See `docs/ACCOUNTS-DESIGN.md` §7.3.
 */

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export interface LockState {
  /** True when THIS attempt is refused. */
  locked: boolean;
  /** When the lock lifts, for `Retry-After`. */
  until: Date | null;
  /** Attempts counted this window, including this one. */
  attempts: number;
}

/** The window's start, from the database's clock rather than the app's. */
const windowFloor = () => sql`now() - make_interval(secs => ${LOCKOUT_WINDOW_MS / 1000})`;

/** Read-only: is this address locked right now, by the database's clock? */
export async function checkLock(db: Database, email: string): Promise<LockState> {
  const rows = await db
    .select({
      until: loginAttempts.lockedUntil,
      active: sql<boolean>`coalesce(${loginAttempts.lockedUntil} > now(), false)`,
      attempts: loginAttempts.failedCount,
    })
    .from(loginAttempts)
    .where(eq(loginAttempts.email, email.toLowerCase()))
    .limit(1);
  const row = rows[0];
  if (!row?.active) return { locked: false, until: null, attempts: row?.attempts ?? 0 };
  return { locked: true, until: row.until, attempts: row.attempts };
}

/**
 * Spend one attempt against an address, BEFORE the credential is checked.
 *
 * The upsert hands each request its own count, so a parallel burst cannot all
 * pass a read-then-check: the attempt after the budget is refused before
 * bcrypt. The window is fixed from its first attempt and restarts once it
 * lapses. A correct credential refunds the attempt through `clearFailures`.
 */
export async function recordAttempt(db: Database, email: string): Promise<LockState> {
  const key = email.toLowerCase();
  const floor = windowFloor();
  const rows = await db
    .insert(loginAttempts)
    .values({ email: key, failedCount: 1 })
    .onConflictDoUpdate({
      target: loginAttempts.email,
      set: {
        failedCount: sql`case when ${loginAttempts.windowStart} < ${floor}
                              then 1 else ${loginAttempts.failedCount} + 1 end`,
        windowStart: sql`case when ${loginAttempts.windowStart} < ${floor}
                              then now() else ${loginAttempts.windowStart} end`,
      },
    })
    .returning();

  await pruneLapsed(db);

  const row = rows[0];
  if (!row) return { locked: false, until: null, attempts: 0 };

  // The budget is spent once the count reaches the maximum; the attempt that
  // reaches it still gets its answer, and every attempt past it is refused.
  if (row.failedCount < LOCKOUT_MAX_FAILURES) {
    return { locked: false, until: null, attempts: row.failedCount };
  }
  const until = new Date(row.windowStart.getTime() + LOCKOUT_WINDOW_MS);
  if (!row.lockedUntil || row.lockedUntil.getTime() !== until.getTime()) {
    await db.update(loginAttempts).set({ lockedUntil: until }).where(eq(loginAttempts.email, key));
  }
  return { locked: row.failedCount > LOCKOUT_MAX_FAILURES, until, attempts: row.failedCount };
}

/** A correct credential refunds the window — otherwise someone who mistyped
 *  four times would stay one slip from a lockout until it lapsed. */
export async function clearFailures(db: Database, email: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.email, email.toLowerCase()));
}

/** Rows removed per attempt: bounded, so pruning never becomes a table scan,
 *  and always more than an attempt adds. */
export const PRUNE_BATCH = 100;

/**
 * Delete rows whose window has lapsed and that hold no live lock. Every address
 * anyone types gets a row, so this is what keeps the table sized by attempts
 * per window, not attempts ever — and keeps it from recording every address
 * anyone has tried.
 */
export async function pruneLapsed(db: Database): Promise<void> {
  const lapsed = db
    .select({ email: loginAttempts.email })
    .from(loginAttempts)
    .where(
      and(
        lt(loginAttempts.windowStart, windowFloor()),
        or(isNull(loginAttempts.lockedUntil), lte(loginAttempts.lockedUntil, sql`now()`)),
      ),
    )
    .orderBy(loginAttempts.windowStart)
    .limit(PRUNE_BATCH);
  await db.delete(loginAttempts).where(inArray(loginAttempts.email, lapsed));
}

/** What a refused attempt tells the person: seconds for `Retry-After`, and the
 *  same thing in words. Safe to say — addresses with no account lock too. */
export function lockedReply(until: Date | null): { retryAfterSec?: number; message: string } {
  if (!until) return { message: "Too many failed attempts. Try again later." };
  const retryAfterSec = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
  const minutes = Math.ceil(retryAfterSec / 60);
  return {
    retryAfterSec,
    message: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
  };
}
