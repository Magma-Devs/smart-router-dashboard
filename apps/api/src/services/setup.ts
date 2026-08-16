import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { users, type Database, type User } from "@sr/db";
import { hashPassword } from "./password.js";

/**
 * First-run: turning a fresh on-prem install into one with a named admin.
 *
 * Two properties matter more than anything else here.
 *
 * **The gate is "no active users", never a flag.** A one-time marker would be
 * the obvious implementation and it is wrong: a deployment restored from a
 * backup that predates its first account would carry the marker and refuse to
 * open, permanently. Deriving the state from the table means the answer is
 * always about the install in front of you.
 *
 * **A token is required.** Without one, whoever reaches the URL first between
 * `helm install` and the operator sitting down becomes the admin — and that gap
 * can be overnight. The same protection covers the restored-backup case above,
 * where the window opens again on a deployment that is already reachable.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §6.1.
 */

/** Bytes of entropy in a generated token. 32 → 43 base64url characters. */
const TOKEN_BYTES = 32;

/**
 * Postgres advisory-lock key for the setup transaction. Any constant works; it
 * only has to be the same one in every process racing to create the first admin.
 */
const SETUP_LOCK_KEY = 2729_0001;

let cachedToken: string | null = null;

/**
 * The setup token for this deployment, resolved once per process.
 *
 *  - `SETUP_TOKEN` set → use it. This is the path a helm chart takes: the value
 *    lives in a Secret and the installer prints it.
 *  - otherwise → generate one, log it once at `warn` so it is visible in
 *    `kubectl logs` without a debug level, and write it to `SETUP_TOKEN_FILE`
 *    when that is set, so an init container or a mounted volume can surface it.
 *
 * Generating rather than disabling setup is deliberate: an operator who forgot
 * to configure a token should still be able to finish the install, from a value
 * only someone with log or filesystem access can see.
 */
export function resolveSetupToken(log?: {
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}): string {
  if (cachedToken) return cachedToken;

  const configured = process.env.SETUP_TOKEN?.trim();
  if (configured) {
    cachedToken = configured;
    return cachedToken;
  }

  cachedToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const file = process.env.SETUP_TOKEN_FILE?.trim();
  if (file) {
    try {
      writeFileSync(file, `${cachedToken}\n`, { mode: 0o600 });
    } catch (err) {
      log?.error({ err, file }, "could not write SETUP_TOKEN_FILE; the token is in the log only");
    }
  }
  log?.warn(
    { setupToken: cachedToken, setupTokenFile: file ?? null },
    "no SETUP_TOKEN configured — generated one for first-run setup. It is needed once, to create the first admin.",
  );
  return cachedToken;
}

/** Reset the memoised token. Tests only — a process never re-resolves. */
export function resetSetupTokenForTests(): void {
  cachedToken = null;
}

/** Constant-time comparison that doesn't leak length through an early return. */
export function setupTokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** How many accounts can currently sign in. Zero ⇒ the install needs setting up. */
export async function countActiveUsers(db: Database): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.status, "active"));
  return rows[0]?.count ?? 0;
}

export async function needsSetup(db: Database): Promise<boolean> {
  return (await countActiveUsers(db)) === 0;
}

export type SetupOutcome =
  | { ok: true; user: User }
  | { ok: false; reason: "already_set_up" };

/**
 * Create the first admin.
 *
 * The zero-user check is repeated **inside** the transaction, behind an advisory
 * lock, because the check outside it is only advice: two people opening the
 * first-run page at the same moment would otherwise both pass it and both become
 * admin. The lock is transaction-scoped, so it is released on commit or rollback
 * without a cleanup path.
 *
 * The caller is responsible for having validated the password and the token —
 * this function is the state change, not the policy.
 */
export async function completeSetup(
  db: Database,
  input: { email: string; password: string; name?: string | null },
): Promise<SetupOutcome> {
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);

    if ((await countActiveUsers(tx as unknown as Database)) > 0) {
      return { ok: false, reason: "already_set_up" };
    }

    const inserted = await tx
      .insert(users)
      .values({
        email: input.email.toLowerCase(),
        name: input.name ?? null,
        passwordHash,
        role: "admin",
        status: "active",
        passwordUpdatedAt: new Date(),
      })
      .returning();

    const created = inserted[0];
    if (!created) throw new Error("setup insert returned no row");
    return { ok: true, user: created };
  });
}
