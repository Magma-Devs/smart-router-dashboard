import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TOTP_DIGITS, TOTP_STEP_SECONDS, TOTP_WINDOW_STEPS } from "@sr/shared";

/**
 * TOTP — RFC 6238, the rotating six-digit code an authenticator app shows.
 *
 * Hand-rolled on `node:crypto` rather than pulled from npm. It is ~60 lines of
 * arithmetic against a frozen spec with published test vectors, and the vectors
 * are in `__tests__/totp.test.ts` — so "does this agree with every other
 * implementation on earth" is a question the test suite answers rather than one
 * a dependency asserts. The alternative was `otplib`: four packages of
 * transitive surface, for something that verifies a credential.
 *
 * **It lives in the api, not in `@sr/shared`, on purpose.** Shared is
 * environment-neutral — the web pulls it into the edge bundle, which has no
 * `node:crypto` — and beyond the build error, code that verifies a secret has no
 * business in a bundle we ship to a browser. The parameters both tiers need
 * (digits, period, window) are in `@sr/shared`'s `constants/two-factor.ts`; the
 * algorithm is here.
 *
 * See `docs/TWO-FACTOR.md` and MAG-2730.
 */

/** Bytes of entropy in a generated secret. 20 bytes is RFC 4226's recommended
 *  minimum for SHA-1 and encodes to exactly 32 base32 characters. */
const SECRET_BYTES = 20;

/** RFC 4648 base32. Authenticator apps read base32 and nothing else. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32-encode, without padding — every authenticator accepts unpadded, and
 *  `=` has to be percent-escaped in the `otpauth://` URI. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Base32-decode. Tolerant on the way in — padding, spaces and lower case are all
 * stripped, because this also parses what a person typed off a screen into a
 * desktop password manager, and "I typed it in groups of four" must not fail.
 *
 * Returns null rather than throwing on a character outside the alphabet: the
 * caller is validating user input, and a thrown error there becomes a 500.
 */
export function base32Decode(input: string): Buffer | null {
  const cleaned = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0) return null;

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret, base32 as the apps expect it. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * The counter value for a moment in time — `floor(unix seconds / 30)`.
 *
 * Exported because it is the unit the **replay guard** stores: `totp_last_step`
 * on the user row is one of these, and "a used code cannot be reused" is
 * "the step must be strictly greater than the last one accepted".
 */
export function totpStepAt(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The code for one step. HOTP (RFC 4226) dynamic truncation over HMAC-SHA1.
 *
 * Returns null when the secret is not decodable — same reason as
 * {@link base32Decode}.
 */
export function totpCodeAtStep(secret: string, step: number): string | null {
  const key = base32Decode(secret);
  if (!key || key.length === 0) return null;

  // 8-byte big-endian counter. Written through a BigInt because a step past
  // 2^31 overflows a 32-bit shift, and that arrives in the year 6053 — which is
  // not the reason to get it right, but the RFC's own last test vector
  // (T = 20000000000) is already past 2^31 and would fail.
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Constant-time string compare. Codes are short and low-entropy, so a timing
 *  side channel is not the realistic attack — but comparing a credential with
 *  `===` is the kind of thing a security review circles, and it costs nothing. */
function codesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifyTotpOptions {
  /** Milliseconds since the epoch. Injectable so tests can pin a step. */
  now?: number;
  /**
   * The last step this account already spent, or null if it never has.
   *
   * **Passing this is what makes a code single-use.** Without it the ±1 window
   * is a 90-second replay window: anyone who observes a code — over the
   * operator's shoulder, in a phished form, in a screen recording — can spend it
   * again while it is still current. The ticket states the requirement
   * separately from the window for that reason.
   */
  lastStep?: number | null;
}

export type VerifyTotpResult =
  /** Accepted. Persist `step` as the account's new `totp_last_step`. */
  | { ok: true; step: number }
  | { ok: false; reason: "malformed" | "bad_secret" | "mismatch" | "reused" };

/**
 * Verify a submitted code.
 *
 * The caller gets back the step that matched and is responsible for storing it —
 * this function is pure, and cannot reach the database. Every call site must
 * write `step` back before returning success, or the replay guard is decorative.
 *
 * `reused` is reported separately from `mismatch` so the api can log which
 * happened. **It must not reach the user**: the ticket requires a generic error
 * with no hint about which factor failed, and "that code was already used" tells
 * an attacker their guess was right.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: VerifyTotpOptions = {},
): VerifyTotpResult {
  const submitted = code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(submitted)) return { ok: false, reason: "malformed" };

  const current = totpStepAt(options.now ?? Date.now());
  const lastStep = options.lastStep ?? null;

  // Walk oldest first so a code that is valid at two steps (possible, at 1 in a
  // million) resolves to the earlier one — which is the conservative choice for
  // a counter that only moves forward.
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset++) {
    const step = current + offset;
    const expected = totpCodeAtStep(secret, step);
    if (expected === null) return { ok: false, reason: "bad_secret" };
    if (!codesMatch(expected, submitted)) continue;
    // Matched — but a step at or below the last one spent is a replay, and
    // saying "the code is right" would defeat the guard rather than enforce it.
    if (lastStep !== null && step <= lastStep) return { ok: false, reason: "reused" };
    return { ok: true, step };
  }

  return { ok: false, reason: "mismatch" };
}

export interface OtpauthUriInput {
  /** Base32 secret, as {@link generateTotpSecret} produced it. */
  secret: string;
  /** What the app shows under the issuer — the person's email address. */
  account: string;
  /** What the app shows as the issuer. The deployment's name, not the product's,
   *  so someone administering two dashboards can tell the entries apart. */
  issuer: string;
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The label is `Issuer:account` **and** `issuer` is repeated as a parameter —
 * Google Authenticator reads the prefix, most others read the parameter, and
 * omitting either produces an entry labelled with a bare email address.
 *
 * Every component is percent-encoded, including the colon-separated label parts:
 * an unescaped `:` or `/` in an address silently truncates the label.
 *
 * **This value never reaches a log or an address bar.** It carries the secret,
 * so it is built server-side, rendered straight into a QR image, and returned
 * once — the ticket states this as a security requirement, and it is the reason
 * the enrolment route returns a data URL rather than redirecting to one.
 */
export function otpauthUri(input: OtpauthUriInput): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
