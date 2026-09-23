import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { loginAttempts, type Database } from "@sr/db";

/**
 * Per-account sign-in lockout.
 *
 * The per-IP limit already on `/auth/*` is not the control that matters: a
 * distributed attacker rotating addresses walks straight past it, and with a
 * permissive `trustProxy` they needn't even rotate anything. This counts
 * failures against the **identity being targeted**, so the wall stands in front
 * of the account rather than in front of one network path.
 *
 * Counted on the submitted address whether or not an account exists, so being
 * locked out reveals nothing about whether one does — the same reason sign-in
 * answers identically for a wrong password and an unknown address.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §7.3.
 */

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export interface LockState {
  locked: boolean;
  /** When the lock lifts — surfaced so the response can say "try again in N
   *  minutes" rather than leaving someone guessing. */
  until: Date | null;
}

export async function checkLock(db: Database, email: string): Promise<LockState> {
  const rows = await db
    .select()
    .from(loginAttempts)
    .where(eq(loginAttempts.email, email.toLowerCase()))
    .limit(1);

  const row = rows[0];
  if (!row?.lockedUntil) return { locked: false, until: null };
  if (row.lockedUntil.getTime() <= Date.now()) return { locked: false, until: null };
  return { locked: true, until: row.lockedUntil };
}

/**
 * Record a failure and lock the account once the threshold is crossed.
 *
 * The window is *sliding on the counter, not the clock*: a slow drip of
 * attempts still trips the limit, because the count only resets when the window
 * has genuinely lapsed since it started or on a successful sign-in.
 */
export async function recordFailure(db: Database, email: string): Promise<LockState> {
  const key = email.toLowerCase();

  // The window boundary is computed **in SQL**, from the database's clock.
  //
  // Two reasons, one of which cost an afternoon. It is more correct — the app
  // and the database can disagree about the time, and this is a security
  // window. And a bare JS `Date` interpolated into a `sql` template is not
  // portable: pglite accepts it, postgres-js throws
  // `ERR_INVALID_ARG_TYPE: Received an instance of Date`. Tests that only ever
  // run on pglite will not catch that.
  const windowFloor = sql`now() - make_interval(secs => ${LOCKOUT_WINDOW_MS / 1000})`;

  const rows = await db
    .insert(loginAttempts)
    .values({ email: key, failedCount: 1 })
    .onConflictDoUpdate({
      target: loginAttempts.email,
      set: {
        // Restart the count when the previous window has lapsed; otherwise add
        // to it. Done in SQL so two concurrent failures can't both read 4.
        failedCount: sql`case when ${loginAttempts.windowStart} < ${windowFloor}
                              then 1 else ${loginAttempts.failedCount} + 1 end`,
        windowStart: sql`case when ${loginAttempts.windowStart} < ${windowFloor}
                              then now() else ${loginAttempts.windowStart} end`,
      },
    })
    .returning();

  const row = rows[0];
  if (!row) return { locked: false, until: null };

  await pruneLapsed(db);

  if (row.failedCount >= LOCKOUT_MAX_FAILURES) {
    const until = new Date(row.windowStart.getTime() + LOCKOUT_WINDOW_MS);
    await db.update(loginAttempts).set({ lockedUntil: until }).where(eq(loginAttempts.email, key));
    return { locked: true, until };
  }
  return { locked: false, until: null };
}

/** Rows removed per failure. Fixed, so a failure under attack pays a bounded
 *  cost rather than a table scan, and always removes more than it adds. */
export const PRUNE_BATCH = 100;

/**
 * Delete rows whose window has lapsed and that hold no live lock.
 *
 * Every address anyone types lands here, account or not — that is what makes
 * a lockout reveal nothing. Without this nothing ever left: a credential-
 * stuffing run grew the table without bound, and the table kept a record of
 * every address ever tried. Pruning on the failure path makes the size follow
 * failures *per window* instead of failures *ever*.
 */
export async function pruneLapsed(db: Database): Promise<void> {
  const windowFloor = sql`now() - make_interval(secs => ${LOCKOUT_WINDOW_MS / 1000})`;
  const lapsed = db
    .select({ email: loginAttempts.email })
    .from(loginAttempts)
    .where(
      and(
        lt(loginAttempts.windowStart, windowFloor),
        or(isNull(loginAttempts.lockedUntil), lte(loginAttempts.lockedUntil, sql`now()`)),
      ),
    )
    .orderBy(loginAttempts.windowStart)
    .limit(PRUNE_BATCH);
  await db.delete(loginAttempts).where(inArray(loginAttempts.email, lapsed));
}

/** A successful sign-in clears the slate — otherwise a person who mistyped four
 *  times would stay one slip from a lockout for the rest of the window. */
export async function clearFailures(db: Database, email: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.email, email.toLowerCase()));
}
