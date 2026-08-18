import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { invitations, users, type Database, type Invitation, type User } from "@sr/db";
import type { Role } from "@sr/shared";
import { hashPassword } from "./password.js";

/**
 * Invitations — after first-run setup, the only way an account comes into
 * existence.
 *
 * Two properties carry the security of the whole flow:
 *
 * **The account is created with the invitation's email, never the submitted
 * one.** That makes "redeemable only by the address it was sent to" structural
 * rather than a check someone can forget — the redeemer never supplies an
 * address at all.
 *
 * **The raw token exists only inside the link.** The row stores its SHA-256, so
 * a database read — a backup, a log, a support screenshot — can't be turned
 * back into a working invitation.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §6.2.
 */

const TOKEN_BYTES = 32;

/** Managed can resend an email cheaply; an on-prem link travels over a channel
 *  we don't control, so it gets the shorter life. */
export const INVITE_TTL_MS = {
  managed: 7 * 24 * 60 * 60 * 1000,
  onprem: 24 * 60 * 60 * 1000,
} as const;

export type DeploymentMode = keyof typeof INVITE_TTL_MS;

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** The link the invitee clicks. The token is in the **web** route, which is
 *  unavoidable for something delivered by email or copy-paste; it is never in
 *  an api URL (see `docs/AUTH.md` → link tokens). */
export function inviteUrl(webOrigin: string, rawToken: string): string {
  return `${webOrigin.replace(/\/+$/, "")}/invite/${rawToken}`;
}

export interface CreatedInvitation {
  invitation: Invitation;
  /** Returned to the caller **once**. Never stored, never logged. */
  rawToken: string;
}

export type CreateInviteResult =
  | { ok: true; created: CreatedInvitation }
  | { ok: false; reason: "already_member" | "already_invited" };

/**
 * Invite an address. Refuses when it already belongs to an active account, or
 * already has a live invitation — an admin is entitled to know both, so this
 * isn't an enumeration surface the way the public sign-in path is.
 */
export async function createInvitation(
  db: Database,
  input: { email: string; role: Role; createdBy: string; mode: DeploymentMode },
): Promise<CreateInviteResult> {
  const email = input.email.toLowerCase();

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, eq(users.status, "active")))
    .limit(1);
  if (existing[0]) return { ok: false, reason: "already_member" };

  if (await findPendingByEmail(db, email)) {
    return { ok: false, reason: "already_invited" };
  }

  const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const rows = await db
    .insert(invitations)
    .values({
      email,
      role: input.role,
      tokenHash: hashToken(rawToken),
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS[input.mode]),
    })
    .returning();

  const invitation = rows[0];
  if (!invitation) throw new Error("invitation insert returned no row");
  return { ok: true, created: { invitation, rawToken } };
}

/** A live (unredeemed, unrevoked, unexpired) invitation for this address. */
export async function findPendingByEmail(db: Database, email: string): Promise<Invitation | null> {
  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = ${email.toLowerCase()}`,
        isNull(invitations.redeemedAt),
        isNull(invitations.revokedAt),
        sql`${invitations.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Everything not yet redeemed — including expired and revoked, so the admin
 *  screen can show what happened rather than silently dropping rows. */
export async function listInvitations(db: Database): Promise<Invitation[]> {
  return db
    .select()
    .from(invitations)
    .where(isNull(invitations.redeemedAt))
    .orderBy(desc(invitations.createdAt));
}

export type InviteRejection = "not_found" | "revoked" | "redeemed" | "expired";

export type InviteLookup =
  | { ok: true; invitation: Invitation }
  | {
      ok: false;
      reason: InviteRejection;
      /** The invitation, when we found one — so a caller can name it in an
       *  audit row or an error without a second read. */
      invitation?: Invitation;
      /** True only on the read that first observed the expiry, so
       *  `invite.expired` fires exactly once without a sweeper. */
      justExpired?: boolean;
    };

/**
 * Resolve a raw token, applying every reason it may no longer work.
 *
 * Expiry stamps `expired_noted_at` the first time it is seen, so
 * `invite.expired` can fire exactly once without a sweeper watching the clock.
 */
export async function lookupInvitation(db: Database, rawToken: string): Promise<InviteLookup> {
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, hashToken(rawToken)))
    .limit(1);

  const invitation = rows[0];
  if (!invitation) return { ok: false, reason: "not_found" };
  if (invitation.redeemedAt) return { ok: false, reason: "redeemed", invitation };
  if (invitation.revokedAt) return { ok: false, reason: "revoked", invitation };

  if (invitation.expiresAt.getTime() <= Date.now()) {
    // Conditional on expired_noted_at being null, so concurrent reads can't
    // both claim to be the first — exactly one gets a row back.
    const noted = await db
      .update(invitations)
      .set({ expiredNotedAt: new Date() })
      .where(and(eq(invitations.id, invitation.id), isNull(invitations.expiredNotedAt)))
      .returning({ id: invitations.id });
    return { ok: false, reason: "expired", invitation, justExpired: noted.length > 0 };
  }

  return { ok: true, invitation };
}

export type RedeemResult =
  { ok: true; user: User; invitation: Invitation } | { ok: false; reason: InviteRejection };

export interface RedeemInput {
  rawToken: string;
  password: string;
  name?: string | null;
}

/**
 * Redeem an invitation and create the account, in **one transaction**.
 *
 * The single-use guarantee is the conditional UPDATE below, not a prior read:
 * `WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`.
 * Zero rows affected means somebody else got there first, and the whole
 * transaction unwinds — so a race can't produce two accounts from one invite.
 *
 * "Redeemable only by the address it was invited" needs no check here: the
 * insert takes `invitation.email` and there is no other address in scope. It
 * used to need one, when a redeemer could arrive holding a Google identity
 * asserting a *different* verified address — removing social sign-in turned a
 * comparison that could be forgotten into a property of the statement.
 */
export async function redeemInvitation(db: Database, input: RedeemInput): Promise<RedeemResult> {
  const lookup = await lookupInvitation(db, input.rawToken);
  if (!lookup.ok) return { ok: false, reason: lookup.reason };
  const invitation = lookup.invitation;

  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(invitations)
      .set({ redeemedAt: new Date() })
      .where(
        and(
          eq(invitations.id, invitation.id),
          isNull(invitations.redeemedAt),
          isNull(invitations.revokedAt),
          sql`${invitations.expiresAt} > now()`,
        ),
      )
      .returning({ id: invitations.id });

    if (claimed.length === 0) {
      // Someone redeemed it between the lookup and here.
      return { ok: false, reason: "redeemed" as const };
    }

    const inserted = await tx
      .insert(users)
      .values({
        // The invitation's address. Never the submitted one.
        email: invitation.email,
        name: input.name ?? null,
        role: invitation.role,
        status: "active",
        passwordHash,
        passwordUpdatedAt: new Date(),
      })
      .returning();

    const user = inserted[0];
    if (!user) throw new Error("invited user insert returned no row");

    await tx
      .update(invitations)
      .set({ redeemedUserId: user.id })
      .where(eq(invitations.id, invitation.id));

    return { ok: true, user, invitation };
  });
}

/** Mint a fresh token for a live invitation, invalidating the previous link. */
export async function resendInvitation(
  db: Database,
  id: string,
  mode: DeploymentMode,
): Promise<CreatedInvitation | null> {
  const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const rows = await db
    .update(invitations)
    .set({
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS[mode]),
      expiredNotedAt: null,
      resendCount: sql`${invitations.resendCount} + 1`,
    })
    .where(
      and(eq(invitations.id, id), isNull(invitations.redeemedAt), isNull(invitations.revokedAt)),
    )
    .returning();

  const invitation = rows[0];
  return invitation ? { invitation, rawToken } : null;
}

/** Kill a live invitation. Returns null when there was nothing to revoke. */
export async function revokeInvitation(
  db: Database,
  id: string,
  by: string,
): Promise<Invitation | null> {
  const rows = await db
    .update(invitations)
    .set({ revokedAt: new Date(), revokedBy: by })
    .where(
      and(eq(invitations.id, id), isNull(invitations.redeemedAt), isNull(invitations.revokedAt)),
    )
    .returning();
  return rows[0] ?? null;
}
