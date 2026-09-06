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

export type OAuthProvider = "google" | "github" | "discord";

const PROVIDER_ID_COLUMN = {
  google: users.googleId,
  github: users.githubId,
  discord: users.discordId,
} as const;

export interface OAuthProfile {
  providerId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * OAuth upsert (lava-connect's pattern, condensed): find by provider id →
 * fall back to email match (links the provider to the existing account) →
 * create. Avatar is backfill-only — written when null, never overwritten,
 * so the first linked provider with a picture wins.
 */
export async function upsertOAuthUser(
  db: Database,
  provider: OAuthProvider,
  profile: OAuthProfile,
): Promise<User> {
  const idColumn = PROVIDER_ID_COLUMN[provider];

  const byProvider = await db
    .select()
    .from(users)
    .where(eq(idColumn, profile.providerId))
    .limit(1);
  if (byProvider[0]) {
    const u = byProvider[0];
    // A provider id still points at a removed or suspended account. Refuse
    // rather than reviving it — otherwise removal is undone by signing in with
    // Google. (Slice 3 makes this path link-only, which removes the last way an
    // account can appear without an invitation.)
    if (u.status !== "active") {
      throw new Error("This account is no longer active");
    }
    if (!u.avatarUrl && profile.avatarUrl) {
      await db.update(users).set({ avatarUrl: profile.avatarUrl }).where(eq(users.id, u.id));
      return { ...u, avatarUrl: profile.avatarUrl };
    }
    return u;
  }

  if (profile.email) {
    const byEmail = await findUserByEmail(db, profile.email);
    if (byEmail) {
      const patch: Partial<typeof users.$inferInsert> = {
        [providerKey(provider)]: profile.providerId,
      };
      if (!byEmail.avatarUrl && profile.avatarUrl) patch.avatarUrl = profile.avatarUrl;
      if (!byEmail.name && profile.name) patch.name = profile.name;
      await db.update(users).set(patch).where(eq(users.id, byEmail.id));
      return { ...byEmail, ...patch } as User;
    }
  }

  if (!profile.email) {
    throw new Error(`${provider} profile has no email — cannot create an account`);
  }

  const inserted = await db
    .insert(users)
    .values({
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      [providerKey(provider)]: profile.providerId,
    })
    .returning();
  const created = inserted[0];
  if (!created) throw new Error("insert returned no row");
  return created;
}

function providerKey(provider: OAuthProvider): "googleId" | "githubId" | "discordId" {
  return provider === "google" ? "googleId" : provider === "github" ? "githubId" : "discordId";
}
