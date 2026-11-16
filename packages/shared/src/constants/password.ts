/**
 * The password rule, in the one place both tiers read it. The api enforces the
 * lengths (`apps/api/src/services/password.ts`, counted in code points, plus a
 * 72-byte bcrypt guard); every form that sets a password states the rule in
 * `PASSWORD_RULE`'s words, so the copy cannot drift from what is enforced.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

/** Shown under every new-password field: Join, Setup, Reset and Account. */
export const PASSWORD_RULE = `${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters, spaces allowed. Passwords found in known data breaches are refused.`;
