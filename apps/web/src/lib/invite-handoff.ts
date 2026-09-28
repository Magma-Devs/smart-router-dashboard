/**
 * Carrying an invitation token through the Google round-trip.
 *
 * Redeeming with Google is two facts that arrive at different moments: the
 * invitation token, which the browser has from the start, and a verified Google
 * identity, which only exists after the provider redirects back. Auth.js owns
 * that round-trip, and its `signIn` callback is handed the id_token but knows
 * nothing about which page started the flow.
 *
 * So the token is parked in a cookie for the length of the round-trip and read
 * back in that callback. Not the OAuth `state`, which Auth.js owns and signs
 * for its own CSRF purposes and which is not ours to extend.
 *
 * `httpOnly` so page scripts can't read it back out: the token is a bearer
 * credential, and while it already sits in the URL the person is holding, that
 * is no reason to hand it to every script on the origin as well. `lax` because
 * the cookie must survive Google's top-level redirect back to us — `strict`
 * would drop it precisely then, which is the one moment it is needed.
 */
export const INVITE_HANDOFF_COOKIE = "sr_invite";

/** Long enough for a person to work through a Google consent screen, short
 *  enough that an abandoned attempt does not leave the token on the machine. */
export const INVITE_HANDOFF_MAX_AGE_SECONDS = 10 * 60;

/** Tokens are 32 random bytes, base64url. Anything else was not minted here and
 *  is refused before it reaches a cookie. */
export function looksLikeInviteToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(value);
}
