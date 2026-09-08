import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { toString as qrToString } from "qrcode";
import {
  twoFactorChallenges,
  users,
  type Database,
  type User,
} from "@sr/db";
import { TOTP_DEFAULT_ISSUER } from "@sr/shared";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp.js";
import { config } from "../config.js";

/**
 * Two-factor enrolment, verification and the grace period. MAG-2730.
 *
 * Three things live here that the routes deliberately do not do for themselves:
 * the secret is only ever sealed or opened through {@link seal}/{@link open},
 * a code is only ever checked through {@link consumeCode} (which advances the
 * replay guard in the same statement that accepts it), and "may this person
 * still defer" is answered in exactly one place.
 *
 * See `docs/TWO-FACTOR.md`.
 */

// ── Encryption at rest ──────────────────────────────────────────────────────

/**
 * AES-256-GCM. The stored value is `base64(iv | tag | ciphertext)` — one column,
 * no second table, and the tag means a tampered row fails to open rather than
 * decrypting to garbage that then gets HMAC'd.
 *
 * **The key is not derived from `AUTH_SECRET`,** which was the obvious shortcut.
 * `AUTH_SECRET` is a session-signing key and rotating it is a routine, expected
 * operation; if it also unlocked the authenticator secrets, that rotation would
 * silently invalidate every enrolled phone in the deployment at once. Those two
 * blast radii must not be the same.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

/**
 * The encryption key, resolved once.
 *
 * Accepts base64 or hex, and requires exactly 32 bytes. Throws when it is
 * missing or the wrong length — the same posture `PUBLIC_WEB_ORIGIN` takes:
 * there is no safe default, and a generated-per-boot key would encrypt secrets
 * that the next restart could not read, which presents as "everyone's
 * authenticator broke overnight".
 */
export function totpKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = (process.env.TOTP_ENCRYPTION_KEY ?? config.auth.totpEncryptionKey ?? "").trim();
  if (!raw) {
    throw new Error(
      "TOTP_ENCRYPTION_KEY is not set. Two-factor secrets are encrypted at rest and there is no safe default — generate one with `openssl rand -base64 32`.",
    );
  }

  const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `TOTP_ENCRYPTION_KEY must decode to 32 bytes (got ${decoded.length}). Generate one with \`openssl rand -base64 32\`.`,
    );
  }

  cachedKey = decoded;
  return cachedKey;
}

/** Tests only — a process never re-resolves the key. */
export function resetTotpKeyForTests(): void {
  cachedKey = null;
}

/** True when a usable key is configured. Read at boot so a deployment finds out
 *  from a startup log rather than from the first person trying to enrol. */
export function totpKeyConfigured(): boolean {
  try {
    totpKey();
    return true;
  } catch {
    return false;
  }
}

export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", totpKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** Null when the envelope is malformed, truncated or fails its tag — a row
 *  written under a different key, or tampered with. Never throws: the caller is
 *  in the middle of a sign-in, and a 500 there is a lockout. */
export function open(envelope: string): string | null {
  try {
    const buf = Buffer.from(envelope, "base64");
    if (buf.length <= IV_BYTES + TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", totpKey(), buf.subarray(0, IV_BYTES));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

// ── Enrolment ───────────────────────────────────────────────────────────────

export interface EnrolmentOffer {
  /** Base32, for a desktop password manager that cannot scan. */
  secret: string;
  /** An inline SVG QR of the `otpauth://` URI. Rendered here, never handed to
   *  the browser as a URL to fetch: the URI carries the secret, and a URL is a
   *  thing that lands in an address bar, a proxy log and a browser history. */
  qrSvg: string;
  issuer: string;
}

/** What an authenticator app shows as the issuer. Overridable per deployment so
 *  an operator with two dashboards can tell the two entries apart. */
export function totpIssuer(): string {
  return (process.env.TOTP_ISSUER ?? config.auth.totpIssuer ?? TOTP_DEFAULT_ISSUER).trim();
}

/**
 * Offer a secret, without enrolling.
 *
 * The secret is sealed onto the row immediately but `totp_enrolled_at` stays
 * null, so the account is **not** yet protected and the old secret — if any — is
 * already gone. That ordering is deliberate: the alternative (hold the pending
 * secret somewhere else until confirmation) means two places can claim to know
 * the account's secret, and the failure mode of getting that wrong is an account
 * that accepts codes from a phone its owner has thrown away.
 *
 * Re-offering is therefore safe and idempotent-ish: each call replaces the
 * pending secret, and only {@link confirmEnrolment} makes one live.
 */
export async function beginEnrolment(db: Database, user: User): Promise<EnrolmentOffer> {
  const secret = generateTotpSecret();
  const issuer = totpIssuer();

  await db
    .update(users)
    .set({ totpSecret: seal(secret), totpEnrolledAt: null, totpLastStep: null })
    .where(eq(users.id, user.id));

  const qrSvg = await qrToString(otpauthUri({ secret, account: user.email, issuer }), {
    type: "svg",
    margin: 1,
    // Medium recovery is what every authenticator's own documentation shows,
    // and it keeps the module count low enough to stay scannable at 180px.
    errorCorrectionLevel: "M",
  });

  return { secret, qrSvg, issuer };
}

export type ConfirmOutcome =
  | { ok: true; user: User }
  | { ok: false; reason: "no_pending" | "bad_code" };

/**
 * Turn a pending secret into an enrolled one, by proving a code from it.
 *
 * The confirming code's step is stored as `totp_last_step` in the same write, so
 * the code someone typed to enrol cannot then be replayed to sign in — the
 * enrolment screen and the login screen share one counter.
 */
export async function confirmEnrolment(
  db: Database,
  user: User,
  code: string,
): Promise<ConfirmOutcome> {
  if (!user.totpSecret || user.totpEnrolledAt) return { ok: false, reason: "no_pending" };

  const secret = open(user.totpSecret);
  if (!secret) return { ok: false, reason: "no_pending" };

  const result = verifyTotp(secret, code, { lastStep: user.totpLastStep });
  if (!result.ok) return { ok: false, reason: "bad_code" };

  const updated = await db
    .update(users)
    .set({ totpEnrolledAt: new Date(), totpLastStep: result.step })
    .where(eq(users.id, user.id))
    .returning();

  return { ok: true, user: updated[0]! };
}

/** True when this account is protected. The pending-secret state reads false,
 *  which is what makes "the member list's second `no` means something is wrong"
 *  honest — a half-finished enrolment is not enrolment. */
export function isEnrolled(user: Pick<User, "totpSecret" | "totpEnrolledAt">): boolean {
  return !!user.totpSecret && !!user.totpEnrolledAt;
}

/**
 * Clear someone's authenticator. The lost-phone path, and the only one.
 *
 * The old secret is destroyed rather than disabled, so there is nothing left to
 * restore and nothing an admin could read back. The admin never sees or sets the
 * replacement — the user enrols again on their next sign-in, from a secret only
 * they will ever hold.
 */
export async function clearEnrolment(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ totpSecret: null, totpEnrolledAt: null, totpLastStep: null })
    .where(eq(users.id, userId));
}

// ── Verifying a code at sign-in ─────────────────────────────────────────────

export type CodeOutcome = { ok: true } | { ok: false; reason: "not_enrolled" | "bad_code" };

/**
 * Check a code and spend it, in one conditional update.
 *
 * The `totp_last_step` guard is in the WHERE clause, not in a read-then-write:
 * two tabs submitting the same code at the same instant would otherwise both
 * read the old step, both verify, and both be let in. Here the second UPDATE
 * matches no row and the second caller is refused.
 *
 * The distinction between a wrong code and a reused one stays inside this
 * function. The route reports one generic failure — the ticket requires no hint
 * about which factor failed, and "that code was already used" tells an attacker
 * their guess was correct.
 */
export async function consumeCode(db: Database, user: User, code: string): Promise<CodeOutcome> {
  if (!isEnrolled(user)) return { ok: false, reason: "not_enrolled" };

  const secret = open(user.totpSecret!);
  if (!secret) return { ok: false, reason: "bad_code" };

  const result = verifyTotp(secret, code, { lastStep: user.totpLastStep });
  if (!result.ok) return { ok: false, reason: "bad_code" };

  const claimed = await db
    .update(users)
    .set({ totpLastStep: result.step })
    .where(
      and(
        eq(users.id, user.id),
        // Strictly-increasing, enforced by the database. `is null` covers the
        // first code an account ever spends.
        user.totpLastStep === null
          ? isNull(users.totpLastStep)
          : eq(users.totpLastStep, user.totpLastStep),
      ),
    )
    .returning({ id: users.id });

  if (claimed.length === 0) return { ok: false, reason: "bad_code" };
  return { ok: true };
}

// ── The challenge between the two sign-in screens ───────────────────────────

const CHALLENGE_TOKEN_BYTES = 32;

/**
 * Five minutes. This is the gap between typing a password and typing a code with
 * a phone already in hand, not a link handed over by a colleague — so it is
 * minutes rather than the hours an invite or a reset gets. Long enough to
 * unlock a phone and find the app; short enough that a challenge left in a
 * closed tab is dead before anyone could find it.
 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export interface IssuedChallenge {
  token: string;
  expiresAt: Date;
}

/**
 * Issue the ticket that carries a verified password to the code screen.
 *
 * Any earlier unspent challenge for the account is retired first, so a password
 * verified twice does not leave two live ways to reach the second step.
 */
export async function issueChallenge(db: Database, userId: string): Promise<IssuedChallenge> {
  await db
    .update(twoFactorChallenges)
    .set({ usedAt: new Date() })
    .where(and(eq(twoFactorChallenges.userId, userId), isNull(twoFactorChallenges.usedAt)));

  const token = randomBytes(CHALLENGE_TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await db
    .insert(twoFactorChallenges)
    .values({ userId, tokenHash: hashToken(token), expiresAt });

  return { token, expiresAt };
}

export type ChallengeOutcome =
  | { ok: true; user: User }
  | { ok: false; reason: "not_found" | "used" | "expired" | "user_inactive" };

/**
 * Spend a challenge.
 *
 * Claimed with a conditional UPDATE before anything else happens, so it is
 * single-use even against two tabs submitting at once — and claimed *before* the
 * code is checked, deliberately: a challenge that survived a wrong code would
 * let someone brute-force codes against one password verification, which is the
 * whole thing the second factor is for. A wrong code costs a fresh sign-in.
 */
export async function consumeChallenge(db: Database, token: string): Promise<ChallengeOutcome> {
  const rows = await db
    .select({ challenge: twoFactorChallenges, user: users })
    .from(twoFactorChallenges)
    .innerJoin(users, eq(users.id, twoFactorChallenges.userId))
    .where(eq(twoFactorChallenges.tokenHash, hashToken(token)))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.challenge.usedAt) return { ok: false, reason: "used" };
  if (row.challenge.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (row.user.status !== "active") return { ok: false, reason: "user_inactive" };

  const claimed = await db
    .update(twoFactorChallenges)
    .set({ usedAt: new Date() })
    .where(
      and(eq(twoFactorChallenges.id, row.challenge.id), isNull(twoFactorChallenges.usedAt)),
    )
    .returning({ id: twoFactorChallenges.id });
  if (claimed.length === 0) return { ok: false, reason: "used" };

  return { ok: true, user: row.user };
}

/** Retire every unspent challenge for an account. Called when 2FA is reset — a
 *  challenge issued against the old secret must not survive it. */
export async function revokeChallenges(db: Database, userId: string): Promise<void> {
  await db
    .update(twoFactorChallenges)
    .set({ usedAt: new Date() })
    .where(and(eq(twoFactorChallenges.userId, userId), isNull(twoFactorChallenges.usedAt)));
}

// ── The grace period ────────────────────────────────────────────────────────

/**
 * How long the first admin on a fresh install may defer.
 *
 * Thirty days, and the number has a reason beyond taste: AWS made MFA mandatory
 * for root users with a 35-day window from first console sign-in, so a security
 * questionnaire answered with "enforced, with a 30-day grace period" is answered
 * with something a reviewer already recognises. "Optional for admins" is the
 * line they circle.
 */
export const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export interface TwoFactorStatus {
  enrolled: boolean;
  /** True while this person may still reach the dashboard without enrolling. */
  mayDefer: boolean;
  /** When deferring stops working. Null when it never applied, or is over. */
  graceEndsAt: Date | null;
  /** Whole days left, rounded up, so the last day reads "1 day left" rather
   *  than "0 days left" while the dashboard still opens. Null when no countdown
   *  applies. */
  daysLeft: number | null;
  /** True when the dashboard must stay shut until they enrol. */
  enrolmentRequired: boolean;
}

/**
 * Where this person stands. **The single place that answers it** — the api gate,
 * the invite route, the account route and the header countdown all read this,
 * so none of them can drift into a different opinion about whose clock is
 * running.
 *
 * The grace period is the first admin's alone. Everyone else arrives by
 * invitation, and by then the deployment is somebody's responsibility rather
 * than something a person is poking at — the ticket's own reasoning, and why
 * an invite-only trigger would be wrong: a one-person deployment never invites
 * anyone, so the highest-privilege account in the system would run forever with
 * no second factor.
 */
export function twoFactorStatus(
  user: Pick<
    User,
    "totpSecret" | "totpEnrolledAt" | "createdBySetup" | "firstSignInAt"
  >,
  now: number = Date.now(),
): TwoFactorStatus {
  if (isEnrolled(user)) {
    return {
      enrolled: true,
      mayDefer: false,
      graceEndsAt: null,
      daysLeft: null,
      enrolmentRequired: false,
    };
  }

  // Not the first admin ⇒ no grace, ever. This is the invited-user path.
  if (!user.createdBySetup || !user.firstSignInAt) {
    return {
      enrolled: false,
      mayDefer: false,
      graceEndsAt: null,
      daysLeft: null,
      enrolmentRequired: true,
    };
  }

  const graceEndsAt = new Date(user.firstSignInAt.getTime() + GRACE_PERIOD_MS);
  const remaining = graceEndsAt.getTime() - now;
  if (remaining <= 0) {
    return {
      enrolled: false,
      mayDefer: false,
      graceEndsAt,
      daysLeft: 0,
      enrolmentRequired: true,
    };
  }

  return {
    enrolled: false,
    mayDefer: true,
    graceEndsAt,
    daysLeft: Math.ceil(remaining / (24 * 60 * 60 * 1000)),
    enrolmentRequired: false,
  };
}
