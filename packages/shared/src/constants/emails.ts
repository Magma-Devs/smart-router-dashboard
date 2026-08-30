/**
 * The transactional emails this product sends. Exactly two, and MAG-2870 says
 * so explicitly — approval notifications are MAG-2731's and out of scope there,
 * password-changed and 2FA-reset notices are parked in MAG-2868 and MAG-2869.
 *
 * A typed catalog rather than string literals at the call sites, for the same
 * reason the audit log has one: a typo becomes a typecheck failure instead of a
 * message nobody can search for afterwards.
 *
 * **On-prem sends none of these.** Both flows produce a link the admin hands
 * over directly, and no customer deployment ever needs a mail server. The copy
 * still matters there, because the same link lands in a chat message instead.
 */
export const EMAIL_TYPES = ["invitation", "password_reset"] as const;

export type EmailType = (typeof EMAIL_TYPES)[number];

/**
 * Subject line per type — the single source of truth, from MAG-2870.
 *
 * The invitation's subject carries the customer name because it arrives at an
 * address that has never heard of us; "Smart Router" alone reads as spam. The
 * reset's does not, because by then the person has an account and the shorter
 * subject is the clearer one.
 */
export const EMAIL_SUBJECTS: Record<EmailType, (customer: string) => string> = {
  invitation: (customer) => `You've been added to ${customer} on Smart Router`,
  password_reset: () => "Reset your Smart Router password",
};

/**
 * How an email's delivery is recorded on the audit row that already describes
 * the thing that happened (`member.invited`, `password.reset_requested`).
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
