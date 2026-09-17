/**
 * Branded HTML shell + body builders for transactional email, ported from
 * lava-connect's `services/email-layout.ts`. Copy lives in
 * `email-templates.ts`; this module owns structure and style only.
 *
 * Everything is table-based with inline styles — no `<style>` blocks, no
 * flexbox, no webfonts. That is the lowest common denominator that renders the
 * same in Gmail, Outlook and Apple Mail, and it is why this looks nothing like
 * the app's CSS despite describing the same brand.
 *
 * **Two deliberate departures from the port.**
 *
 * There is no footer. lava-connect ends its shell with a foundation byline and
 * a privacy-policy link; MAG-2870 says "no marketing footer, no tracking, no
 * unsubscribe", on the grounds that an unsubscribe link on a password reset
 * teaches people the wrong habit. A sender-identity line would be defensible,
 * but the ticket's rule is unqualified and these are two security messages, so
 * the card ends where the message ends.
 *
 * And there is no hosted logo. lava-connect serves a PNG wordmark from the web
 * origin; a remote image in a security email is a tracking pixel whether or not
 * anybody meant it as one — it reports when the message was opened, and from
 * where. The wordmark is set in text instead.
 */

/** Email-safe system stack. The app's Inter is dropped on purpose: linked
 *  webfonts are unreliable in mail clients, so this is the fallback Inter
 *  itself declares. */
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/** Mirrors the light-theme tokens in `apps/web/src/styles/globals.css`. */
const T = {
  text: "#0a0a0b",
  text2: "#44444a",
  text3: "#71717a",
  text4: "#a1a1aa",
  bg: "#f4f4f2",
  white: "#ffffff",
  brand: "#ff3900",
  line: "rgba(0,0,0,0.07)",
} as const;

/**
 * Escape a value for interpolation into an HTML body. Every address, name and
 * customer string that reaches a template is attacker-influenced — an
 * invitation goes to an address somebody typed — so all of them go through
 * this. The surrounding template copy is trusted and passes through unescaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ────────── body builders ──────────

export function heading(content: string): string {
  return `<h1 style="margin:0 0 18px;font-size:24px;font-weight:700;color:${T.text};font-family:${FONT};letter-spacing:-0.03em;line-height:1.2;">${content}</h1>`;
}

export function paragraph(content: string): string {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${T.text};font-family:${FONT};">${content}</p>`;
}

/** Fine print — expiry notices, and the "if this wasn't you" line. */
export function paragraphSmall(content: string): string {
  return `<p style="margin:0 0 10px;font-size:13px;line-height:1.6;color:${T.text3};font-family:${FONT};">${content}</p>`;
}

/** Brand-coloured action button, built as a table so Outlook renders it. */
export function ctaButton(label: string, href: string): string {
  return (
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">` +
    `<tr><td align="center" style="padding:22px 0 14px;">` +
    `<table cellpadding="0" cellspacing="0" border="0" role="presentation">` +
    `<tr><td align="center" bgcolor="${T.brand}" style="border-radius:8px;background:${T.brand};">` +
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 36px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;font-family:${FONT};letter-spacing:-0.01em;">${label}</a>` +
    `</td></tr></table></td></tr></table>`
  );
}

/**
 * The same link again, as selectable text under the button.
 *
 * MAG-2870 requires it — "mail clients strip buttons, and people forward
 * these". A forwarded message whose only link is a styled anchor arrives with
 * no way to reach the thing it is about.
 */
export function linkFallback(href: string): string {
  const safe = escapeHtml(href);
  return (
    `<p style="margin:0 0 4px;font-size:12px;line-height:1.5;color:${T.text3};font-family:${FONT};">Or paste this into your browser:</p>` +
    `<p style="margin:0 0 16px;font-size:12px;line-height:1.5;word-break:break-all;font-family:${FONT};">` +
    `<a href="${safe}" style="color:${T.brand};text-decoration:underline;">${safe}</a></p>`
  );
}

// ────────── shell ──────────

export interface RenderEmailOptions {
  /** Sets `<title>`; the real subject is set on the SES send. */
  subject: string;
  /** Pre-built inner HTML. */
  body: string;
}

/** Wrap body HTML in the full document, ready to hand to SES as the Html part. */
export function renderEmailHtml(opts: RenderEmailOptions): string {
  return (
    `<!DOCTYPE html>\n` +
    `<html lang="en" xmlns="http://www.w3.org/1999/xhtml">\n` +
    `<head>\n` +
    `<meta charset="UTF-8">\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<meta http-equiv="X-UA-Compatible" content="IE=edge">\n` +
    `<meta name="x-apple-disable-message-reformatting">\n` +
    `<title>${escapeHtml(opts.subject)}</title>\n` +
    `</head>\n` +
    `<body style="margin:0;padding:0;background-color:${T.bg};-webkit-font-smoothing:antialiased;font-family:${FONT};">\n` +
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" bgcolor="${T.bg}" style="background-color:${T.bg};">\n` +
    `<tr><td align="center" style="padding:48px 16px 64px;">\n` +
    `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="560" style="width:100%;max-width:560px;">\n` +
    // Wordmark as text, not a hosted image — see the module docblock.
    `<tr><td style="padding:0 0 18px 2px;">\n` +
    `<span style="font-size:15px;font-weight:700;letter-spacing:-0.02em;color:${T.text};font-family:${FONT};">Smart Router</span>` +
    `<span style="font-size:15px;font-weight:400;color:${T.text4};font-family:${FONT};">&nbsp;by Magma Devs</span>\n` +
    `</td></tr>\n` +
    `<tr><td style="background-color:${T.white};border-radius:14px;border:1px solid ${T.line};overflow:hidden;" bgcolor="${T.white}">\n` +
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">\n` +
    `<tr><td height="3" style="height:3px;font-size:0;line-height:0;background-color:${T.brand};" bgcolor="${T.brand}"></td></tr>\n` +
    `</table>\n` +
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">\n` +
    `<tr><td style="padding:34px 40px 28px;">\n` +
    opts.body +
    `\n</td></tr>\n</table>\n` +
    `</td></tr>\n` +
    `</table>\n</td></tr>\n</table>\n</body>\n</html>`
  );
}
