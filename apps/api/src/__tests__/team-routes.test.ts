import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { sessions, users, type User } from "@sr/db";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";

/**
 * The admin invitation surface.
 *
 * `PUBLIC_WEB_ORIGIN` is what these mostly exist for: the api deliberately has
 * no default for it, because a guessed host yields a link that looks right and
 * goes nowhere — so a deployment that forgets it cannot invite anybody, and
 * until the compose files carried it, that was every compose deployment.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const WEB_ORIGIN = "https://dash.example.com";

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

async function member(email: string, role: "admin" | "read_only"): Promise<User> {
  const [row] = await t.db.insert(users).values({ email, role }).returning();
  return row!;
}

/** A Bearer for a real session row, which the gate resolves on every request. */
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

beforeEach(async () => {
  t = await createTestDb();
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    PUBLIC_WEB_ORIGIN: WEB_ORIGIN,
    DEPLOYMENT_MODE: "onprem",
  });
  app = await buildApp();
  app.db = t.db;
});

afterEach(async () => {
  await app?.close();
  app = null;
  await t.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const invite = (token: string, payload: Record<string, unknown>) =>
  app!.inject({
    method: "POST",
    url: "/api/team/invites",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

describe("POST /api/team/invites", () => {
  it("returns a link on the origin the browser actually uses", async () => {
    const admin = await member("admin@example.com", "admin");
    const res = await invite(await bearer(admin), { email: "dana@example.com", role: "approver" });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.invite.email).toBe("dana@example.com");
    expect(body.delivery).toBe("link");
    // Split rather than interpolated into a regex: WEB_ORIGIN's dots would be
    // wildcards there, so the assertion would also accept a link on a host
    // nobody configured.
    const prefix = `${WEB_ORIGIN}/invite/`;
    expect(body.url.startsWith(prefix)).toBe(true);
    expect(body.url.slice(prefix.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses to invent a host when PUBLIC_WEB_ORIGIN is unset", async () => {
    // The failure the compose files used to produce on every deployment: no
    // origin, so no link, so nobody can be invited. Loud beats a link that
    // looks right and goes nowhere.
    setEnv({ PUBLIC_WEB_ORIGIN: undefined });
    const admin = await member("admin@example.com", "admin");
    const res = await invite(await bearer(admin), { email: "dana@example.com", role: "approver" });

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/PUBLIC_WEB_ORIGIN/);
  });

  it("is admin-only", async () => {
    const reader = await member("reader@example.com", "read_only");
    const res = await invite(await bearer(reader), { email: "dana@example.com", role: "approver" });
    expect(res.statusCode).toBe(403);
  });

  it("needs a session at all", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/team/invites",
      payload: { email: "dana@example.com", role: "approver" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("hands the link over on a managed deployment too, since nothing can email it yet", async () => {
    // Answering "emailed" with no link would issue an invitation nobody
    // receives. Email is MAG-2870; until then every deployment gets the link.
    setEnv({ DEPLOYMENT_MODE: "managed" });
    const admin = await member("admin@example.com", "admin");
    const token = await bearer(admin);

    const created = await invite(token, { email: "dana@example.com", role: "approver" });
    expect(created.statusCode).toBe(201);
    expect(created.json().delivery).toBe("link");
    expect(created.json().url.startsWith(`${WEB_ORIGIN}/invite/`)).toBe(true);

    const resent = await app!.inject({
      method: "POST",
      url: `/api/team/invites/${created.json().invite.id}/resend`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resent.statusCode).toBe(200);
    expect(resent.json().url.startsWith(`${WEB_ORIGIN}/invite/`)).toBe(true);
  });

  it("refuses a second live invitation for the same address", async () => {
    const admin = await member("admin@example.com", "admin");
    const token = await bearer(admin);
    expect((await invite(token, { email: "dana@example.com", role: "approver" })).statusCode).toBe(201);
    expect((await invite(token, { email: "dana@example.com", role: "approver" })).statusCode).toBe(409);
  });

  it("refuses an over-long address at the schema, not with a 500 from the INSERT", async () => {
    const admin = await member("admin@example.com", "admin");
    const long = "a".repeat(250) + "@example.com";
    const res = await invite(await bearer(admin), { email: long, role: "approver" });
    expect(res.statusCode).toBe(400);
  });

  it("refuses an address that is already a member", async () => {
    const admin = await member("admin@example.com", "admin");
    await member("dana@example.com", "read_only");
    const res = await invite(await bearer(admin), { email: "dana@example.com", role: "approver" });
    expect(res.statusCode).toBe(409);
  });
});
