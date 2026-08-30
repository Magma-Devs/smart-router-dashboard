import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { desc, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { auditEvents, users } from "@sr/db";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";
import { hashPassword } from "../services/password.js";
import { resetEmailClientForTests } from "../services/email.js";

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
    DATABASE_URL: DEAD_DB,
    DEPLOYMENT_MODE: mode,
    PUBLIC_WEB_ORIGIN: "https://dash.example.com",
    PASSWORD_BREACH_CHECK: "off",
    AWS_REGION: undefined,
    CUSTOMER_NAME: "DFNS",
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
    expect(await lastNote("member.invited")).toBe("link shown to the admin");
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
    expect(await lastNote("member.invited")).toBe("link shown to the admin");
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

describe("forgot-password on managed", () => {
  it("answers 202 whether or not the address exists, and records the outcome", async () => {
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
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);

    // The link is never in the response — there is no admin in this flow to
    // hand it to, so the note is the only record that it went nowhere.
    expect(known.json()).toEqual({ ok: true });
    expect(await lastNote("password.reset_requested")).toBe("link shown to the admin");
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
    await boot("onprem");
    const res = await app!.inject({
      method: "POST",
      url: "/auth/password/reset/preview",
      payload: { token: "not-a-real-token" },
    });

    // Used, expired and never-issued are indistinguishable on purpose: telling
    // them apart tells a stranger which of them a guessed token hit.
    expect(res.statusCode).toBe(410);
    expect(res.json().message).toBe("This link has expired.");
  });
});
