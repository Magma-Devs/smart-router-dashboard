import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { desc, eq } from "drizzle-orm";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { auditEvents, sessions, users, type User } from "@sr/db";
import { EMAIL_SUBJECTS } from "@sr/shared";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";
import { hashPassword } from "../services/password.js";
import { resetEmailClientForTests } from "../services/email.js";
import { renderTwoFactorResetEmail } from "../services/email-templates.js";
import { resetByLabel } from "../services/two-factor-reset-notice.js";
import { runRecovery } from "../recover.js";
import { fakeSesEnv, startFakeSes, type FakeSes } from "./fake-ses.js";

/**
 * MAG-2869: the member is emailed when their second factor is reset.
 *
 * An admin can clear anybody's authenticator — the lost-phone path, and the
 * shortest route to an approver's account using only intended features. The
 * email is what makes that visible to the person it was done to. Managed only;
 * on-prem the `2fa.reset` row naming both people is the record.
 *
 * Sends go through the real SESv2Client to `fake-ses.ts`, so what is asserted
 * is what SES was handed.
 */

const SECRET = "test-secret-for-2fa-reset-notice-32ch";
/** Any 32 bytes — nothing here verifies a code; the api needs one to boot. */
const TOTP_KEY = "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";

let app: FastifyInstance | null = null;
let t: TestDb;
let ses: FakeSes;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Mail env cleared, so no test inherits a transport from the shell. */
const NO_TRANSPORT = {
  AWS_REGION: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  SES_ENDPOINT: undefined,
};

beforeEach(async () => {
  t = await createTestDb();
  ses = await startFakeSes();
  setEnv({ ...NO_TRANSPORT, CUSTOMER_NAME: "Example Co", TOTP_ENCRYPTION_KEY: TOTP_KEY });
  resetEmailClientForTests();
});
afterEach(async () => {
  await app?.close();
  app = null;
  await ses.close();
  await t.close();
  resetEmailClientForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

/** Point the transport at the fake. */
function withTransport(): void {
  setEnv(fakeSesEnv(ses));
  resetEmailClientForTests();
}

async function seed(values: Partial<typeof users.$inferInsert> & { email: string }): Promise<User> {
  const [row] = await t.db
    .insert(users)
    .values({ passwordHash: await hashPassword("a-long-passphrase-1"), ...values })
    .returning();
  return row!;
}

/** An app with an enrolled admin (Victoria) and an enrolled member (Dana). */
async function boot(mode: "managed" | "onprem") {
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    INTERNAL_AUTH_SECRET: "internal-secret-for-tests",
    DATABASE_URL: DEAD_DB,
    DEPLOYMENT_MODE: mode,
    PUBLIC_WEB_ORIGIN: "https://dash.example.com",
    PASSWORD_BREACH_CHECK: "off",
  });
  app = await buildApp();
  app.db = t.db;

  const admin = await seed({
    email: "victoria@example.com",
    name: "Victoria Admin",
    role: "admin",
    ...enrolledTwoFactor(),
  });
  const member = await seed({
    email: "dana@example.com",
    name: "Dana Okonkwo",
    role: "approver",
    ...enrolledTwoFactor(),
  });
  const session = await createSession(t.db, {
    userId: admin.id,
    authMethod: "password+totp",
    client: { ip: null, userAgent: null },
  });
  const token = await new SignJWT({ sub: admin.id, email: admin.email, sid: session.id })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  return { admin, member, token };
}

function reset(memberId: string, token: string) {
  return app!.inject({
    method: "POST",
    url: `/api/team/members/${memberId}/2fa/reset`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function rows(action: string) {
  return t.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, action))
    .orderBy(desc(auditEvents.seq));
}

async function memberRow(id: string): Promise<User> {
  return (await t.db.select().from(users).where(eq(users.id, id)))[0]!;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The "When:" line read back into a time, independently of the template. */
function whenOf(text: string): number {
  const m = /^When: (\w{3}) (\d{1,2}), (\d{4}), (\d{2}):(\d{2}) UTC$/m.exec(text);
  expect(m, `no When line in:\n${text}`).not.toBeNull();
  const [, month, d, y, hh, mm] = m!;
  return Date.UTC(Number(y), MONTHS.indexOf(month!), Number(d), Number(hh), Number(mm));
}

describe("the email", () => {
  const render = () =>
    renderTwoFactorResetEmail({
      to: "dana@example.com",
      resetBy: "Victoria Admin (victoria@example.com)",
      at: new Date("2026-11-11T14:05:09Z"),
    });

  it("says what happened, to which account, on which deployment", () => {
    const { subject, text } = render();
    expect(subject).toBe(EMAIL_SUBJECTS.two_factor_reset("Example Co"));
    expect(subject).toBe("Your Smart Router two-factor authentication was reset");
    expect(text).toContain(
      "Two-factor authentication was reset on your account (dana@example.com)",
    );
    expect(text).toContain("the Smart Router dashboard for Example Co");
  });

  it("names who did it, and when, in UTC", () => {
    const { text, html } = render();
    expect(text).toContain("Reset by: Victoria Admin (victoria@example.com)\n");
    expect(text).toContain("When: Nov 11, 2026, 14:05 UTC\n");
    expect(html).toContain("Victoria Admin (victoria@example.com)");
    expect(html).toContain("<strong>When:</strong> Nov 11, 2026, 14:05 UTC");
  });

  it("states the time in UTC, whatever the server's timezone", () => {
    // 23:59 in New York on 5 March is 04:59 UTC on the 6th. The process is put
    // fourteen hours ahead, so local time would read as the 6th at 18:59 —
    // a UTC machine (CI's) could not tell the two apart.
    setEnv({ TZ: "Pacific/Kiritimati" });
    const { text } = renderTwoFactorResetEmail({
      to: "dana@example.com",
      resetBy: "x",
      at: new Date("2026-03-05T23:59:00-05:00"),
    });
    expect(text).toContain("When: Mar 6, 2026, 04:59 UTC\n");
  });

  it("says they will set it up again, and what to do if they did not ask", () => {
    const { text, html } = render();
    expect(text).toContain("signed out on every device");
    expect(text).toContain("you'll be asked to set up an authenticator app again");
    expect(text).toContain(
      "If you didn't ask for this, report it to your security team or another administrator",
    );
    expect(html).toContain("If you didn't ask for this");
  });

  it("carries no link at all — nothing in it can change anything", () => {
    const { text, html } = render();
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toMatch(/\bhref\s*=/i);
    expect(text).not.toMatch(/https?:\/\//i);
    // And the shell's rules hold: no tracking, nothing loaded from elsewhere.
    expect(html).not.toMatch(/<img\b|\ssrc\s*=|<link\b|url\(/i);
    expect(`${html} ${text}`.toLowerCase()).not.toContain("unsubscribe");
  });

  it("escapes what people and the deployment supply before it reaches the HTML", () => {
    setEnv({ CUSTOMER_NAME: 'Acme <b>&</b> "Co"' });
    const { html } = renderTwoFactorResetEmail({
      to: "dana@example.com",
      resetBy: resetByLabel({ name: "<script>x</script>", email: "v@example.com" }),
      at: new Date("2026-11-11T14:05:00Z"),
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt; (v@example.com)");
    expect(html).toContain("Acme &lt;b&gt;&amp;&lt;/b&gt; &quot;Co&quot;");
  });
});

describe("naming the admin", () => {
  it("is the name and the address, as the team screen shows them", () => {
    expect(resetByLabel({ name: "Victoria Admin", email: "v@example.com" })).toBe(
      "Victoria Admin (v@example.com)",
    );
  });

  it("is the address alone when there is no name, or the name is the address", () => {
    expect(resetByLabel({ name: null, email: "v@example.com" })).toBe("v@example.com");
    expect(resetByLabel({ name: "   ", email: "v@example.com" })).toBe("v@example.com");
    expect(resetByLabel({ name: "V@Example.com", email: "v@example.com" })).toBe("v@example.com");
  });

  it("cannot add lines to the message", () => {
    // The name is whatever its holder typed when they joined. An admin abusing
    // the reset would like the email to say something else.
    const label = resetByLabel({
      name: "IT\r\n\r\nThis was routine, no action needed.\u0007",
      email: "v@example.com",
    });
    expect(label).toBe("IT This was routine, no action needed. (v@example.com)");
    const { text } = renderTwoFactorResetEmail({
      to: "d@example.com",
      resetBy: label,
      at: new Date(),
    });
    expect(text.split("\n").filter((l) => l.startsWith("Reset by:"))).toEqual([
      `Reset by: ${label}`,
    ]);
  });
});

describe("an admin's reset, managed, with a transport", () => {
  it("emails the member who did it and when, and says so", async () => {
    const { member, token } = await boot("managed");
    withTransport();

    const before = Date.now();
    const res = await reset(member.id, token);
    const after = Date.now();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, notified: "email" });

    expect(ses.sent).toHaveLength(1);
    const mail = ses.sent[0]!;
    expect(mail.to).toEqual(["dana@example.com"]);
    expect(mail.subject).toBe("Your Smart Router two-factor authentication was reset");
    expect(mail.text).toContain("Reset by: Victoria Admin (victoria@example.com)\n");
    // To the minute, between the request going in and its answer coming back.
    const when = whenOf(mail.text);
    expect(when).toBeGreaterThanOrEqual(Math.floor(before / 60_000) * 60_000);
    expect(when).toBeLessThanOrEqual(after);
    expect(mail.html).toContain("Victoria Admin (victoria@example.com)");
  });

  it("records the delivery on a row of its own, beside the reset's", async () => {
    const { admin, member, token } = await boot("managed");
    withTransport();
    await reset(member.id, token);

    const [notice] = await rows("2fa.reset_notice");
    expect(notice?.note).toBe("emailed");
    expect(notice?.actorUserId).toBe(admin.id);
    expect(notice?.targetId).toBe(member.id);
    expect(notice?.targetName).toBe("dana@example.com");
    expect(notice?.actionGroup).toBe("2fa");
    // An email has no browser behind it.
    expect(notice?.ip).toBeNull();
    expect(notice?.sessionId).toBeNull();

    // The reset's own row is untouched: still in the reset's transaction,
    // still naming both people.
    const [resetRow] = await rows("2fa.reset");
    expect(resetRow?.note).toBe("two-factor reset for dana@example.com");
    expect(resetRow?.actorUserId).toBe(admin.id);
  });

  it("has committed the reset before it tries to send", async () => {
    // While SES holds the send, the reset is already there for anybody to read.
    // A send inside the transaction would hold this read until SES answered.
    const { member, token } = await boot("managed");
    withTransport();
    ses.mode = "hold";

    const pending = reset(member.id, token);
    await expect.poll(() => ses.sent.length, { timeout: 10_000 }).toBe(1);

    const read = await Promise.race([
      memberRow(member.id),
      new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 3_000)),
    ]);
    expect(read).not.toBe("blocked");
    expect((read as User).totpSecret).toBeNull();
    expect(await rows("2fa.reset")).toHaveLength(1);

    ses.release();
    expect((await pending).json()).toEqual({ ok: true, notified: "email" });
  });

  it("still resets, and says nobody was told, when SES refuses", async () => {
    const { member, token } = await boot("managed");
    withTransport();
    ses.mode = "refuse";
    const live = await createSession(t.db, {
      userId: member.id,
      authMethod: "password+totp",
      client: { ip: null, userAgent: null },
    });

    const res = await reset(member.id, token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, notified: "on_next_signin" });
    expect(ses.sent).toHaveLength(1);
    const after = await memberRow(member.id);
    expect(after.totpSecret).toBeNull();
    expect(after.signedOutAllAt).not.toBeNull();
    const session = (await t.db.select().from(sessions).where(eq(sessions.id, live.id)))[0]!;
    expect(session.revokedAt).not.toBeNull();
    expect(await rows("2fa.reset")).toHaveLength(1);
    expect((await rows("2fa.reset_notice"))[0]?.note).toBe("email failed, not delivered");
  });
});

describe("an admin's reset, managed, with no transport", () => {
  it("sends nothing, fails nothing, and records that nobody was emailed", async () => {
    const { member, token } = await boot("managed");

    const res = await reset(member.id, token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, notified: "on_next_signin" });
    expect(ses.sent).toHaveLength(0);
    expect((await memberRow(member.id)).totpSecret).toBeNull();
    expect((await rows("2fa.reset_notice"))[0]?.note).toBe("not sent, no mail transport");
  });
});

describe("an admin's reset, on-prem", () => {
  it("sends nothing even with a transport configured, and writes no notice row", async () => {
    const { member, token } = await boot("onprem");
    withTransport();

    const res = await reset(member.id, token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, notified: "on_next_signin" });
    expect(ses.sent).toHaveLength(0);
    expect(await rows("2fa.reset_notice")).toHaveLength(0);
    // The record on-prem: the reset's row, naming both people.
    const [row] = await rows("2fa.reset");
    expect(row?.actorName).toBe("Victoria Admin");
    expect(row?.targetName).toBe("dana@example.com");
  });
});

describe("a reset from the host (recover reset-2fa)", () => {
  async function enrolled(): Promise<User> {
    return seed({ email: "dana@example.com", name: "Dana Okonkwo", ...enrolledTwoFactor() });
  }
  const quiet = () => {};

  it("emails the member on managed, naming Magma rather than the operator", async () => {
    const member = await enrolled();
    withTransport();

    const out = await runRecovery(
      t.db,
      { command: "reset-2fa", email: member.email, by: "victoria" },
      { mode: "managed", log: quiet },
    );

    expect(out.message).toContain("They were emailed that it was reset.");
    expect(ses.sent).toHaveLength(1);
    const mail = ses.sent[0]!;
    expect(mail.to).toEqual(["dana@example.com"]);
    expect(mail.text).toContain("Reset by: Magma Devs, from the server the dashboard runs on\n");
    // `--by` is whatever the operator typed; the email does not repeat it.
    expect(mail.text).not.toContain("victoria");

    const [notice] = await rows("2fa.reset_notice");
    expect(notice?.note).toBe("emailed");
    expect(notice?.actorKind).toBe("host");
    expect(notice?.actorName).toBe("Magma Devs (victoria)");
    expect(notice?.targetId).toBe(member.id);
  });

  it("still resets, and tells the operator to tell them, when SES refuses", async () => {
    const member = await enrolled();
    withTransport();
    ses.mode = "refuse";

    const out = await runRecovery(
      t.db,
      { command: "reset-2fa", email: member.email, by: "victoria" },
      { mode: "managed", log: quiet },
    );

    expect(out.message).toContain("could not be sent. Tell them yourself.");
    expect((await memberRow(member.id)).totpSecret).toBeNull();
    expect(await rows("host.recovery")).toHaveLength(1);
    expect((await rows("2fa.reset_notice"))[0]?.note).toBe("email failed, not delivered");
  });

  it("says nobody was emailed when the shell has no transport", async () => {
    const member = await enrolled();
    const lines: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];

    const out = await runRecovery(
      t.db,
      { command: "reset-2fa", email: member.email, by: "victoria" },
      { mode: "managed", log: (msg, ctx) => lines.push({ msg, ctx }) },
    );

    expect(out.message).toContain("They were not emailed");
    expect(ses.sent).toHaveLength(0);
    expect((await rows("2fa.reset_notice"))[0]?.note).toBe("not sent, no mail transport");
    // Nothing is handed to the transport, whose own "not sent" line would log
    // the body here and claim a live link in production. One line, saying
    // what happened.
    expect(lines).toEqual([
      {
        msg: "two-factor reset notice not sent — AWS_REGION is unset",
        ctx: { to: "dana@example.com" },
      },
    ]);
  });

  it("sends nothing on-prem, and its message is the reset alone", async () => {
    const member = await enrolled();
    withTransport();

    const out = await runRecovery(
      t.db,
      { command: "reset-2fa", email: member.email, by: "victoria" },
      { mode: "onprem", log: quiet },
    );

    expect(out.message).toBe(
      "Cleared the authenticator for dana@example.com. They sign in with their password and set up a new one.",
    );
    expect(ses.sent).toHaveLength(0);
    expect(await rows("2fa.reset_notice")).toHaveLength(0);
  });

  it("emails nobody for the other commands", async () => {
    const member = await enrolled();
    withTransport();

    await runRecovery(
      t.db,
      { command: "promote-admin", email: member.email, by: "victoria" },
      { mode: "managed", log: quiet },
    );

    expect(ses.sent).toHaveLength(0);
    expect(await rows("2fa.reset_notice")).toHaveLength(0);
  });
});
