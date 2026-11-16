import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMAIL_TYPES, type EmailType } from "@sr/shared";
import {
  renderInvitationEmail,
  renderPasswordChangedEmail,
  renderPasswordResetEmail,
  renderTwoFactorResetEmail,
  type RenderedEmail,
} from "../services/email-templates.js";
import { HOST_RECOVERY_RESET_BY, resetByLabel } from "../services/two-factor-reset-notice.js";

/**
 * The rules every email's copy follows, checked on what the templates render:
 * the subject, the plain text and the HTML, for every type in the catalog.
 *
 *  - no long dash (an em dash or an en dash) anywhere a reader sees;
 *  - US English spelling;
 *  - the second factor is called "2FA";
 *  - a time is written with its zone.
 */

const saved = process.env.CUSTOMER_NAME;
beforeEach(() => {
  process.env.CUSTOMER_NAME = "Example Co";
});
afterEach(() => {
  if (saved === undefined) delete process.env.CUSTOMER_NAME;
  else process.env.CUSTOMER_NAME = saved;
});

const AT = new Date("2026-11-11T14:05:42.000Z");
const NOT_A_TIME = new Date("not a time");

/** Every variant of every email: each type, each role, and each time a
 *  template can be handed, a Date that is not a time included. */
function everyEmail(): Array<[string, RenderedEmail]> {
  const out: Array<[string, RenderedEmail]> = [];
  const of: Record<EmailType, () => void> = {
    invitation: () => {
      for (const role of ["read_only", "requester", "approver", "admin"] as const) {
        for (const invitedBy of [
          { name: "Victoria Admin", email: "victoria@example.com" },
          { name: null, email: "victoria@example.com" },
        ]) {
          for (const expiresInDays of [1, 7]) {
            out.push([
              `invitation (${role}, ${invitedBy.name ?? "no name"}, ${expiresInDays}d)`,
              renderInvitationEmail({
                to: "dana@example.com",
                inviteUrl: "https://dash.example.com/invite/tok3n",
                expiresInDays,
                invitedBy,
                role,
              }),
            ]);
          }
        }
      }
    },
    password_reset: () => {
      for (const expiresInHours of [1, 24]) {
        out.push([
          `password reset (${expiresInHours}h)`,
          renderPasswordResetEmail({
            to: "dana@example.com",
            resetUrl: "https://dash.example.com/reset/tok3n",
            expiresInHours,
          }),
        ]);
      }
    },
    password_changed: () => {
      out.push(["password changed", renderPasswordChangedEmail({ changedAt: AT })]);
      out.push([
        "password changed (no time)",
        renderPasswordChangedEmail({ changedAt: NOT_A_TIME }),
      ]);
    },
    two_factor_reset: () => {
      for (const resetBy of [
        resetByLabel({ name: "Victoria Admin", email: "victoria@example.com" }),
        HOST_RECOVERY_RESET_BY,
      ]) {
        for (const at of [AT, NOT_A_TIME]) {
          out.push([
            `2FA reset (${resetBy}, ${Number.isFinite(at.getTime()) ? "time" : "no time"})`,
            renderTwoFactorResetEmail({ to: "dana@example.com", resetBy, at }),
          ]);
        }
      }
    },
  };
  for (const type of EMAIL_TYPES) of[type]();
  return out;
}

const EMAILS = everyEmail();

/** What a reader sees of each part. The HTML's tags and attributes are markup,
 *  so they are dropped, and its entities read as the characters they stand for. */
function partsOf(email: RenderedEmail): Array<[string, string]> {
  const visible = email.html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  return [
    ["subject", email.subject],
    ["text", email.text],
    ["html", visible],
    // The raw HTML too, so a dash written as an entity or in an attribute counts.
    ["html source", email.html],
  ];
}

describe("every email's copy", () => {
  it("covers every type in the catalog", () => {
    expect(EMAILS.length).toBeGreaterThanOrEqual(EMAIL_TYPES.length);
    expect(EMAILS.some(([name]) => name.startsWith("invitation"))).toBe(true);
    expect(EMAILS.some(([name]) => name.startsWith("password reset"))).toBe(true);
    expect(EMAILS.some(([name]) => name.startsWith("password changed"))).toBe(true);
    expect(EMAILS.some(([name]) => name.startsWith("2FA reset"))).toBe(true);
  });

  it.each(EMAILS)("has no long dash: %s", (_name, email) => {
    for (const [part, value] of partsOf(email)) {
      expect(value, part).not.toMatch(/[–—]|&mdash;|&ndash;|&#821[12];|&#x201[34];/i);
    }
  });

  it.each(EMAILS)("is spelled in US English: %s", (_name, email) => {
    // The British forms these emails could plausibly drift into.
    const british =
      /\b(recognis|organis|authoris|realis|apologis|prioritis|summaris|customis|finalis|initialis|colour|behaviour|favour|honour|centre|licence|cancell|enrol\b|enrolment|straight away)/i;
    for (const [part, value] of partsOf(email)) {
      expect(value, part).not.toMatch(british);
    }
  });

  it.each(EMAILS)("calls the second factor 2FA: %s", (_name, email) => {
    for (const [part, value] of partsOf(email)) {
      expect(value, part).not.toMatch(/two[- ]factor/i);
    }
  });

  it("writes every time with its zone", () => {
    for (const [name, email] of EMAILS) {
      if (!/password changed$|2FA reset \(.*, time\)/.test(name)) continue;
      expect(email.text, name).toContain("Nov 11, 2026, 14:05 UTC");
      expect(email.html, name).toContain("Nov 11, 2026, 14:05 UTC");
    }
  });

  it("names 2FA in the reset notice's subject, heading and first line", () => {
    const { subject, text, html } = renderTwoFactorResetEmail({
      to: "dana@example.com",
      resetBy: "Victoria Admin (victoria@example.com)",
      at: AT,
    });
    expect(subject).toBe("Your Smart Router 2FA was reset");
    expect(text.startsWith("2FA was reset on your account (dana@example.com)")).toBe(true);
    expect(html).toContain(">Your 2FA was reset</h1>");
  });
});
