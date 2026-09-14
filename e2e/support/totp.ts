import { createHmac } from "node:crypto";
import { TOTP_DIGITS, TOTP_STEP_SECONDS } from "@sr/shared";

/**
 * RFC 6238 code generation — enough of it to stand in for a phone.
 *
 * **This is the fourth copy in the repo** (`apps/api/src/services/totp.ts` is
 * the implementation under test, and the two `scripts/sanity-*.mjs` runners
 * carry their own). It is not shared on purpose: the api's module is inside a
 * package this one cannot import from without adopting its tsconfig and its
 * build output, and a test that imported the implementation would be checking
 * that a function agrees with itself. The parameters that must not drift —
 * digits and step length — do come from `@sr/shared`, which is where they live
 * precisely so four hand-rolled generators can share the numbers.
 */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of text.replace(/[\s=-]/g, "").toUpperCase()) {
    const idx = B32_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`not base32: ${JSON.stringify(text)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const STEP_MS = TOTP_STEP_SECONDS * 1000;

/** The counter the router's clock is on right now. */
export function currentStep(now: number = Date.now()): number {
  return Math.floor(now / STEP_MS);
}

/** The code an authenticator would show for `step`. */
export function codeAtStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  // 64-bit: a `<< 32` shift silently wraps and fails the RFC's own T=20000000000
  // vector. The api's implementation makes the same choice for the same reason.
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * A stand-in for the phone, with the one piece of state that matters: which
 * step it has already spent.
 *
 * The api accepts a code from the step before or after the current one, and
 * separately refuses any step at or below the last one it accepted. Those two
 * rules collide in a test that generates twice inside thirty seconds — the
 * second code verifies against the window and is then refused as a replay,
 * which reads as "the code was wrong". Both `scripts/sanity-*.mjs` runners hit
 * this, in three places between them, and worked around it case by case.
 *
 * So `next()` waits for a step this authenticator has not used before handing
 * one out. Waiting is the honest fix: it is what the person with the phone does.
 */
export class Authenticator {
  private lastStep = -1;

  constructor(readonly secret: string) {}

  /** The code showing now, once "now" is a step this has not already spent. */
  async next(): Promise<string> {
    while (currentStep() <= this.lastStep) {
      // Sleep to just past the next boundary rather than polling.
      const msToBoundary = STEP_MS - (Date.now() % STEP_MS) + 250;
      await new Promise((r) => setTimeout(r, msToBoundary));
    }
    this.lastStep = currentStep();
    return codeAtStep(this.secret, this.lastStep);
  }

  /**
   * A well-formed code that is certain not to verify — the api's "wrong code"
   * path rather than its "malformed" one.
   *
   * Chosen against every step in the acceptance window, not by nudging one
   * digit: a nudged code lands on a neighbouring step's real code about three
   * times in a million, and a test that fails that rarely is a test nobody ever
   * diagnoses.
   */
  wrong(): string {
    const step = currentStep();
    const real = new Set([step - 1, step, step + 1].map((s) => codeAtStep(this.secret, s)));
    for (let n = 0; n <= real.size; n++) {
      const candidate = String(n).padStart(TOTP_DIGITS, "0");
      if (!real.has(candidate)) return candidate;
    }
    /* istanbul ignore next -- more candidates than window steps, always */
    throw new Error("no wrong code available");
  }
}
