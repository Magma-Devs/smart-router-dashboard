/**
 * How long an invitation and a password-reset link stay valid, per deployment
 * shape. The api sets `expires_at` from these; the web and the emails state
 * them. One source, so the copy cannot promise a lifetime the link does not
 * have — the reason MAG-2870's templates take the expiry as an input rather
 * than writing it into the prose.
 */

/** Managed can resend an email cheaply; an on-prem link travels over a channel
 *  we don't control, so it gets the shorter life. */
export const INVITE_TTL_MS = {
  managed: 7 * 24 * 60 * 60 * 1000,
  onprem: 24 * 60 * 60 * 1000,
} as const;

/** Managed can re-send cheaply and the user is at their keyboard; an on-prem
 *  link is handed over by a person and may wait until tomorrow. */
export const RESET_TTL_MS = {
  managed: 60 * 60 * 1000,
  onprem: 24 * 60 * 60 * 1000,
} as const;
