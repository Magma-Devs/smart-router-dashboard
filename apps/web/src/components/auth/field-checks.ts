import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@sr/shared";

/**
 * The checks the auth forms run themselves. Every form sets `noValidate`, so the
 * browser shows none of its own tooltips: an error is text under its field, in
 * the app's style, and these decide what that text says.
 */

export const PASSWORDS_DIFFER = "Those passwords don't match.";

/** The api's own length messages (`services/password.ts`), counted the same
 *  way, in code points. The byte limit and the breach check stay the api's. */
export function passwordProblem(password: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

export type NewPasswordErrors = { password?: string; repeat?: string };

/**
 * A new password and its repeat. A mismatch shows as soon as the repeat has
 * something in it; the length waits for a submit, so nobody is told "too short"
 * while still typing.
 */
export function newPasswordErrors(
  password: string,
  repeat: string,
  submitted: boolean,
): NewPasswordErrors {
  const errors: NewPasswordErrors = {};
  const length = submitted ? passwordProblem(password) : null;
  if (length) errors.password = length;
  if ((submitted || repeat.length > 0) && password !== repeat) errors.repeat = PASSWORDS_DIFFER;
  return errors;
}

/** The pattern WHATWG gives `type="email"`, so the form refuses exactly what the
 *  browser's own check refused. */
const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function emailProblem(email: string): string | null {
  const value = email.trim();
  if (!value) return "Enter your email address.";
  return EMAIL_PATTERN.test(value) ? null : "Enter a valid email address.";
}

/** True when any field has an error. */
export function hasErrors(errors: Record<string, string | null | undefined>): boolean {
  return Object.values(errors).some(Boolean);
}
