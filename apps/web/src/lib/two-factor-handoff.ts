/**
 * Carrying a two-factor challenge from a Google or GitHub sign-in to the code
 * screen.
 *
 * For an account with an authenticator, the api answers a provider sign-in with
 * a challenge and no session, exactly as it answers a correct password. After a
 * password the login form holds the challenge itself — it made the call. After a
 * provider round-trip nobody in the browser did: Auth.js's `signIn` callback
 * made it, server-side, and then redirects. So the callback parks the challenge
 * here and sends the browser to `/login?step=code`, and the code step reads it
 * back server-side in `authorize`.
 *
 * `httpOnly`, so no page script ever sees the challenge; it never enters a URL.
 * `lax` for the same reason as the invite handoff: it has to ride the redirect.
 * It lives as long as the challenge does, and is burnt the moment it is spent.
 */
export const TWO_FACTOR_HANDOFF_COOKIE = "sr_2fa";

/** The api's challenge lifetime (`CHALLENGE_TTL_MS`). A cookie outliving it
 *  would only carry a dead challenge to a code screen that cannot succeed. */
export const TWO_FACTOR_HANDOFF_MAX_AGE_SECONDS = 5 * 60;

export type HandoffProvider = "google" | "github";

export interface TwoFactorHandoff {
  challenge: string;
  /** Shown on the code screen, so the person knows which account it is for. */
  email: string;
  provider: HandoffProvider;
}

export function encodeHandoff(handoff: TwoFactorHandoff): string {
  return Buffer.from(JSON.stringify(handoff), "utf8").toString("base64url");
}

/** Null for anything that was not written by {@link encodeHandoff} — the cookie
 *  is attacker-writable in the sense that any client can send any cookie, so its
 *  shape is checked before a byte of it is used. */
export function decodeHandoff(value: string | undefined | null): TwoFactorHandoff | null {
  if (!value || value.length > 2048) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { challenge, email, provider } = parsed as Record<string, unknown>;
    if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(challenge)) return null;
    if (typeof email !== "string" || email.length === 0 || email.length > 254) return null;
    if (provider !== "google" && provider !== "github") return null;
    return { challenge, email, provider };
  } catch {
    return null;
  }
}
