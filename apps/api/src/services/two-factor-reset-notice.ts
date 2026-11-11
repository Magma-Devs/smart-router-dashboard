import { TWO_FACTOR_RESET_NOTICE_NOTES, type EmailDelivery } from "@sr/shared";
import type { AuditActor, AuditWriter } from "./audit.js";
import { emailTransportConfigured, type EmailLogFn } from "./email.js";
import { sendTwoFactorResetEmail } from "./email-templates.js";

/**
 * Telling somebody their second factor was reset — MAG-2869.
 *
 * The admin route (`POST /api/team/members/:id/2fa/reset`) calls this once the
 * reset has committed. Never from inside the reset's transaction — a send that
 * failed must not take the reset with it, and a reset that rolled back must
 * not have been announced.
 *
 * **Managed only.** On-prem sends no email at all, and nothing is attempted or
 * recorded here; the `2fa.reset` row naming both people is the record there. On managed with no transport configured nothing is
 * attempted either, and the row says so.
 *
 * The outcome is a `2fa.reset_notice` row of its own rather than a note on
 * `2fa.reset`: that row commits in the reset's transaction, before anything is
 * sent, and the log is append-only.
 *
 * **Never throws.** The reset it follows has already happened, and the caller
 * answers for that, not for the mail.
 *
 * Answers what became of the email, or null when nothing was attempted
 * (on-prem).
 */
export async function noticeTwoFactorReset(
  audit: AuditWriter,
  notice: {
    mode: "managed" | "onprem";
    /** The person whose authenticator was cleared. */
    member: { id: string; email: string };
    /** Who reset it, worded for the email — see {@link resetByLabel}. */
    resetBy: string;
    /** When the reset committed. */
    at: Date;
    /** The row's actor: whoever made the reset. */
    actor: AuditActor;
  },
  log: EmailLogFn,
): Promise<EmailDelivery | null> {
  if (notice.mode !== "managed") return null;

  const to = notice.member.email;
  let delivery: EmailDelivery = "failed";
  try {
    if (emailTransportConfigured()) {
      ({ delivery } = await sendTwoFactorResetEmail(
        { to, resetBy: notice.resetBy, at: notice.at },
        log,
      ));
    } else {
      // The transport's own "not sent" line says the body carries a live link,
      // which this one does not; say what happened instead.
      delivery = "link";
      log("two-factor reset notice not sent — AWS_REGION is unset", { to });
    }
  } catch (err) {
    log("two-factor reset notice failed", {
      to,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Standalone, so a failed write is reported rather than thrown.
  await audit.write({
    action: "2fa.reset_notice",
    actor: notice.actor,
    target: { type: "member", id: notice.member.id, name: to },
    note: TWO_FACTOR_RESET_NOTICE_NOTES[delivery],
  });
  return delivery;
}

/**
 * An admin as the email names them: `Name (address)`, or the address alone.
 *
 * The address always, because the name is whatever its holder typed when they
 * joined and the address is what identifies them; for an admin abusing the
 * reset, the name is the part they control. Control characters and runs of
 * whitespace collapse to one space, so a name cannot add lines to the message.
 */
export function resetByLabel(user: { name: string | null; email: string }): string {
  // eslint-disable-next-line no-control-regex
  const name = (user.name ?? "").replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (!name || name.toLowerCase() === user.email.toLowerCase()) return user.email;
  return `${name} (${user.email})`;
}

