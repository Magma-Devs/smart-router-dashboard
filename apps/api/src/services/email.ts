import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/**
 * Low-level email transport over AWS SES (v2). Ported from lava-connect's
 * `services/email.ts`, which has been sending production mail for a while —
 * the copy and the templates live in `email-templates.ts`; this module only
 * knows how to put bytes on the wire.
 *
 * Configuration:
 *   - AWS_REGION              enables SES. Absent ⇒ the dev fallback below
 *   - AWS_ACCESS_KEY_ID       optional — see the credentials note in getClient
 *   - AWS_SECRET_ACCESS_KEY   optional
 *   - EMAIL_FROM              "Smart Router <noreply@magmadevs.com>"
 *   - EMAIL_CONFIGURATION_SET optional SES configuration set. Tags sends so
 *                             each environment's reputation, bounces and
 *                             suppression stay separate on a shared identity —
 *                             without it, staging's bounces poison production's
 *                             sender score
 *   - EMAIL_REPLY_TO          optional monitored inbox. EMAIL_FROM is an
 *                             unmonitored no-reply, so a reply to a password
 *                             reset would otherwise go nowhere
 *   - SES_ENDPOINT            optional, points at a SES-compatible mock for
 *                             local dev (aws-ses-v2-local) so mail lands in its
 *                             inbox UI instead of a real inbox
 *
 * **No region ⇒ nothing is sent and the body is logged instead**, returning
 * `status: "logged"`. That is what makes the whole feature developable before
 * SES exists, and it is why every caller has to handle a send that did not
 * happen — see the delivery fallback in `email-templates.ts`.
 *
 * SES sandbox note: a new SES account may only send to verified addresses.
 * Verify the sender *and* the test recipient before testing, or unverified
 * recipients bounce silently.
 */

let cachedClient: SESv2Client | null = null;
let cachedClientRegion: string | null = null;

function getClient(): SESv2Client | null {
  const region = process.env.AWS_REGION;
  // AWS_REGION alone enables SES. Explicit keys are used when present (local
  // dev, or a non-AWS host); when absent the SDK resolves credentials from the
  // environment — an IRSA service account or an instance role — so production
  // has no static keys to store, leak or rotate.
  if (!region) return null;

  if (cachedClient && cachedClientRegion === region) return cachedClient;

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  cachedClient = new SESv2Client({
    region,
    ...(process.env.SES_ENDPOINT ? { endpoint: process.env.SES_ENDPOINT } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  cachedClientRegion = region;
  return cachedClient;
}

/** Tests only — a process never re-resolves the client. */
export function resetEmailClientForTests(): void {
  cachedClient = null;
  cachedClientRegion = null;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  /** Plain text. Never optional: it is the copy that survives a client which
   *  strips the button, and MAG-2870 requires the link to appear as text. */
  text: string;
  html?: string;
}

/**
 * Outcome of one send attempt.
 *
 *  - `sent`   — handed to SES; `messageId` is the SES MessageId.
 *  - `logged` — no region configured, so the body went to the log rather than
 *               to anybody. The dev path, and the honest answer for a managed
 *               deployment whose transport nobody has wired up yet.
 *  - `failed` — SES refused it; `error` carries why.
 *
 * `sendEmail` **never throws**. A transient SES blip must not turn a created
 * invitation into a 500 after the row has already been written — the caller
 * decides what to do with a send that did not happen, and in this product that
 * means handing the admin the link instead.
 */
export interface SendResult {
  status: "sent" | "logged" | "failed";
  messageId: string | null;
  error?: string;
}

export type EmailLogFn = (msg: string, ctx?: Record<string, unknown>) => void;

export async function sendEmail(
  input: SendEmailInput,
  log: EmailLogFn = console.error.bind(console),
): Promise<SendResult> {
  const client = getClient();
  const from = process.env.EMAIL_FROM ?? "Smart Router <noreply@smart-router.local>";
  const configurationSet = process.env.EMAIL_CONFIGURATION_SET;
  const replyTo = process.env.EMAIL_REPLY_TO?.trim();

  if (!client) {
    // Deliberately at warn, not debug: on a managed deployment this means mail
    // is not configured and somebody is waiting for a link that will never
    // arrive. It should be visible without anybody raising the log level.
    log("email not sent — AWS_REGION is unset, logging the body instead", {
      to: input.to,
      subject: input.subject,
      from,
      body: input.text,
    });
    return { status: "logged", messageId: null };
  }

  try {
    const out = await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [input.to] },
        ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
        ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Data: input.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: input.text, Charset: "UTF-8" },
              ...(input.html ? { Html: { Data: input.html, Charset: "UTF-8" } } : {}),
            },
          },
        },
      }),
    );
    return { status: "sent", messageId: out.MessageId ?? null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // The body is NOT logged here. A failed send still had a live token in it,
    // and the caller surfaces the link to the admin through the response.
    log("email send failed", { to: input.to, subject: input.subject, error });
    return { status: "failed", messageId: null, error };
  }
}
