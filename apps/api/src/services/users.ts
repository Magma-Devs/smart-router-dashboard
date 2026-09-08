import { and, eq, sql } from "drizzle-orm";
import { users, type Database, type User } from "@sr/db";
import type { Role } from "@sr/shared";

/** What sign-in flows return to the web — never the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: Role;
}

export function toPublicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl, role: u.role };
}

/**
 * Look up a *living* account by email.
 *
 * Scoped to `status = 'active'` throughout: a removed person keeps their row
 * and their email — that is what makes the audit trail readable — so an
 * unscoped lookup would hand their account back to whoever signs in next. The
 * partial unique index guarantees at most one active row per address.
 */
export async function findUserByEmail(db: Database, email: string): Promise<User | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = lower(${email})`, eq(users.status, "active")))
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserById(db: Database, id: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Stamp a successful sign-in.
 *
 * `first_signin_at` is set once and never again — it is when the first admin's
 * 2FA grace period starts counting, so it must survive every later sign-in.
 * `coalesce` in SQL rather than a read-then-write: two concurrent sign-ins would
 * otherwise race, and the database's own clock is the right one for a security
 * window (same reasoning as the lockout's window boundary).
 *
 * `now()` rather than an interpolated `Date`: pglite accepts a JS Date in a
 * `sql` template and postgres-js throws `ERR_INVALID_ARG_TYPE`, so a test-only
 * suite would not catch it.
 */
export async function recordSignIn(db: Database, id: string): Promise<void> {
  await db
    .update(users)
    .set({
      lastSignInAt: new Date(),
      firstSignInAt: sql`coalesce(${users.firstSignInAt}, now())`,
    })
    .where(eq(users.id, id));
}
