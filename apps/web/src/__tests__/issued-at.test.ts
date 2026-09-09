import { describe, expect, it } from "vitest";
import { issuedAt } from "@/auth.config";

/**
 * The `iat` claim, and why it must not move.
 *
 * `users.signed_out_all_at` is a cutoff the api compares this against: every
 * token issued at or before it is refused. The web re-signs the token on every
 * session read, so stamping "now" each time would let any tab that reloads
 * carry its own token past the moment the account was signed out everywhere —
 * and that lever is the only one that reaches tokens no session row is held
 * for. Fixing it at sign-in is what makes the cutoff a control.
 */

describe("issuedAt", () => {
  it("keeps the time the session was signed in", () => {
    const signedInAt = 1_760_000_000;
    expect(issuedAt({ iat: signedInAt })).toBe(signedInAt);
  });

  it("does not move across repeated re-encodes", () => {
    const token = { iat: 1_760_000_000 };
    const stamps = [issuedAt(token), issuedAt(token), issuedAt(token)];
    expect(new Set(stamps).size).toBe(1);
  });

  it("stays behind a cutoff stamped after sign-in", () => {
    // What "sign out everywhere" does: stamp a cutoff, then the person's other
    // tab refreshes. Its token has to stay on the losing side of that compare.
    const signedInAt = 1_760_000_000;
    const cutoff = signedInAt + 60;
    expect(issuedAt({ iat: signedInAt })).toBeLessThanOrEqual(cutoff);
  });

  it("uses now for a token that has no issue time yet", () => {
    // The sign-in itself: nothing has been encoded before, so now is right.
    const before = Math.floor(Date.now() / 1000);
    const stamped = issuedAt({});
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it("ignores a value that is not a finite number", () => {
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [undefined, null, "1760000000", Number.NaN, Infinity]) {
      expect(issuedAt({ iat: bad })).toBeGreaterThanOrEqual(now);
    }
    expect(issuedAt(null)).toBeGreaterThanOrEqual(now);
  });
});
