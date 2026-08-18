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

export async function recordSignIn(db: Database, id: string): Promise<void> {
  await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, id));
}
