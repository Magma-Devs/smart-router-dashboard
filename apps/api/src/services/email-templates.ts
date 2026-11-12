import { EMAIL_SUBJECTS, type EmailDelivery, type EmailType } from "@sr/shared";
import { sendEmail, type EmailLogFn, type SendResult } from "./email.js";
import {
  ctaButton,
  escapeHtml,
  heading,
  linkFallback,
  paragraph,
  paragraphSmall,
  renderEmailHtml,
} from "./email-layout.js";
import { config } from "../config.js";

/**
 * The transactional emails, with their copy. The invitation and the password
 * reset are MAG-2870's, close to verbatim; the password-changed notice is
 * MAG-2868's and the two-factor reset notice MAG-2869's. Structure follows
 * lava-connect: one `send*` per type, each composing subject, plain text and
 * HTML and handing them to `deliver()`.
 *
 * The invitation and the reset follow the four rules MAG-2870 sets for them.
 * The two notices keep rules 3 and 4, and in place of 1 and 2 carry no link at
 * all (see {@link renderPasswordChangedEmail}):
 *
 *  1. **The link appears as text as well as a button**, because mail clients
 *     strip buttons and people forward these.
 *  2. **The expiry is in the message**, so nobody discovers it by clicking a
 *     dead link.
 *  3. **No marketing footer, no tracking, no unsubscribe** — enforced by the
 *     shell, which has no footer and no remote images at all.
 *  4. **The message says what to do if it wasn't you.** On the reset that is
 *     the last line; it reassures without alarming.
 */

/** The customer this deployment belongs to, for the invitation's subject. */
function customerName(): string {
  return process.env.CUSTOMER_NAME?.trim() || config.customerName;
}

/**
 * The one place a send happens.
 *
 * lava-connect's `deliver()` sends and then writes an email-log row, so no
 * caller can forget to record it. There is no log table here (see
 * `EMAIL_DELIVERY_NOTES` in `@sr/shared` for why), so the equivalent guarantee
 * is the return value: this hands back an {@link EmailDelivery} that the caller
 * must put on its audit row and act on. `sent` is the only outcome where the
 * admin can stop thinking about the link.
 */
async function deliver(
  input: { to: string; subject: string; text: string; html: string },
  log?: EmailLogFn,
): Promise<{ result: SendResult; delivery: EmailDelivery }> {
  const result = await sendEmail(input, log);
  // `logged` and `failed` are different causes with the same consequence:
  // nobody received anything, so the admin has to carry the link. Collapsing
  // them here means one branch at every call site instead of two.
  const delivery: EmailDelivery =
    result.status === "sent" ? "sent" : result.status === "failed" ? "failed" : "link";
  return { result, delivery };
}

export type DeliveryOutcome = Awaited<ReturnType<typeof deliver>>;

/**
 * A composed message, before anything tries to send it.
 *
 * Rendering is split from sending so the copy can be asserted — and looked at —
 * without a transport in the way. It is also what lets the screenshots in
 * `docs/assets/` be the real templates rather than a mock-up of them.
 */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Invitation.
 *
 * **The inviter is deliberately not named.** MAG-2870 is explicit, and the
 * reasoning is worth keeping next to the copy: an invitation goes to an address
 * nobody has verified yet, so a mistyped one puts a colleague's name and email
 * in a stranger's inbox. The recipient does not need it to act.
 */
export function renderInvitationEmail(opts: {
  to: string;
  inviteUrl: string;
  expiresInDays: number;
}): RenderedEmail {
  const customer = customerName();
  const subject = EMAIL_SUBJECTS.invitation(customer);
  const days = opts.expiresInDays === 1 ? "1 day" : `${opts.expiresInDays} days`;

  const text =
    `Hi,\n\n` +
    `You've been given access to the Smart Router dashboard for ${customer}.\n\n` +
    `Set up your account:\n${opts.inviteUrl}\n\n` +
    `The link works once and expires in ${days}. It only works for ${opts.to}.\n`;

  const html = renderEmailHtml({
    subject,
    body:
      heading("Set up your account") +
      paragraph(
        `You've been given access to the Smart Router dashboard for ${escapeHtml(customer)}.`,
      ) +
      ctaButton("Set up your account", opts.inviteUrl) +
      linkFallback(opts.inviteUrl) +
      paragraphSmall(
        `The link works once and expires in <strong>${days}</strong>. It only works for ${escapeHtml(opts.to)}.`,
      ),
  });

  return { subject, text, html };
}

export async function sendInvitationEmail(
  opts: { to: string; inviteUrl: string; expiresInDays: number },
  log?: EmailLogFn,
): Promise<DeliveryOutcome> {
  return deliver({ to: opts.to, ...renderInvitationEmail(opts) }, log);
}

/**
 * Password reset.
 *
 * The expiry stated here is passed in rather than written into the copy —
 * lava-connect's template hardcodes 30 minutes, and this product's managed
 * reset is an hour. A number in prose that nothing derives from the code is a
 * number that goes stale silently.
 */
export function renderPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
  expiresInHours: number;
}): RenderedEmail {
  const subject = EMAIL_SUBJECTS.password_reset(customerName());
  const hours = opts.expiresInHours === 1 ? "1 hour" : `${opts.expiresInHours} hours`;

  const text =
    `We received a request to reset your Smart Router password. ` +
    `Use the link below to choose a new one.\n\n` +
    `${opts.resetUrl}\n\n` +
    `This link expires in ${hours}. If you didn't request this, you can ignore this email — ` +
    `your password won't change.\n`;

  const html = renderEmailHtml({
    subject,
    body:
      heading("Reset your password") +
      paragraph(
        "We received a request to reset your Smart Router password. Use the link below to choose a new one.",
      ) +
      ctaButton("Reset password", opts.resetUrl) +
      linkFallback(opts.resetUrl) +
      paragraphSmall(
        `This link expires in <strong>${hours}</strong>. If you didn't request this, you can ignore this email — your password won't change.`,
      ),
  });

  return { subject, text, html };
}

export async function sendPasswordResetEmail(
  opts: { to: string; resetUrl: string; expiresInHours: number },
  log?: EmailLogFn,
): Promise<DeliveryOutcome> {
  return deliver({ to: opts.to, ...renderPasswordResetEmail(opts) }, log);
}

/**
 * Two-factor reset notice — MAG-2869.
 *
 * An admin can clear anybody's second factor. That is the lost-phone path, and
 * also the shortest way to take over an approver's account using only intended
 * features; the member would otherwise learn of it only by being signed out.
 * This names who did it and when, so a reset nobody asked for is something the
 * member asks about.
 *
 * **No link, on purpose** — no undo, no sign-out button, no sign-in button.
 * Unlike the invitation and the reset, nobody asked for this message, and an
 * unrequested security notice with a link in it is the shape phishing takes; a
 * notice that never carries one makes a copy that does easy to spot. The reset
 * has already signed them out everywhere, so a link would have nothing to do.
 *
 * `resetBy` is passed in already worded, because the admin route and the host
 * recovery command name different kinds of actor.
 */
export function renderTwoFactorResetEmail(opts: {
  to: string;
  resetBy: string;
  at: Date;
}): RenderedEmail {
  const customer = customerName();
  const subject = EMAIL_SUBJECTS.two_factor_reset(customer);
  const when = utcStamp(opts.at);

  const text =
    `Two-factor authentication was reset on your account (${opts.to}) on the ` +
    `Smart Router dashboard for ${customer}.\n\n` +
    `Reset by: ${opts.resetBy}\n` +
    `When: ${when}\n\n` +
    `You have been signed out on every device. The next time you sign in, you'll be ` +
    `asked to set up an authenticator app again.\n\n` +
    `If you didn't ask for this, report it to your security team or another ` +
    `administrator straight away.\n`;

  const html = renderEmailHtml({
    subject,
    body:
      heading("Your two-factor authentication was reset") +
      paragraph(
        `Two-factor authentication was reset on your account (${escapeHtml(opts.to)}) on the ` +
          `Smart Router dashboard for ${escapeHtml(customer)}.`,
      ) +
      paragraph(
        `<strong>Reset by:</strong> ${escapeHtml(opts.resetBy)}<br>` +
          `<strong>When:</strong> ${when}`,
      ) +
      paragraph(
        "You have been signed out on every device. The next time you sign in, you'll be asked to set up an authenticator app again.",
      ) +
      paragraphSmall(
        "If you didn't ask for this, report it to your security team or another administrator straight away.",
      ),
  });

  return { subject, text, html };
}

export async function sendTwoFactorResetEmail(
  opts: { to: string; resetBy: string; at: Date },
  log?: EmailLogFn,
): Promise<DeliveryOutcome> {
  return deliver({ to: opts.to, ...renderTwoFactorResetEmail(opts) }, log);
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** `11 November 2026 at 14:05 UTC` — spelled out, so no reader has to guess
 *  which of day and month comes first, and in UTC, so it matches the audit log
 *  whatever the reader's timezone. Built by hand: `Intl`'s wording moves with
 *  the ICU version the runtime ships. */
function utcStamp(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} at ${hh}:${mm} UTC`;
}

/**
 * Password changed — sent whichever way the password changed: from the Account
 * page, or by a reset link being used. A change the owner did not make is the
 * earliest sign anybody gets that someone else is in the account.
 *
 * **It carries no link at all**: no button, no reset link, no sign-in link. A
 * takeover notice with a button is one an attacker can copy and bait somebody
 * into pressing, so the way back is described in words instead, and the last
 * line says that this notice never has a link, so a copy that has one gives
 * itself away. The time is the fact the reader needs to recognise the change
 * as theirs or not, so it is stated, in UTC.
 */
export function renderPasswordChangedEmail(opts: { changedAt: Date }): RenderedEmail {
  const customer = customerName();
  const subject = EMAIL_SUBJECTS.password_changed(customer);
  const when = utcStamp(opts.changedAt);
  const noLink =
    "This notice never contains a link. One that asks you to click something did not come from us.";

  const text =
    `The password for your account on the Smart Router dashboard for ${customer} ` +
    `was changed on ${when}.\n\n` +
    `If you made this change, there is nothing else to do.\n\n` +
    `If you didn't, someone else may have your password. Open the dashboard the way you ` +
    `usually do, choose "Forgot your password?" on the sign-in page to set a new one — that ` +
    `signs out every device — and tell your administrator.\n\n` +
    `${noLink}\n`;

  const html = renderEmailHtml({
    subject,
    body:
      heading("Your password was changed") +
      paragraph(
        `The password for your account on the Smart Router dashboard for ${escapeHtml(customer)} ` +
          `was changed on <strong>${when}</strong>.`,
      ) +
      paragraph("If you made this change, there is nothing else to do.") +
      paragraph(
        "<strong>If you didn't</strong>, someone else may have your password. Open the dashboard " +
          "the way you usually do, choose <strong>Forgot your password?</strong> on the sign-in " +
          "page to set a new one — that signs out every device — and tell your administrator.",
      ) +
      paragraphSmall(noLink),
  });

  return { subject, text, html };
}

export async function sendPasswordChangedEmail(
  opts: { to: string; changedAt: Date },
  log?: EmailLogFn,
): Promise<DeliveryOutcome> {
  return deliver({ to: opts.to, ...renderPasswordChangedEmail(opts) }, log);
}

/** Re-exported so call sites can type their audit note without reaching past
 *  this module into the transport. */
export type { EmailType, SendResult };
