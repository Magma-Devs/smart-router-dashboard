import { sql } from "drizzle-orm";
import { createDb, users, type DbHandle } from "@sr/db";
import { DATABASE_URL } from "./env.js";

/**
 * Direct access to the accounts database, for the two things HTTP cannot do:
 * start from an empty deployment, and age a row.
 *
 * Everything else a spec needs goes through the api — a test that wrote a user
 * row by hand would be asserting against state the product never produces.
 */

let handle: DbHandle | null = null;

function db(): DbHandle {
  handle ??= createDb(DATABASE_URL);
  return handle;
}

export async function closeDb(): Promise<void> {
  if (handle) {
    await handle.sql.end();
    handle = null;
  }
}

/**
 * Back to a deployment with nobody in it — the state `/auth/setup` requires.
 *
 * `users` cascades to sessions, invitations, resets and two-factor challenges,
 * but the audit log and the login-attempt counters are deliberately not tied to
 * a user row (an attempt against an address that does not exist is still worth
 * counting), so they are cleared by name.
 */
export async function resetDeployment(): Promise<void> {
  await db().sql`
    truncate table
      users,
      sessions,
      invitations,
      password_resets,
      two_factor_challenges,
      login_attempts,
      audit_event_changes,
      audit_events
    restart identity cascade
  `;
}

/**
 * Move an account's first sign-in back in time.
 *
 * The grace period is thirty days from that moment and the countdown is derived
 * from it on every read, so this is how a test reaches day 25 without waiting
 * 25 days. `created_by_setup` goes with it: only the account the installer
 * created may defer at all, and the two facts are read together.
 */
export async function ageIntoGracePeriod(email: string, daysAgo: number): Promise<void> {
  const updated = await db()
    .db.update(users)
    .set({
      createdBySetup: true,
      firstSignInAt: sql`now() - (${daysAgo} * interval '1 day')`,
    })
    .where(sql`${users.email} = ${email}`)
    .returning({ id: users.id });

  if (updated.length !== 1) {
    throw new Error(`ageIntoGracePeriod: ${email} matched ${updated.length} rows, expected 1`);
  }
}
