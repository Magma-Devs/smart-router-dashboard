/**
 * Why the browser was sent to the sign-in page, carried as `/login?reason=`.
 *
 * Only the values listed here are read, and each maps to fixed text, so a
 * crafted link can choose among these sentences and nothing else. A sign-in
 * failure never comes through here: its message stays generic.
 */
export const SIGN_IN_NOTICES = {
  /** The api refused the session with `endedBy: "admin"`: a removal, or an
   *  admin's two-factor reset. */
  access_changed: "Your session ended. An admin changed your access.",
} as const;

export type SignInReason = keyof typeof SIGN_IN_NOTICES;

/** The notice for a `?reason=` value, or null for anything not listed. */
export function signInNotice(reason: string | string[] | undefined): string | null {
  if (typeof reason !== "string" || !Object.hasOwn(SIGN_IN_NOTICES, reason)) return null;
  return SIGN_IN_NOTICES[reason as SignInReason];
}

/** Where a session the api ended sends the browser: `endedBy` is the api's
 *  refusal field (`plugins/auth.ts`). */
export function signInPathAfter(endedBy: string | undefined): string {
  return endedBy === "admin" ? "/login?reason=access_changed" : "/login";
}
