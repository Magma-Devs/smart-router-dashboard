import { PASSWORD_CHANGED_NOTICE_NOTES } from "@sr/shared";
import { deploymentMode } from "../config.js";
import { emailTransportConfigured, type EmailLogFn } from "./email.js";
import { sendPasswordChangedEmail } from "./email-templates.js";

/**
 * Tell an account's owner that its password changed (MAG-2868), and say how
 * that went in the words the change's audit row carries.
 *
 * Both ways a password changes on an existing account call this: the Account
 * page's change (`POST /api/account/password`) and a reset link's redemption
 * (`POST /auth/password/reset`), which is also where an admin's link and the
 * recovery command's link end up. Creating an account sets a password too, at
 * first-run setup and invite redemption, but there is no earlier owner there to
 * warn.
 *
 * **Only after the change has committed.** The send cannot roll the change
 * back, and it cannot fail the request either: `sendEmail` never throws, and a
 * refused or unanswered send comes back as a value. What it costs is time,
 * since the caller awaits it to know what to record: SES answers in well under
 * a second, and the transport's own timeouts bound a send that never answers.
 *
 * Returns the note for the audit row, or `null` where there is nothing to say:
 *
 *  - **on-prem** — never sends, and the row stays as it always was. The audit
 *    row is the on-prem equivalent of the notice.
 *  - **managed, no transport** (`AWS_REGION` unset) — attempts nothing and logs
 *    nothing, and the note says the owner was not told.
 *  - **managed, with a transport** — sends, and the note says whether SES took
 *    it.
 */
export async function notifyPasswordChanged(
  opts: { to: string; changedAt: Date },
  log: EmailLogFn,
): Promise<string | null> {
  if (deploymentMode() !== "managed") return null;
  if (!emailTransportConfigured()) return PASSWORD_CHANGED_NOTICE_NOTES.link;
  const { delivery } = await sendPasswordChangedEmail(opts, log);
  return PASSWORD_CHANGED_NOTICE_NOTES[delivery];
}
