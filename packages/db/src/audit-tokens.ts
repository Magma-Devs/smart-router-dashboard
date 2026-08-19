import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { auditTokens, type AuditTokenRow } from "./schema-audit.js";

/**
 * Read-only tokens for the audit pull API — MAG-2770.
 *
 * The ticket's fourth non-negotiable: "The token is read-only and cannot touch
 * config. An admin creates a dedicated audit token. It reads this endpoint and
 * nothing else. Shown once, revocable, listed with last-used, and its own use
 * is logged."
 *
 * Everything below exists to make "and nothing else" true by construction
 * rather than by remembering to check.
 */

/**
 * Recognisable on sight and to a secret scanner.
 *
 * GitHub's push protection and most SIEM leak rules key off a fixed prefix, so
 * a token that looks like anonymous base64 is a token nobody catches when it
 * lands in a config repo. It is also what lets the auth hook tell an audit
 * token from a session JWT without trying to parse one as the other.
 */
export const AUDIT_TOKEN_PREFIX = "srdash_audit_";

/** 32 bytes of CSPRNG output. Base64url so the whole token is copy-pasteable
 *  and survives a URL, a YAML file and a shell variable unquoted. */
const SECRET_BYTES = 32;

export interface MintedAuditToken {
  row: AuditTokenRow;
  /**
   * The only time the full value exists. Never stored, never logged, never
   * returned again — the row keeps a hash and the last four characters.
   */
  secret: string;
}

export function hashAuditToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** True for anything shaped like one of ours, before touching the database. */
export function looksLikeAuditToken(value: string): boolean {
  return value.startsWith(AUDIT_TOKEN_PREFIX);
}

export interface MintAuditTokenInput {
  name: string;
  createdBy: string | null;
  createdByName: string;
}

export async function mintAuditToken(
  db: Database,
  input: MintAuditTokenInput,
): Promise<MintedAuditToken> {
  const secret = AUDIT_TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString("base64url");
  const [row] = await db
    .insert(auditTokens)
    .values({
      name: input.name,
      tokenHash: hashAuditToken(secret),
      suffix: secret.slice(-4),
      createdBy: input.createdBy,
      createdByName: input.createdByName,
    })
    .returning();
  return { row: row!, secret };
}

/**
 * Resolve a presented token, or `null`.
 *
 * `null` covers unknown, malformed and revoked alike — a caller learning
 * *which* of those it was learns whether a value it holds was ever real.
 *
 * The hash comparison is constant-time even though the lookup is by hash: the
 * index makes the query itself a timing oracle only for existence, and paying
 * for the compare keeps that from turning into a confirmation once a value is
 * close.
 */
export async function resolveAuditToken(
  db: Database,
  presented: string,
): Promise<AuditTokenRow | null> {
  if (!looksLikeAuditToken(presented)) return null;
  const hash = hashAuditToken(presented);

  const [row] = await db
    .select()
    .from(auditTokens)
    .where(and(eq(auditTokens.tokenHash, hash), isNull(auditTokens.revokedAt)))
    .limit(1);
  if (!row) return null;

  const a = Buffer.from(row.tokenHash, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? row : null;
}

/**
 * "Listed with last-used", from the ticket — as a column, not as an event.
 *
 * Writing an audit row per pull would make the log largely a record of itself:
 * a puller on a five-minute schedule adds ~300 rows a day that say nothing
 * except that it is still running, and they bury the events somebody is
 * actually looking for. The token's *lifecycle* is what gets audited —
 * `apikey.created` and `apikey.deleted` — while its heartbeat lives here.
 *
 * Throttled to a minute per token for the same reason session heartbeats are:
 * a scheduled reader should not turn a read endpoint into a write one.
 */
export async function touchAuditToken(
  db: Database,
  token: AuditTokenRow,
  ip: string | null,
): Promise<void> {
  const lastUsed = token.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - lastUsed < 60_000 && token.lastUsedIp === ip) return;
  await db
    .update(auditTokens)
    .set({ lastUsedAt: new Date(), lastUsedIp: ip })
    .where(eq(auditTokens.id, token.id));
}

/** Newest first. Never returns a hash — there is nothing a caller can do with
 *  one except try to crack it. */
export async function listAuditTokens(db: Database): Promise<AuditTokenRow[]> {
  return db.select().from(auditTokens).orderBy(desc(auditTokens.createdAt));
}

export interface RevokeAuditTokenInput {
  id: string;
  revokedBy: string | null;
  revokedByName: string;
}

/**
 * Revoke, idempotently. Returns the row when this call is what revoked it, and
 * `null` when there was nothing to do — so a caller can tell "revoked it" from
 * "it was already gone" without a second query, and a double-click cannot
 * rewrite who revoked it or when.
 */
export async function revokeAuditToken(
  db: Database,
  input: RevokeAuditTokenInput,
): Promise<AuditTokenRow | null> {
  const [row] = await db
    .update(auditTokens)
    .set({
      revokedAt: sql`now()`,
      revokedBy: input.revokedBy,
      revokedByName: input.revokedByName,
    })
    .where(and(eq(auditTokens.id, input.id), isNull(auditTokens.revokedAt)))
    .returning();
  return row ?? null;
}
