import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { users } from "./schema.js";

export interface SeedAdminOptions {
  email: string;
  password: string;
  name?: string;
}

export interface SeedResult {
  /** "created" → admin was inserted; "promoted" → existing user promoted;
   *  "skipped" → already an admin; "noop" → table populated, email absent. */
  status: "created" | "promoted" | "skipped" | "noop";
  reason?: string;
}

/**
 * Bootstrap an initial admin user from env vars. Idempotent and safe to
 * run on every api startup:
 *
 *   1. If a user with `email` already exists → ensure role=admin (promote
 *      if needed) and skip.
 *   2. Else if the users table is empty → insert the admin user.
 *   3. Else → no-op (the admin email isn't registered and the table has
 *      other users; we don't mass-promote silently).
 *
 * Hashing uses bcrypt at cost 12.
 */
export async function seedAdmin(db: Database, opts: SeedAdminOptions): Promise<SeedResult> {
  // Scoped to active accounts throughout: a removed person's row keeps their
  // email (that is what makes the audit trail readable), so an unscoped lookup
  // would try to promote a departed account, and an unscoped count would treat
  // a deployment whose only rows are removed people as "populated".
  const existing = await db
    .select()
    .from(users)
    .where(and(eq(users.email, opts.email), eq(users.status, "active")))
    .limit(1);
  const found = existing[0];

  if (found) {
    if (found.role === "admin") return { status: "skipped", reason: "admin already present" };
    await db.update(users).set({ role: "admin" }).where(eq(users.id, found.id));
    return { status: "promoted", reason: "existing user promoted to admin" };
  }

  // Only create when there are no active users — we don't want to silently
  // insert an admin into a populated install.
  const countRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.status, "active"));
  const count = countRow[0]?.count ?? 0;
  if (count > 0) {
    return { status: "noop", reason: "table populated and admin email not present" };
  }

  const passwordHash = await bcrypt.hash(opts.password, 12);
  await db.insert(users).values({
    email: opts.email,
    name: opts.name ?? "Admin",
    passwordHash,
    role: "admin",
  });
  return { status: "created" };
}
