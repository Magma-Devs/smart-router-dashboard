import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMAIL_DELIVERY_NOTES, EMAIL_SUBJECTS } from "@sr/shared";
import { sendEmail, resetEmailClientForTests } from "../services/email.js";
import { sendInvitationEmail, sendPasswordResetEmail } from "../services/email-templates.js";

/**
 * The two emails MAG-2870 specifies, and the transport under them.
 *
 * Nothing here talks to SES: with `AWS_REGION` unset the transport logs instead
 * of sending, which is the same path a managed deployment takes before anybody
 * wires up mail. That makes the dev fallback itself the thing under test, and
 * it is worth testing — it decides whether an admin is handed the link.
 */

const saved: Record<string, string | undefined> = {};
const ENV = ["AWS_REGION", "EMAIL_FROM", "CUSTOMER_NAME", "SES_ENDPOINT"];

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
    expect(EMAIL_SUBJECTS.invitation("DFNS")).toBe("You've been added to DFNS on Smart Router");
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
    expect(EMAIL_SUBJECTS.password_reset("DFNS")).toBe("Reset your Smart Router password");
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
  /** Rendering the HTML the same way the transport receives it. */
  async function html(kind: "invitation" | "reset"): Promise<string> {
    let captured = "";
    const spy = (_m: string, ctx?: Record<string, unknown>) => {
      captured = String(ctx?.body ?? "");
    };
    if (kind === "invitation") {
      await sendInvitationEmail({ to: "d@e.co", inviteUrl: "https://x/y", expiresInDays: 7 }, spy);
    } else {
      await sendPasswordResetEmail(
        { to: "d@e.co", resetUrl: "https://x/y", expiresInHours: 1 },
        spy,
      );
    }
    return captured;
  }

  it.each(["invitation", "reset"] as const)(
    "%s has no unsubscribe, no tracking pixel and no remote images",
    async (kind) => {
      // Asserted on the text part plus the rendered document; the shell has no
      // <img> at all, which is what makes "no tracking" structural rather than
      // a promise. A remote image in a security email reports when it was
      // opened and from where, whether or not anybody meant it to.
      const { renderEmailHtml } = await import("../services/email-layout.js");
      const doc = renderEmailHtml({ subject: "s", body: "<p>body</p>" });
      expect(doc).not.toContain("<img");
      expect(doc.toLowerCase()).not.toContain("unsubscribe");
      expect(doc.toLowerCase()).not.toContain("privacy policy");
      expect(await html(kind)).not.toContain("unsubscribe");
    },
  );

  it("escapes an address into the HTML rather than interpolating it raw", async () => {
    const { escapeHtml } = await import("../services/email-layout.js");
    expect(escapeHtml('a"<b>&c')).toBe("a&quot;&lt;b&gt;&amp;c");
  });
});
