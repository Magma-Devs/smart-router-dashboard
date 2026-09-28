import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { desc, eq } from "drizzle-orm";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { auditEvents, passwordResets, users } from "@sr/db";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";
import { hashPassword } from "../services/password.js";
import { resetEmailClientForTests } from "../services/email.js";
import { fakeSesEnv, startFakeSes, type FakeSes } from "./fake-ses.js";

/**
 * What the routes do with a send, in both deployment shapes.
 *
 * `AWS_REGION` is unset throughout, so the transport reports `logged` and
 * nothing leaves the process. That is the state every managed deployment is in
 * until somebody wires up SES — and the interesting behaviour is precisely what
 * happens then, because the invitation row is already committed by the time the
 * send is attempted.
 */

const SECRET = "test-secret-for-email-delivery-32ch!";
/** Any 32 bytes — these tests never verify a code, they only need the api
 *  to boot with AUTH_MODE=enabled. */
const TOTP_KEY = "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";

let app: FastifyInstance | null = null;
let t: TestDb;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function boot(mode: "managed" | "onprem"): Promise<string> {
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    TOTP_ENCRYPTION_KEY: TOTP_KEY,
    INTERNAL_AUTH_SECRET: "internal-secret-for-tests",
    DATABASE_URL: DEAD_DB,
    DEPLOYMENT_MODE: mode,
    PUBLIC_WEB_ORIGIN: "https://dash.example.com",
    PASSWORD_BREACH_CHECK: "off",
    AWS_REGION: undefined,
    CUSTOMER_NAME: "Example Co",
  });
  resetEmailClientForTests();
  app = await buildApp();
  app.db = t.db;

  const [admin] = await t.db
    .insert(users)
    .values({
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      passwordHash: await hashPassword("an-admin-passphrase-1"),
      ...enrolledTwoFactor(),
    })
    .returning();
  const session = await createSession(t.db, {
    userId: admin!.id,
    authMethod: "password",
    client: { ip: null, userAgent: null },
  });
  return await new SignJWT({ sub: admin!.id, email: admin!.email, sid: session.id })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await app?.close();
  app = null;
  await t.close();
  resetEmailClientForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function lastNote(action: string): Promise<string | null> {
  const [row] = await t.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, action))
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  return row?.note ?? null;
}

describe("inviting on-prem", () => {
  it("returns the link and never attempts a send", async () => {
    const token = await boot("onprem");
    const res = await app!.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "dana@example.com", role: "read_only" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.delivery).toBe("link");
    expect(body.url).toContain("https://dash.example.com/invite/");
    expect(body.deliveryFallback).toBe(false);
    // The role and expiry MAG-2729 asks this row for come first; the delivery
    // record is what follows the semicolon.
    expect(await lastNote("member.invited")).toMatch(
      /^as read_only, expires \S+; link shown to the admin$/,
    );
  });
});

describe("inviting on managed, with no transport configured", () => {
  it("still returns the link, and says the admin is carrying it", async () => {
    // The row is committed before the send is attempted, so failing the request
    // would report failure for something that half happened. Returning 201 with
    // no link would leave the admin believing an invitation is on its way to
    // somebody who will never receive it.
    const token = await boot("managed");
    const res = await app!.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "dana@example.com", role: "requester" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.url).toContain("https://dash.example.com/invite/");
    expect(body.delivery).toBe("link");
    expect(body.deliveryFallback).toBe(true);
  });

  it("records on the audit row that nothing was sent", async () => {
    const token = await boot("managed");
    await app!.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "dana@example.com", role: "read_only" },
    });

    // The note is the whole delivery record — there is no email-log table, and
    // this is where an auditor already looks.
    // The role and expiry MAG-2729 asks this row for come first; the delivery
    // record is what follows the semicolon.
    expect(await lastNote("member.invited")).toMatch(
      /^as read_only, expires \S+; link shown to the admin$/,
    );
  });

  it("resend answers the same way", async () => {
    const token = await boot("managed");
    const created = await app!.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "dana@example.com", role: "read_only" },
    });
    const id = created.json().invite.id as string;

    const res = await app!.inject({
      method: "POST",
      url: `/api/team/invites/${id}/resend`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deliveryFallback).toBe(true);
    expect(res.json().url).toContain("/invite/");
    expect(await lastNote("invite.resent")).toBe("link shown to the admin");
  });
});

describe("forgot-password on managed, with no transport configured", () => {
  it("fails closed, the same for every address, and issues nothing", async () => {
    const token = await boot("managed");
    await t.db.insert(users).values({
      email: "dana@example.com",
      passwordHash: await hashPassword("dana-passphrase-1"),
    });

    const known = await app!.inject({
      method: "POST",
      url: "/auth/password/forgot",
      payload: { email: "dana@example.com" },
    });
    const unknown = await app!.inject({
      method: "POST",
      url: "/auth/password/forgot",
      payload: { email: "nobody@example.com" },
    });

    // Identical answers: anything else turns this into a way to ask who is a
    // member. Unused, but the admin token proves the app booted managed.
    expect(token).toBeTruthy();
    expect(known.statusCode).toBe(404);
    expect(known.json()).toEqual(unknown.json());

    // Unlike an invitation there is no admin to hand the link to, so a link
    // nobody receives is not issued at all — it would only be logged, and it
    // would kill any live link the member already holds.
    expect(await t.db.select().from(passwordResets)).toHaveLength(0);
    expect(await lastNote("password.reset_requested")).toBeNull();
  });
});

/** The note of the newest row for `action`, once one exists. Self-serve work
 *  can finish after the response, so a read straight after it may be early. */
async function waitForNote(action: string): Promise<string | null> {
  for (let i = 0; i < 100; i++) {
    const note = await lastNote(action);
    if (note !== null) return note;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("forgot-password on managed, with a transport", () => {
  let ses: FakeSes;
  beforeEach(async () => {
    ses = await startFakeSes();
  });
  afterEach(async () => {
    await ses.close();
  });

  async function managedWithDana(): Promise<void> {
    await boot("managed");
    setEnv(fakeSesEnv(ses));
    resetEmailClientForTests();
    await t.db.insert(users).values({
      email: "dana@example.com",
      passwordHash: await hashPassword("dana-passphrase-1"),
    });
  }

  const forgot = (email: string) =>
    app!.inject({ method: "POST", url: "/auth/password/forgot", payload: { email } });

  it("emails the link, answers 202 for every address, and never returns the link", async () => {
    await managedWithDana();

    const known = await forgot("dana@example.com");
    const unknown = await forgot("nobody@example.com");

    expect(known.statusCode).toBe(202);
    expect(known.json()).toEqual({ ok: true });
    expect(unknown.json()).toEqual(known.json());
    expect(await waitForNote("password.reset_requested")).toBe("emailed");
    expect(ses.sent.map((m) => m.to)).toEqual([["dana@example.com"]]);
    expect(ses.sent[0]!.text).toMatch(/https:\/\/dash\.example\.com\/reset\/[A-Za-z0-9_-]+/);
  });

  it("says no link was delivered when SES refuses — not that an admin holds one", async () => {
    await managedWithDana();
    ses.mode = "refuse";

    expect((await forgot("dana@example.com")).statusCode).toBe(202);

    // There is no admin in this flow. "link shown to the admin" here would send
    // somebody investigating a takeover looking for one.
    expect(await waitForNote("password.reset_requested")).toBe("email failed, no link delivered");
  });

  it("answers before the account is looked up or the email sent", async () => {
    // An account costs a lookup, two writes and an SES round trip; an unknown
    // address one SELECT. Answering after that work would say which one it was
    // through how long it took. With SES holding the send, a route that waited
    // for it would never answer.
    await managedWithDana();
    ses.mode = "hold";

    const answered = await Promise.race([
      forgot("dana@example.com").then((r) => r.statusCode),
      new Promise<string>((r) => setTimeout(() => r("still waiting"), 5_000)),
    ]);
    expect(answered).toBe(202);

    ses.release();
    expect(await waitForNote("password.reset_requested")).toBe("emailed");
  });

  it("sends one link per cooldown, and keeps the first one working", async () => {
    await managedWithDana();

    await forgot("dana@example.com");
    expect(await waitForNote("password.reset_requested")).toBe("emailed");
    const first = ses.sent[0]!.text.match(/\/reset\/([A-Za-z0-9_-]+)/)![1]!;

    // A second ask inside the window — a person impatient for the email, or
    // somebody trying to fill the inbox and kill every link in it.
    const again = await forgot("dana@example.com");
    expect(again.statusCode).toBe(202);
    await expect
      .poll(async () =>
        (
          await t.db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.action, "password.reset_requested"))
        ).length,
      )
      .toBe(2);

    expect(ses.sent).toHaveLength(1);
    expect(await lastNote("password.reset_requested")).toBe(
      "not re-sent, a recent link is still unused",
    );
    const preview = await app!.inject({
      method: "POST",
      url: "/auth/password/reset/preview",
      payload: { token: first },
    });
    expect(preview.statusCode).toBe(200);
  });

  it("does not let an admin-issued link hold back the holder's own request", async () => {
    const adminToken = await boot("managed");
    setEnv(fakeSesEnv(ses));
    resetEmailClientForTests();
    const [dana] = await t.db
      .insert(users)
      .values({ email: "dana@example.com", passwordHash: await hashPassword("dana-passphrase-1") })
      .returning();
    const issued = await app!.inject({
      method: "POST",
      url: `/api/team/members/${dana!.id}/reset-link`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(issued.statusCode).toBe(200);

    await forgot("dana@example.com");
    expect(await waitForNote("password.reset_requested")).toBe("emailed");
    expect(ses.sent).toHaveLength(1);
  });
});

describe("the reset-link preview", () => {
  it("names the account a live link changes", async () => {
    const token = await boot("onprem");
    const [dana] = await t.db
      .insert(users)
      .values({
        email: "dana@example.com",
        passwordHash: await hashPassword("dana-passphrase-1"),
      })
      .returning();

    const link = await app!.inject({
      method: "POST",
      url: `/api/team/members/${dana!.id}/reset-link`,
      headers: { authorization: `Bearer ${token}` },
    });
    const url = link.json().url as string;
    const rawToken = url.split("/").pop()!;

    const preview = await app!.inject({
      method: "POST",
      url: "/auth/password/reset/preview",
      payload: { token: rawToken },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ email: "dana@example.com" });
  });

  it("answers one way for every dead link", async () => {
    // Used, expired, never issued and belonging to a removed account are
    // indistinguishable on purpose: telling them apart tells a stranger which
    // of them a guessed token hit. Each is made for real, then compared.
    const admin = await boot("onprem");
    const mint = async (email: string): Promise<{ id: string; token: string }> => {
      const [u] = await t.db
        .insert(users)
        .values({ email, passwordHash: await hashPassword("a-passphrase-1") })
        .returning();
      const link = await app!.inject({
        method: "POST",
        url: `/api/team/members/${u!.id}/reset-link`,
        headers: { authorization: `Bearer ${admin}` },
      });
      return { id: u!.id, token: (link.json().url as string).split("/reset/")[1]! };
    };
    const preview = (token: string) =>
      app!.inject({ method: "POST", url: "/auth/password/reset/preview", payload: { token } });

    const used = await mint("used@example.com");
    expect(
      (
        await app!.inject({
          method: "POST",
          url: "/auth/password/reset",
          payload: { token: used.token, password: "a-brand-new-passphrase" },
        })
      ).statusCode,
    ).toBe(200);

    const expired = await mint("expired@example.com");
    await t.db
      .update(passwordResets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResets.userId, expired.id));

    const removed = await mint("removed@example.com");
    await t.db.update(users).set({ status: "removed" }).where(eq(users.id, removed.id));

    const answers = await Promise.all(
      [used.token, expired.token, removed.token, "not-a-real-token"].map(async (tok) => {
        const res = await preview(tok);
        return { status: res.statusCode, body: res.json() };
      }),
    );
    for (const answer of answers) {
      expect(answer).toEqual({
        status: 410,
        body: { statusCode: 410, error: "Gone", message: "This link has expired." },
      });
    }
  });
});

describe("inviting on managed, with a transport", () => {
  let ses: FakeSes;
  beforeEach(async () => {
    ses = await startFakeSes();
  });
  afterEach(async () => {
    await ses.close();
  });

  async function invite(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const token = await boot("managed");
    setEnv({ ...fakeSesEnv(ses), CUSTOMER_NAME: "Example Co" });
    resetEmailClientForTests();
    const res = await app!.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "dana@example.com", role: "approver" },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  it("emails the link and does not hand it to the admin", async () => {
    const { statusCode, body } = await invite();

    expect(statusCode).toBe(201);
    expect(body.delivery).toBe("email");
    expect(body.deliveryFallback).toBe(false);
    // In the recipient's inbox and nowhere else — the point of a transport.
    expect(body).not.toHaveProperty("url");
    expect(ses.sent).toHaveLength(1);
    expect(ses.sent[0]!.to).toEqual(["dana@example.com"]);
    expect(ses.sent[0]!.subject).toBe("You've been added to Example Co on Smart Router");
    expect(ses.sent[0]!.text).toMatch(/https:\/\/dash\.example\.com\/invite\/[A-Za-z0-9_-]+/);
    expect(await lastNote("member.invited")).toMatch(/^as approver, expires \S+; emailed$/);
  });

  it("hands the admin the link when SES refuses, and says the email failed", async () => {
    ses.mode = "refuse";
    const { statusCode, body } = await invite();

    expect(statusCode).toBe(201);
    expect(body.delivery).toBe("link");
    expect(body.deliveryFallback).toBe(true);
    expect(String(body.url)).toContain("https://dash.example.com/invite/");
    expect(await lastNote("member.invited")).toMatch(
      /^as approver, expires \S+; email failed, link shown to the admin$/,
    );
  });
});
