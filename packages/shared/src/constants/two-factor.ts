/**
 * The TOTP parameters, in the one place both tiers read them.
 *
 * We build against **Google Authenticator** — the standard scheme: HMAC-SHA1,
 * 30-second steps, six digits. 1Password and Authy work too, but Google
 * Authenticator is what we document and test.
 *
 * None of this is configurable. An authenticator app cannot be told the period
 * out of band, several popular apps ignore the `otpauth://` parameters entirely,
 * and a mismatch presents as "the code is always wrong" with nothing to debug
 * from. So the numbers are constants, and they live here rather than in the api
 * because the web needs them too — the code input's length, and the countdown
 * ring on the enrolment screen.
 *
 * **The algorithm itself is not here.** `packages/shared` is environment-neutral
 * — the web pulls it into the edge bundle, which has no `node:crypto` — so
 * verification lives in `apps/api/src/services/totp.ts`. That split is load
 * bearing: a secret should not be verifiable in a bundle we ship to a browser.
 *
 * See `docs/TWO-FACTOR.md` and MAG-2730.
 */

/** Seconds per code. */
export const TOTP_STEP_SECONDS = 30;

/** Digits in a code. The web uses this for `maxLength` and the paste handler. */
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of "now" are accepted.
 *
 * The ticket: "accept the code from the previous and next window, so a slightly
 * wrong phone clock still works". One step each way is ±30s of skew, which
 * covers a phone that never synced without widening the guessing window — each
 * extra step is one more code an attacker may hit.
 */
export const TOTP_WINDOW_STEPS = 1;

/** What an authenticator app shows as the issuer, when the deployment does not
 *  override it with `TOTP_ISSUER`. */
export const TOTP_DEFAULT_ISSUER = "Smart Router";
