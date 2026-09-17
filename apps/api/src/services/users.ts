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
 * Resolve an OAuth profile to an existing account: find by provider id → fall
 * back to email match, which links the provider to that account. **Never
 * creates** — see the throw at the end for why. Avatar is backfill-only,
 * written when null and never overwritten, so the first linked provider with a
 * picture wins.
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

  // LINK ONLY — never create.
  //
  // This used to fall through to an insert, which was correct while accounts
  // came only from a seed: there was nothing to bypass. The moment invitations
  // exist it is a hole big enough to walk through — anyone with a Google
  // account reaches POST /auth/oauth/google and provisions themselves, which
  // defeats both "redeemable only by the address it was sent to" and the
  // done-when "an invite redeemed from a different email address is refused".
  //
  // Account creation now lives in exactly two places, and both are deliberate:
  // first-run setup, and invite redemption. Redeeming *with* Google goes
  // through `redeemInvitation`, which links the provider id as it inserts.
  throw new OAuthAccountNotFoundError(
    profile.email
      ? `No account for ${profile.email}. Ask an administrator for an invitation.`
      : `That ${provider} account has no verified email address.`,
  );
}

/** Raised when an OAuth sign-in matches no existing account. Distinct from a
 *  bad token so the route can answer 403-with-a-reason rather than 401. */
export class OAuthAccountNotFoundError extends Error {}

function providerKey(provider: OAuthProvider): "googleId" | "githubId" | "discordId" {
  return provider === "google" ? "googleId" : provider === "github" ? "githubId" : "discordId";
}
