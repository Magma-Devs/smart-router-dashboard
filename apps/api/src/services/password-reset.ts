import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { passwordResets, users, type Database, type User } from "@sr/db";
import { hashPassword } from "./password.js";
import { revokeAllForUser, signOutEverywhere } from "./sessions.js";

/**
 * Password reset — a single-use link that lets someone set **their own**
 * password.
 *
 * The shape is the same in both deployment modes; only who starts it and how it
 * travels differ. What is identical, and is the point, is that **nobody ever
 * sets somebody else's password**. An admin on-prem generates a *link*; the
 * account holder chooses the value. lava-connect's equivalent endpoint takes a
 * password in the body, and that is precisely the design this rejects: it lets
 * an admin take an account over and sign in as them, which is exactly the
 * takeover the audit log exists to make visible.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §6.3.
 */

const TOKEN_BYTES = 32;

/** Managed can re-send cheaply and the user is at their keyboard; an on-prem
 *  link is handed over by a person and may wait until tomorrow. */
export const RESET_TTL_MS = {
  managed: 60 * 60 * 1000,
  onprem: 24 * 60 * 60 * 1000,
} as const;

export type DeploymentMode = keyof typeof RESET_TTL_MS;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function resetUrl(webOrigin: string, rawToken: string): string {
  return `${webOrigin.replace(/\/+$/, "")}/reset/${rawToken}`;
}

export interface CreatedReset {
  rawToken: string;
  expiresAt: Date;
}

/**
 * Issue a reset link for an account.
 *
 * `createdBy` is null when the holder asked for it and set when an admin did —
 * the column an auditor reads to tell "I forgot my password" from "someone else
 * started this".
 *
 * Any earlier unused link for the account is invalidated, so asking twice
 * doesn't leave two live ways in.
 */
export async function createPasswordReset(
  db: Database,
  input: { userId: string; mode: DeploymentMode; createdBy?: string | null },
): Promise<CreatedReset> {
  await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResets.userId, input.userId), isNull(passwordResets.usedAt)));

  const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TTL_MS[input.mode]);
  await db.insert(passwordResets).values({
    userId: input.userId,
    tokenHash: hashToken(rawToken),
    createdBy: input.createdBy ?? null,
    expiresAt,
  });

  return { rawToken, expiresAt };
}

export type ResetRejection = "not_found" | "used" | "expired" | "user_inactive";

export type ResetOutcome =
  | { ok: true; user: User }
  | { ok: false; reason: ResetRejection };

/**
 * Consume a reset link and set the new password.
 *
 * Three things happen together, and all three matter:
 *
 *  1. the token is claimed with a conditional update, so it is single-use even
 *     if two tabs submit at once;
 *  2. the password is written;
 *  3. **every session for that account is revoked** — both the per-device rows
 *     and the `signed_out_all_at` cutoff. A reset is what someone does when
 *     they think their account is compromised, so leaving the attacker's
 *     session alive would defeat the entire point.
 *
 * It deliberately does **not** sign anyone in: the person proves the new
 * password works by using it.
 */
export async function consumePasswordReset(
  db: Database,
  rawToken: string,
  newPassword: string,
): Promise<ResetOutcome> {
  const rows = await db
    .select({ reset: passwordResets, user: users })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(eq(passwordResets.tokenHash, hashToken(rawToken)))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.reset.usedAt) return { ok: false, reason: "used" };
  if (row.reset.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (row.user.status !== "active") return { ok: false, reason: "user_inactive" };

  const claimed = await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResets.id, row.reset.id), isNull(passwordResets.usedAt)))
    .returning({ id: passwordResets.id });
  if (claimed.length === 0) return { ok: false, reason: "used" };

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, passwordUpdatedAt: new Date() })
    .where(eq(users.id, row.user.id));

  await signOutEverywhere(db, row.user.id, { reason: "password_change" });

  return { ok: true, user: { ...row.user, passwordHash } };
}

/** Set a password for someone who is signed in and knows their current one.
 *  Revokes every *other* session — they keep the one they're using, because
 *  being logged out of the tab you just changed your password in is hostile. */
export async function changeOwnPassword(
  db: Database,
  userId: string,
  newPassword: string,
  keepSessionId: string,
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, passwordUpdatedAt: new Date() })
    .where(eq(users.id, userId));

  // Per-device revoke, not the cutoff: `signed_out_all_at` compares against the
  // token's `iat` and would kill the surviving session too. Being logged out of
  // the tab you just changed your password in is hostile, so the other devices
  // go and this one stays.
  await revokeAllForUser(db, userId, { reason: "password_change", except: keepSessionId });
}
