import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { desc, eq } from "drizzle-orm";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { auditEvents, sessions, users, type User } from "@sr/db";
import { EMAIL_SUBJECTS, PASSWORD_CHANGED_NOTICE_NOTES } from "@sr/shared";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { hashPassword, verifyPassword } from "../services/password.js";
import { resetEmailClientForTests } from "../services/email.js";
import { renderPasswordChangedEmail } from "../services/email-templates.js";
import { notifyPasswordChanged } from "../services/password-notice.js";
import { fakeSesEnv, startFakeSes, type FakeSes } from "./fake-ses.js";

/**
 * MAG-2868: the owner is told when their password changes, whichever way it
 * changed — from the Account page, or by a reset link being used.
 *
 * The sends go to `fake-ses.ts`, which the real `SESv2Client` talks to over
 * HTTP, so these exercise the transport the api ships. Managed only: on-prem
 * the audit row is the notice, and nothing is sent even where a transport
 * happens to be configured.
 */

const SECRET = "test-secret-for-password-notice-32ch";
/** Any 32 bytes — nothing here verifies a code; the api needs it to boot. */
const TOTP_KEY = "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const OLD_PASSWORD = "the-old-one-1234";
const NEW_PASSWORD = "a-brand-new-passphrase";

const ENV = [
  "AUTH_MODE",
  "AUTH_SECRET",
  "TOTP_ENCRYPTION_KEY",
  "INTERNAL_AUTH_SECRET",
  "DATABASE_URL",
  "DEPLOYMENT_MODE",
  "PUBLIC_WEB_ORIGIN",
  "PASSWORD_BREACH_CHECK",
  "CUSTOMER_NAME",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "SES_ENDPOINT",
];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEmailClientForTests();
}

beforeEach(() => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  setEnv({ AWS_REGION: undefined, SES_ENDPOINT: undefined, CUSTOMER_NAME: "Example Co" });
});
afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetEmailClientForTests();
});

/** Everything a person could click, or a client could fetch, in either part. */
function linksIn(message: { text: string; html: string | undefined }): string[] {
  const found: string[] = [];
  // The shell's XHTML namespace is a URI nothing fetches or renders.
  const html = (message.html ?? "").replace(/\sxmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/, "");
  for (const re of [
    /<a\b[^>]*>/gi,
    /\bhref\s*=/gi,
    /\bsrc\s*=/gi,
    /<(?:form|button|img|link)\b/gi,
  ]) {
    found.push(...(html.match(re) ?? []));
  }
  for (const part of [message.text, html]) {
    found.push(...(part.match(/\b(?:https?:\/\/|www\.)\S+/gi) ?? []));
  }
  return found;
}

describe("the notice", () => {
  const changedAt = new Date("2026-11-11T14:05:42.000Z");

  it("has a subject of its own", () => {
    expect(EMAIL_SUBJECTS.password_changed("Example Co")).toBe(
      "Your Smart Router password was changed",
    );
    expect(renderPasswordChangedEmail({ changedAt }).subject).toBe(
      "Your Smart Router password was changed",
    );
  });

  it.each([
    ["2026-11-11T14:05:42.000Z", "11 November 2026 at 14:05 UTC"],
    // Just after midnight UTC is the evening before in the Americas: the zone
    // has to be named, or the reader takes it as their own.
    ["2027-01-01T00:03:00.000Z", "1 January 2027 at 00:03 UTC"],
  ])("says when it changed, in UTC (%s)", (iso, expected) => {
    const { text, html } = renderPasswordChangedEmail({ changedAt: new Date(iso) });
    expect(text).toContain(`was changed on ${expected}.`);
    expect(html).toContain(`<strong>${expected}</strong>`);
  });

  it("says the UTC time whatever zone the server runs in", () => {
    // CI runs in UTC, where a local-time clock would read the same.
    const saved = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    try {
      const { text } = renderPasswordChangedEmail({
        changedAt: new Date("2027-01-01T00:03:00.000Z"),
      });
      expect(text).toContain("was changed on 1 January 2027 at 00:03 UTC.");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("names the deployment, and says what to do if it wasn't you", () => {
    const { text } = renderPasswordChangedEmail({ changedAt });
    expect(text).toContain("on the Smart Router dashboard for Example Co");
    expect(text).toContain("If you made this change, there is nothing else to do.");
    expect(text).toContain("If you didn't, someone else may have your password.");
    expect(text).toContain('"Forgot your password?" on the sign-in page');
    expect(text).toContain("tell your administrator");
  });

  it("carries no link at all — nothing to click, nothing to load", () => {
    // A takeover notice with a button is one an attacker can copy and bait
    // somebody into pressing. The way back is described in words instead.
    const message = renderPasswordChangedEmail({ changedAt });
    expect(linksIn(message)).toEqual([]);
    expect(message.text).toContain("This notice never contains a link.");
  });

  it("has no unsubscribe, no footer and nothing loaded from elsewhere", () => {
    const { text, html } = renderPasswordChangedEmail({ changedAt });
    for (const part of [text.toLowerCase(), html.toLowerCase()]) {
      expect(part).not.toContain("unsubscribe");
      expect(part).not.toContain("privacy policy");
    }
    expect(html).not.toMatch(/<link\b|url\(/i);
  });

  it("escapes the deployment's name before it reaches the HTML", () => {
    setEnv({ CUSTOMER_NAME: 'Acme <b>&</b> "Co"' });
    const { text, html } = renderPasswordChangedEmail({ changedAt });
    expect(text).toContain('for Acme <b>&</b> "Co" was changed');
    expect(html).not.toContain("<b>&</b>");
    expect(html).toContain("Acme &lt;b&gt;&amp;&lt;/b&gt; &quot;Co&quot;");
  });
});

describe("notifyPasswordChanged", () => {
  let ses: FakeSes;
  beforeEach(async () => {
    ses = await startFakeSes();
  });
  afterEach(async () => {
    await ses.close();
  });

  const at = new Date("2026-11-11T14:05:42.000Z");
  const quiet = () => {
    throw new Error("nothing should be logged");
  };

  it("sends nothing on-prem, even with a transport configured, and has nothing to note", async () => {
    setEnv({ DEPLOYMENT_MODE: "onprem", ...fakeSesEnv(ses) });
    expect(
      await notifyPasswordChanged({ to: "dana@example.com", changedAt: at }, quiet),
    ).toBeNull();
    expect(ses.sent).toEqual([]);
  });

  it("attempts nothing on managed without a transport, and notes that the owner was not told", async () => {
    // SES_ENDPOINT alone is not a transport: AWS_REGION is the switch.
    setEnv({ DEPLOYMENT_MODE: "managed", SES_ENDPOINT: ses.url });
    expect(await notifyPasswordChanged({ to: "dana@example.com", changedAt: at }, quiet)).toBe(
      "owner not notified, no mail transport",
    );
    expect(ses.sent).toEqual([]);
  });

  it("emails the owner on managed with a transport", async () => {
    setEnv({ DEPLOYMENT_MODE: "managed", ...fakeSesEnv(ses) });
    expect(await notifyPasswordChanged({ to: "dana@example.com", changedAt: at }, quiet)).toBe(
      "owner notified by email",
    );
    expect(ses.sent.map((m) => m.to)).toEqual([["dana@example.com"]]);
    expect(ses.sent[0]!.subject).toBe("Your Smart Router password was changed");
  });

  it("returns a refusal as a note, never as an exception", async () => {
    setEnv({ DEPLOYMENT_MODE: "managed", ...fakeSesEnv(ses) });
    ses.mode = "refuse";
    const lines: string[] = [];
    expect(
      await notifyPasswordChanged({ to: "dana@example.com", changedAt: at }, (msg) =>
        lines.push(msg),
      ),
    ).toBe("owner not notified, email failed");
    expect(lines).toEqual(["email send failed"]);
  });

  it("has a note for every outcome the transport can report", () => {
    expect(Object.keys(PASSWORD_CHANGED_NOTICE_NOTES).sort()).toEqual(["failed", "link", "sent"]);
  });
});

// ── Over HTTP ────────────────────────────────────────────────────────────────

describe("over HTTP", () => {
  let app: FastifyInstance | null = null;
  let t: TestDb;
  let ses: FakeSes;

  async function boot(mode: "managed" | "onprem", transport: "fake-ses" | "none"): Promise<void> {
    setEnv({
      AUTH_MODE: "enabled",
      AUTH_SECRET: SECRET,
      TOTP_ENCRYPTION_KEY: TOTP_KEY,
      INTERNAL_AUTH_SECRET: "internal-secret-for-tests",
      DATABASE_URL: DEAD_DB,
      DEPLOYMENT_MODE: mode,
      PUBLIC_WEB_ORIGIN: "https://dash.example.com",
      PASSWORD_BREACH_CHECK: "off",
      ...(transport === "fake-ses" ? fakeSesEnv(ses) : {}),
    });
    app = await buildApp();
    app.db = t.db;
  }

  async function member(email: string, role: "admin" | "read_only" = "read_only"): Promise<User> {
    const [row] = await t.db
      .insert(users)
      .values({
        ...enrolledTwoFactor(),
        email,
        role,
        passwordHash: await hashPassword(OLD_PASSWORD),
      })
      .returning();
    return row!;
  }

  async function bearer(user: User): Promise<string> {
    const [session] = await t.db
      .insert(sessions)
      .values({
        userId: user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        authMethod: "password",
      })
      .returning();
    return new SignJWT({ sub: user.id, email: user.email, role: user.role, sid: session!.id })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(SESSION_JWT_ISSUER)
      .setAudience(SESSION_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
  }

  async function lastNote(action: string): Promise<string | null | undefined> {
    const [row] = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, action))
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    return row ? row.note : undefined;
  }

  async function passwordIs(user: User, password: string): Promise<boolean> {
    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    return verifyPassword(password, row!.passwordHash!);
  }

  /** The message the owner should have received, rendered from the time the
   *  change wrote to their row. */
  async function expectedNotice(user: User) {
    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    return renderPasswordChangedEmail({ changedAt: row!.passwordUpdatedAt! });
  }

  beforeEach(async () => {
    t = await createTestDb();
    ses = await startFakeSes();
  });
  afterEach(async () => {
    await app?.close();
    app = null;
    await t.close();
    await ses.close();
  });

  describe("changing your own password", () => {
    async function change(user: User) {
      return app!.inject({
        method: "POST",
        url: "/api/account/password",
        headers: { authorization: `Bearer ${await bearer(user)}` },
        payload: { current: OLD_PASSWORD, next: NEW_PASSWORD },
      });
    }

    it("emails the owner on managed, with the time the change wrote, and records it", async () => {
      await boot("managed", "fake-ses");
      const dana = await member("dana@example.com");

      const res = await change(dana);

      expect(res.statusCode).toBe(200);
      expect(ses.sent).toHaveLength(1);
      const sent = ses.sent[0]!;
      expect(sent.to).toEqual(["dana@example.com"]);
      const expected = await expectedNotice(dana);
      expect(sent.subject).toBe(expected.subject);
      expect(sent.text).toBe(expected.text);
      expect(linksIn(sent)).toEqual([]);
      expect(await lastNote("password.changed")).toBe("owner notified by email");
    });

    it("still changes the password when SES refuses, and says the owner was not told", async () => {
      await boot("managed", "fake-ses");
      ses.mode = "refuse";
      const dana = await member("dana@example.com");

      const res = await change(dana);

      expect(res.statusCode).toBe(200);
      expect(await passwordIs(dana, NEW_PASSWORD)).toBe(true);
      expect(ses.sent).toHaveLength(1);
      expect(await lastNote("password.changed")).toBe("owner not notified, email failed");
    });

    it("sends nothing on-prem, and leaves the row as it always was", async () => {
      // A transport is configured on purpose: the mode alone decides.
      await boot("onprem", "fake-ses");
      const dana = await member("dana@example.com");

      expect((await change(dana)).statusCode).toBe(200);
      expect(ses.sent).toEqual([]);
      expect(await lastNote("password.changed")).toBeNull();
    });

    it("attempts nothing on managed without a transport, and says the owner was not told", async () => {
      await boot("managed", "none");
      const dana = await member("dana@example.com");

      expect((await change(dana)).statusCode).toBe(200);
      expect(ses.sent).toEqual([]);
      expect(await lastNote("password.changed")).toBe("owner not notified, no mail transport");
    });

    it("sends nothing when the change is refused", async () => {
      await boot("managed", "fake-ses");
      const dana = await member("dana@example.com");

      const res = await app!.inject({
        method: "POST",
        url: "/api/account/password",
        headers: { authorization: `Bearer ${await bearer(dana)}` },
        payload: { current: "not-the-current-one", next: NEW_PASSWORD },
      });

      expect(res.statusCode).toBe(401);
      expect(ses.sent).toEqual([]);
    });
  });

  describe("redeeming a reset link", () => {
    /** An admin-issued link, the path every deployment has. */
    async function adminLink(): Promise<{ admin: User; dana: User; token: string }> {
      const admin = await member("admin@example.com", "admin");
      const dana = await member("dana@example.com");
      const res = await app!.inject({
        method: "POST",
        url: `/api/team/members/${dana.id}/reset-link`,
        headers: { authorization: `Bearer ${await bearer(admin)}` },
      });
      expect(res.statusCode).toBe(200);
      return { admin, dana, token: (res.json().url as string).split("/reset/")[1]! };
    }

    const redeem = (token: string) =>
      app!.inject({
        method: "POST",
        url: "/auth/password/reset",
        payload: { token, password: NEW_PASSWORD },
      });

    it("emails the owner on managed, and adds it to the row that names the link's admin", async () => {
      await boot("managed", "fake-ses");
      const { admin, dana, token } = await adminLink();

      expect((await redeem(token)).statusCode).toBe(200);

      expect(ses.sent).toHaveLength(1);
      expect(ses.sent[0]!.to).toEqual(["dana@example.com"]);
      expect(ses.sent[0]!.text).toBe((await expectedNotice(dana)).text);
      expect(linksIn(ses.sent[0]!)).toEqual([]);
      expect(await lastNote("password.reset_completed")).toBe(
        `redeemed a link generated by admin ${admin.id}; owner notified by email`,
      );
    });

    it("follows a self-serve reset email with the notice", async () => {
      await boot("managed", "fake-ses");
      const dana = await member("dana@example.com");

      const asked = await app!.inject({
        method: "POST",
        url: "/auth/password/forgot",
        payload: { email: "dana@example.com" },
      });
      expect(asked.statusCode).toBe(202);
      // The reset email goes out after the 202.
      await expect.poll(() => ses.sent.length).toBe(1);
      const token = ses.sent[0]!.text.match(/\/reset\/([A-Za-z0-9_-]+)/)![1]!;

      expect((await redeem(token)).statusCode).toBe(200);

      expect(ses.sent.map((m) => m.subject)).toEqual([
        "Reset your Smart Router password",
        "Your Smart Router password was changed",
      ]);
      expect(ses.sent[1]!.text).toBe((await expectedNotice(dana)).text);
      expect(await lastNote("password.reset_completed")).toBe(
        "redeemed a self-serve link; owner notified by email",
      );
    });

    it("still completes the reset when SES refuses, and says the owner was not told", async () => {
      await boot("managed", "fake-ses");
      const { admin, dana, token } = await adminLink();
      await bearer(dana); // a session the reset has to end
      ses.mode = "refuse";

      expect((await redeem(token)).statusCode).toBe(200);

      expect(await passwordIs(dana, NEW_PASSWORD)).toBe(true);
      const live = await t.db.select().from(sessions).where(eq(sessions.userId, dana.id));
      expect(live.every((s) => s.revokedAt !== null)).toBe(true);
      expect(await lastNote("password.reset_completed")).toBe(
        `redeemed a link generated by admin ${admin.id}; owner not notified, email failed`,
      );
    });

    it("sends nothing on-prem, and leaves the row's note as it always was", async () => {
      await boot("onprem", "fake-ses");
      const { admin, token } = await adminLink();

      expect((await redeem(token)).statusCode).toBe(200);

      expect(ses.sent).toEqual([]);
      expect(await lastNote("password.reset_completed")).toBe(
        `redeemed a link generated by admin ${admin.id}`,
      );
    });

    it("attempts nothing on managed without a transport, and says the owner was not told", async () => {
      await boot("managed", "none");
      const { admin, token } = await adminLink();

      expect((await redeem(token)).statusCode).toBe(200);

      expect(ses.sent).toEqual([]);
      expect(await lastNote("password.reset_completed")).toBe(
        `redeemed a link generated by admin ${admin.id}; owner not notified, no mail transport`,
      );
    });

    it("sends nothing for a dead link", async () => {
      await boot("managed", "fake-ses");
      expect((await redeem("not-a-real-token")).statusCode).toBe(410);
      expect(ses.sent).toEqual([]);
    });
  });
});
