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
 * The two transactional emails, with their copy — MAG-2870's, close to
 * verbatim. Structure follows lava-connect: one `send*` per type, each
 * composing subject, plain text and HTML and handing them to `deliver()`.
 *
 * Both follow the four rules the ticket sets for them:
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

/** Re-exported so call sites can type their audit note without reaching past
 *  this module into the transport. */
export type { EmailType, SendResult };
