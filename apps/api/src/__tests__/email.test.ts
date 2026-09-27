import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMAIL_DELIVERY_NOTES, EMAIL_SUBJECTS } from "@sr/shared";
import { sendEmail, resetEmailClientForTests } from "../services/email.js";
import { fakeSesEnv, startFakeSes } from "./fake-ses.js";
import {
  renderInvitationEmail,
  renderPasswordResetEmail,
  sendInvitationEmail,
  sendPasswordResetEmail,
} from "../services/email-templates.js";

/**
 * The two emails MAG-2870 specifies, and the transport under them.
 *
 * Nothing here talks to SES: with `AWS_REGION` unset the transport logs instead
 * of sending, which is the same path a managed deployment takes before anybody
 * wires up mail. That makes the dev fallback itself the thing under test, and
 * it is worth testing — it decides whether an admin is handed the link.
 */

const saved: Record<string, string | undefined> = {};
const ENV = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "EMAIL_FROM",
  "CUSTOMER_NAME",
  "SES_ENDPOINT",
];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  resetEmailClientForTests();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEmailClientForTests();
});

describe("transport", () => {
  it("logs instead of sending when no region is configured, and says so", async () => {
    const lines: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const res = await sendEmail(
      { to: "someone@example.com", subject: "Hi", text: "body" },
      (msg, ctx) => lines.push({ msg, ctx }),
    );

    expect(res).toEqual({ status: "logged", messageId: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.ctx?.to).toBe("someone@example.com");
    // The body is logged on this path deliberately — it is the only way to get
    // the link in dev — which is exactly why it must not happen on a failure.
    expect(lines[0]?.ctx?.body).toBe("body");
  });

  it("withholds the body outside development — it carries a live link", async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const lines: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
      const res = await sendEmail(
        {
          to: "someone@example.com",
          subject: "Hi",
          text: "Set up your account: https://dash.example.com/invite/tok3n",
        },
        (msg, ctx) => lines.push({ msg, ctx }),
      );

      expect(res.status).toBe("logged");
      expect(lines).toHaveLength(1);
      expect(lines[0]?.ctx?.to).toBe("someone@example.com");
      expect(lines[0]?.ctx).not.toHaveProperty("body");
      expect(JSON.stringify(lines)).not.toContain("tok3n");
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it("gives up on an SES that never answers, instead of holding the caller", async () => {
    // The invite route awaits this after committing the row. A hung send
    // hangs the admin's request, and their retry meets a 409.
    const ses = await startFakeSes();
    ses.mode = "hold";
    try {
      Object.assign(process.env, fakeSesEnv(ses));
      resetEmailClientForTests();

      const started = Date.now();
      const res = await sendEmail({ to: "a@example.com", subject: "s", text: "t" }, () => {});
      expect(res.status).toBe("failed");
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await ses.close();
    }
  }, 40_000);

  it("never throws — a send that cannot happen is a value, not an exception", async () => {
    process.env.AWS_REGION = "us-east-1";
    process.env.SES_ENDPOINT = "http://127.0.0.1:1"; // nothing listening
    resetEmailClientForTests();

    const res = await sendEmail({ to: "a@b.co", subject: "s", text: "t" }, () => {});
    expect(res.status).toBe("failed");
    expect(res.messageId).toBeNull();
    expect(res.error).toBeTruthy();
  }, 20_000);
});

describe("the invitation email", () => {
  async function render(customer?: string) {
    if (customer) process.env.CUSTOMER_NAME = customer;
    const captured: Array<Record<string, unknown>> = [];
    const out = await sendInvitationEmail(
      {
        to: "dana@example.com",
        inviteUrl: "https://dash.example.com/invite/tok3n",
        expiresInDays: 7,
      },
      (_m, ctx) => captured.push(ctx ?? {}),
    );
    return { out, text: String(captured[0]?.body ?? "") };
  }

  it("names the customer in the subject", async () => {
    expect(EMAIL_SUBJECTS.invitation("Example Co")).toBe("You've been added to Example Co on Smart Router");
  });

  it("carries the link as text, so a stripped button still leaves a way in", async () => {
    const { text } = await render();
    expect(text).toContain("https://dash.example.com/invite/tok3n");
  });

  it("states the expiry and the address it works for", async () => {
    const { text } = await render();
    expect(text).toContain("expires in 7 days");
    expect(text).toContain("only works for dana@example.com");
  });

  it("does not name the inviter", async () => {
    // The ticket's reasoning: an invite goes to an address nobody has verified,
    // so a mistyped one puts a colleague's name in a stranger's inbox.
    const { text } = await render();
    expect(text.toLowerCase()).not.toContain("invited by");
    expect(text).not.toContain("@magmadevs.com");
  });

  it("reports link-fallback delivery when nothing was sent", async () => {
    const { out } = await render();
    expect(out.delivery).toBe("link");
    expect(EMAIL_DELIVERY_NOTES[out.delivery]).toBe("link shown to the admin");
  });
});

describe("the password-reset email", () => {
  async function render(hours = 1) {
    const captured: Array<Record<string, unknown>> = [];
    await sendPasswordResetEmail(
      {
        to: "dana@example.com",
        resetUrl: "https://dash.example.com/reset/tok3n",
        expiresInHours: hours,
      },
      (_m, ctx) => captured.push(ctx ?? {}),
    );
    return String(captured[0]?.body ?? "");
  }

  it("uses the ticket's subject", () => {
    expect(EMAIL_SUBJECTS.password_reset("Example Co")).toBe("Reset your Smart Router password");
  });

  it("states the expiry it was actually given, not a hardcoded one", async () => {
    // lava-connect's template says 30 minutes; ours is an hour and could change
    // per mode. A number in prose that nothing derives from goes stale silently.
    expect(await render(1)).toContain("expires in 1 hour");
    expect(await render(4)).toContain("expires in 4 hours");
  });

  it("says what to do if it wasn't you, and that nothing has changed yet", async () => {
    const text = await render();
    expect(text).toContain("you can ignore this email");
    expect(text).toContain("your password won't change");
  });

  it("carries the link as text", async () => {
    expect(await render()).toContain("https://dash.example.com/reset/tok3n");
  });
});

describe("the rules both emails follow", () => {
  /** The HTML part exactly as the transport receives it: the shipping
   *  templates in the shipping shell, not a stand-in body. */
  function rendered(kind: "invitation" | "reset") {
    return kind === "invitation"
      ? renderInvitationEmail({
          to: "dana@example.com",
          inviteUrl: "https://dash.example.com/invite/tok3n",
          expiresInDays: 7,
        })
      : renderPasswordResetEmail({
          to: "dana@example.com",
          resetUrl: "https://dash.example.com/reset/tok3n",
          expiresInHours: 1,
        });
  }

  it.each(["invitation", "reset"] as const)(
    "%s has no unsubscribe, no tracking pixel and nothing loaded from elsewhere",
    (kind) => {
      // A remote image in a security email reports when it was opened and from
      // where, whether or not anybody meant it to. No <img> and no src= at all
      // is what makes "no tracking" structural rather than a promise.
      const { html, text } = rendered(kind);
      for (const part of [html.toLowerCase(), text.toLowerCase()]) {
        expect(part).not.toContain("unsubscribe");
        expect(part).not.toContain("privacy policy");
      }
      expect(html).not.toMatch(/<img\b/i);
      expect(html).not.toMatch(/\ssrc\s*=/i);
      expect(html).not.toMatch(/<link\b|url\(/i);
    },
  );

  it.each(["invitation", "reset"] as const)(
    "%s carries its link as a button and again as text",
    (kind) => {
      const { html } = rendered(kind);
      const url = `https://dash.example.com/${kind === "invitation" ? "invite" : "reset"}/tok3n`;
      expect(html).toContain(`href="${url}"`);
      // Once in the href, once as visible text beneath the button.
      expect(html.split(url).length - 1).toBeGreaterThanOrEqual(3);
    },
  );

  it("escapes what the deployment supplies before it reaches the HTML", () => {
    process.env.CUSTOMER_NAME = 'Acme <b>&</b> "Co"';
    const { html, subject } = renderInvitationEmail({
      to: "dana@example.com",
      inviteUrl: "https://dash.example.com/invite/tok3n",
      expiresInDays: 7,
    });
    expect(subject).toBe('You\'ve been added to Acme <b>&</b> "Co" on Smart Router');
    expect(html).not.toContain("<b>&</b>");
    expect(html).toContain("Acme &lt;b&gt;&amp;&lt;/b&gt; &quot;Co&quot;");
  });
});
