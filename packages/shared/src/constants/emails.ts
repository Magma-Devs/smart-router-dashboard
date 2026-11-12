/**
 * The transactional emails this product sends. MAG-2870 specifies the two that
 * carry a link, the invitation and the password reset. MAG-2868 adds the notice
 * that a password changed and MAG-2869 the notice that an admin reset somebody's
 * two-factor authentication; neither carries a link. Approval notifications are
 * MAG-2731's.
 *
 * A typed catalog rather than string literals at the call sites, for the same
 * reason the audit log has one: a typo becomes a typecheck failure instead of a
 * message nobody can search for afterwards.
 *
 * **On-prem sends none of these.** The invitation and the reset produce a link
 * the admin hands over directly, and no customer deployment ever needs a mail
 * server. The copy still matters there, because the same link lands in a chat
 * message instead. A 2FA reset there is recorded by its `2fa.reset` audit row,
 * which names both people, and a password change by the audit row that records it.
 */
export const EMAIL_TYPES = [
  "invitation",
  "password_reset",
  "password_changed",
  "two_factor_reset",
] as const;

export type EmailType = (typeof EMAIL_TYPES)[number];

/**
 * Subject line per type — the single source of truth, from MAG-2870.
 *
 * The invitation's subject carries the customer name because it arrives at an
 * address that has never heard of us; "Smart Router" alone reads as spam. The
 * reset's does not, because by then the person has an account and the shorter
 * subject is the clearer one. The two-factor notice goes to an account holder
 * too, and names the customer in its body.
 */
export const EMAIL_SUBJECTS: Record<EmailType, (customer: string) => string> = {
  invitation: (customer) => `You've been added to ${customer} on Smart Router`,
  password_reset: () => "Reset your Smart Router password",
  password_changed: () => "Your Smart Router password was changed",
  two_factor_reset: () => "Your Smart Router two-factor authentication was reset",
};

/**
 * How an invitation's delivery is recorded on the audit row that already
 * describes it (`member.invited`, `invite.resent`).
 *
 * There is deliberately **no email-log table**. lava-connect has one because it
 * has sixteen types, an admin console that answers "did this person already get
 * X", CSV export, and SES bounce correlation to build on. None of that is in
 * scope here, and a table nothing reads is schema we would have to migrate
 * around later. The one fact worth keeping — did it go, or is the admin holding
 * the link — belongs on the row an auditor already opens.
 */
export const EMAIL_DELIVERY_NOTES = {
  /** Handed to SES. */
  sent: "emailed",
  /** On-prem, or managed with no transport configured: the admin carries it. */
  link: "link shown to the admin",
  /** SES refused it. The link is surfaced to the admin as the fallback. */
  failed: "email failed, link shown to the admin",
} as const;

export type EmailDelivery = keyof typeof EMAIL_DELIVERY_NOTES;

/**
 * How a self-serve reset is recorded on `password.reset_requested`.
 *
 * Not {@link EMAIL_DELIVERY_NOTES}: that describes an admin holding the link,
 * and this flow has no admin — the link goes to the inbox or nowhere, and is
 * never returned. "link shown to the admin" on this row would send somebody
 * investigating a takeover to look for an admin who does not exist.
 */
export const RESET_REQUEST_NOTES = {
  /** Handed to SES. */
  sent: "emailed",
  /** No transport. Unreachable while the route fails closed without one, and
   *  kept so the record would still be true if that ever changed. */
  link: "not sent, no mail transport",
  /** SES refused it. Nothing reached anybody. */
  failed: "email failed, no link delivered",
} as const satisfies Record<EmailDelivery, string>;

/** `password.reset_requested` when the holder already has an unused link from
 *  inside the cooldown, so nothing new was issued or sent. Recorded rather than
 *  dropped: a run of these against one account is what a flood looks like. */
export const RESET_REQUEST_COOLING_DOWN_NOTE = "not re-sent, a recent link is still unused";

/**
 * How the password-changed notice is recorded, on the row that records the
 * change itself: `password.changed` (the Account page) or
 * `password.reset_completed` (a reset link), after that row's own note.
 *
 * Its own wording, not {@link EMAIL_DELIVERY_NOTES}: there is no link in this
 * message for anybody to hold. What somebody investigating a takeover needs
 * from the row is whether the owner was told. Managed deployments only; the
 * row on-prem carries no such note, because nothing is ever sent there.
 */
export const PASSWORD_CHANGED_NOTICE_NOTES = {
  /** Handed to SES. */
  sent: "owner notified by email",
  /** Managed with no transport configured. Nothing was attempted. */
  link: "owner not notified, no mail transport",
  /** SES refused it, or did not answer in time. */
  failed: "owner not notified, email failed",
} as const satisfies Record<EmailDelivery, string>;

/**
 * How the two-factor reset notice is recorded, on its own `2fa.reset_notice`
 * row.
 *
 * Not on `2fa.reset`'s note, the way an invitation's delivery rides on
 * `member.invited`: that row commits in the reset's own transaction, before
 * anything is sent, and the log is append-only. Not {@link
 * EMAIL_DELIVERY_NOTES} either — the notice carries no link, so there is
 * nothing for an admin to hold.
 */
export const TWO_FACTOR_RESET_NOTICE_NOTES = {
  /** Handed to SES. */
  sent: "emailed",
  /** Managed, with no transport configured. Nothing is attempted. */
  link: "not sent, no mail transport",
  /** SES refused it. The member was not told. */
  failed: "email failed, not delivered",
} as const satisfies Record<EmailDelivery, string>;
