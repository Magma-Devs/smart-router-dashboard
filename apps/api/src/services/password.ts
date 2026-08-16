import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";

/** bcrypt cost 12 — same as lava-connect (industry default). */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Password policy, aligned to NIST 800-63B — which is what auditors reference,
 * and which is mostly a list of things *not* to do.
 *
 * Length is the only rule. **No composition requirements** ("must contain a
 * symbol") and **no forced expiry**: scheduled rotation makes people choose
 * worse passwords, and rotation belongs on evidence of compromise. What does
 * real work is checking the password against known-breached corpora, below.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

/**
 * bcrypt truncates at 72 **bytes** and says nothing about it. 64 characters is
 * within that for ASCII but not for UTF-8 — "all characters accepted, including
 * spaces" means someone can submit 64 emoji. Silently hashing a prefix would
 * make the tail of their password decorative, so we refuse instead.
 */
const BCRYPT_MAX_BYTES = 72;

export type PasswordProblem =
  | { code: "too_short"; message: string }
  | { code: "too_long"; message: string }
  | { code: "too_many_bytes"; message: string }
  | { code: "breached"; message: string };

/**
 * Shape checks only — no network. Returns the first problem, or null.
 * `checkPasswordBreached` is the separate, fallible half.
 */
export function validatePasswordShape(plain: string): PasswordProblem | null {
  // Count code points, not UTF-16 units: `"🔥".length` is 2, and telling
  // someone their 20-character password is "at most 64 characters" too long
  // would be nonsense. Grapheme clusters would be truer still, but code points
  // are the standard approximation and the byte guard below is the real limit.
  const length = [...plain].length;

  if (length < PASSWORD_MIN_LENGTH) {
    return {
      code: "too_short",
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    };
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return {
      code: "too_long",
      message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    };
  }
  if (Buffer.byteLength(plain, "utf8") > BCRYPT_MAX_BYTES) {
    return {
      code: "too_many_bytes",
      message:
        "Password is too long once encoded. Try a shorter one, or fewer non-Latin characters.",
    };
  }
  return null;
}

/** HIBP's p99 is well under 500 ms; capping at 750 keeps sign-up latency bounded
 *  if it degrades. */
const HIBP_TIMEOUT_MS = 750;
const HIBP_URL = "https://api.pwnedpasswords.com/range/";

export interface BreachCheckResult {
  breached: boolean;
  /** True when the corpus could not be consulted — the answer is "don't know",
   *  reported as not-breached. Callers may log it; nobody blocks on it. */
  indeterminate: boolean;
  reason?: string;
}

/**
 * Check the password against HaveIBeenPwned's breached-password corpus using
 * **k-anonymity**: SHA-1 the password, send only the first five hex characters,
 * and scan the response for the matching suffix. The full hash never leaves
 * this process, so the service learns nothing about the password.
 *
 * `Add-Padding` asks HIBP to pad the response to a uniform size, so an observer
 * can't infer the prefix's hit count from response length. Padded entries come
 * back with `:0` and are ignored.
 *
 * **Fails open**, deliberately, and for a reason lava-connect didn't have: an
 * on-prem deployment may have no egress at all, and failing closed would make
 * the first admin account uncreatable — locking an operator out of their own
 * install to enforce a defence-in-depth check. `PASSWORD_BREACH_CHECK=off`
 * turns it off explicitly, which is the honest thing for an air-gapped site to
 * do rather than relying on a silent timeout.
 */
export async function checkPasswordBreached(
  plain: string,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<BreachCheckResult> {
  if ((process.env.PASSWORD_BREACH_CHECK ?? "hibp").toLowerCase() === "off") {
    return { breached: false, indeterminate: true, reason: "disabled" };
  }

  const sha1 = createHash("sha1").update(plain, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  let body: string;
  try {
    const res = await fetch(`${HIBP_URL}${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "smart-router-dashboard" },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const reason = `status_${res.status}`;
      log?.warn({ event: "hibp_fail_open", reason }, "breach check unavailable, allowing");
      return { breached: false, indeterminate: true, reason };
    }
    body = await res.text();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.warn({ event: "hibp_fail_open", reason }, "breach check unavailable, allowing");
    return { breached: false, indeterminate: true, reason };
  }

  // Each line is `SUFFIX:COUNT`. Padding entries carry COUNT=0 and are not hits.
  for (const line of body.split("\n")) {
    const [hashSuffix, countStr] = line.trim().split(":");
    if (hashSuffix === suffix && Number(countStr) > 0) {
      return { breached: true, indeterminate: false };
    }
  }
  return { breached: false, indeterminate: false };
}

/**
 * The whole policy: shape, then corpus. Returns the first problem, or null.
 *
 * Every path that writes a password goes through this — first-run setup, invite
 * redemption, reset, and change. Not just "change password": the weakest
 * password on a deployment is usually the first one anyone set.
 */
export async function validatePassword(
  plain: string,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<PasswordProblem | null> {
  const shape = validatePasswordShape(plain);
  if (shape) return shape;

  const breach = await checkPasswordBreached(plain, log);
  if (breach.breached) {
    return {
      code: "breached",
      message:
        "This password has appeared in a known data breach. Please choose a different one.",
    };
  }
  return null;
}
