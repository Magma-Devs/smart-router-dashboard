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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The suite wipes this database, so it only ever opens one on this machine. */
export function assertDisposableDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `E2E_DATABASE_URL points at ${host}; the suite truncates every table it ` +
        `finds, so it refuses any database that is not on localhost.`,
    );
  }
}

function db(): DbHandle {
  if (!handle) {
    assertDisposableDatabase(DATABASE_URL);
    handle = createDb(DATABASE_URL);
  }
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
 * Every table in `public`, read from the catalog rather than listed, so a table
 * a later migration adds starts empty too. Drizzle's own journal lives in the
 * `drizzle` schema and is untouched, so the api does not re-run migrations.
 */
export async function resetDeployment(): Promise<void> {
  const { sql } = db();
  const tables = await sql<{ name: string }[]>`
    select format('%I.%I', schemaname, tablename) as name
    from pg_tables where schemaname = 'public'
  `;
  if (tables.length === 0) return;
  await sql.unsafe(
    `truncate table ${tables.map((t) => t.name).join(", ")} restart identity cascade`,
  );
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
