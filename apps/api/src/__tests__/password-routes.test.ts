import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { passwordResets, sessions, users, type User } from "@sr/db";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { hashPassword } from "../services/password.js";
import { LOCKOUT_MAX_FAILURES } from "../services/lockout.js";

/**
 * The password lifecycle over HTTP.
 *
 * `password-lifecycle.test.ts` covers the services. These pin what only the
 * routes decide — and what that file could not see: that a completed reset
 * still left its owner locked out, that changing a password allowed 300
 * guesses a minute at the current one, and that the copy told a GitHub member
 * they sign in with Google.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const OLD_PASSWORD = "the-old-one-1234";
const NEW_PASSWORD = "a-brand-new-passphrase";

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

async function member(
  email: string,
  opts: { role?: "admin" | "read_only"; password?: string | null; githubId?: string; discordId?: string } = {},
): Promise<User> {
  const [row] = await t.db
    .insert(users)
    .values({
      email,
      role: opts.role ?? "read_only",
      passwordHash: opts.password === null ? null : await hashPassword(opts.password ?? OLD_PASSWORD),
      githubId: opts.githubId ?? null,
      discordId: opts.discordId ?? null,
    })
    .returning();
  return row!;
}

async function bearer(user: User): Promise<string> {
  const [session] = await t.db
    .insert(sessions)
    .values({ userId: user.id, expiresAt: new Date(Date.now() + 3_600_000), authMethod: "password" })
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
    PUBLIC_WEB_ORIGIN: "https://dash.example.com",
    DEPLOYMENT_MODE: "onprem",
    PASSWORD_BREACH_CHECK: "off",
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

const signIn = (email: string, password: string) =>
  app!.inject({ method: "POST", url: "/auth/sign-in", payload: { email, password } });

async function lockOut(email: string): Promise<void> {
  for (let i = 0; i < LOCKOUT_MAX_FAILURES; i++) await signIn(email, "wrong-password-every-time");
}

describe("sign-in lockout", () => {
  it("answers 423 once tripped, and says when it lifts", async () => {
    await member("dana@example.com");
    await lockOut("dana@example.com");

    const res = await signIn("dana@example.com", OLD_PASSWORD);
    expect(res.statusCode).toBe(423);
    // `until` is computed for exactly this; the 423 used to discard it.
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.json().message).toMatch(/Try again in \d+ minutes?/);
  });

  it("lets the owner straight back in after a completed reset", async () => {
    // The whole failure, end to end: locked out, handed a reset link, sets a
    // new password — and until now was still answered 423 with it.
    const admin = await member("admin@example.com", { role: "admin" });
    const dana = await member("dana@example.com");
    await lockOut("dana@example.com");

    const link = await app!.inject({
      method: "POST",
      url: `/api/team/members/${dana.id}/reset-link`,
      headers: { authorization: `Bearer ${await bearer(admin)}` },
    });
    expect(link.statusCode).toBe(200);
    const token = (link.json().url as string).split("/reset/")[1]!;

    const reset = await app!.inject({
      method: "POST",
      url: "/auth/password/reset",
      payload: { token, password: NEW_PASSWORD },
    });
    expect(reset.statusCode).toBe(200);

    expect((await signIn("dana@example.com", NEW_PASSWORD)).statusCode).toBe(200);
  });
});

describe("POST /api/account/password", () => {
  it("is limited like sign-in, because it tests a credential too", async () => {
    // Under the global limit this allowed 300 guesses a minute at the current
    // password to anyone holding a session — and a correct guess ends with them
    // setting a new one and signing the owner out everywhere.
    const dana = await member("dana@example.com");
    const token = await bearer(dana);
    const guess = () =>
      app!.inject({
        method: "POST",
        url: "/api/account/password",
        headers: { authorization: `Bearer ${token}` },
        payload: { current: "a-guess-at-the-current", next: NEW_PASSWORD },
      });

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await guess()).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("names the provider a password-less member actually uses", async () => {
    const dana = await member("dana@example.com", { password: null, githubId: "gh-1" });
    const res = await app!.inject({
      method: "POST",
      url: "/api/account/password",
      headers: { authorization: `Bearer ${await bearer(dana)}` },
      payload: { current: "anything", next: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("GitHub");
    expect(res.json().message).not.toContain("Google");
  });
});

describe("POST /api/team/members/:id/reset-link", () => {
  it("names the provider a password-less member actually uses", async () => {
    const admin = await member("admin@example.com", { role: "admin" });
    const dana = await member("dana@example.com", { password: null, discordId: "dc-1" });
    const res = await app!.inject({
      method: "POST",
      url: `/api/team/members/${dana.id}/reset-link`,
      headers: { authorization: `Bearer ${await bearer(admin)}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("Discord");
    expect(res.json().message).not.toContain("Google");
  });

  it("builds the link on the configured origin", async () => {
    const admin = await member("admin@example.com", { role: "admin" });
    const dana = await member("dana@example.com");
    const res = await app!.inject({
      method: "POST",
      url: `/api/team/members/${dana.id}/reset-link`,
      headers: { authorization: `Bearer ${await bearer(admin)}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().url as string).startsWith("https://dash.example.com/reset/")).toBe(true);
  });
});

describe("POST /auth/password/forgot", () => {
  const forgot = (email: string) =>
    app!.inject({ method: "POST", url: "/auth/password/forgot", payload: { email } });

  it("says it isn't available on-prem rather than silently doing nothing", async () => {
    expect((await forgot("dana@example.com")).statusCode).toBe(404);
  });

  it("answers a member and a stranger identically, and issues a link only for the member", async () => {
    setEnv({ DEPLOYMENT_MODE: "managed" });
    await member("dana@example.com");

    const known = await forgot("dana@example.com");
    const unknown = await forgot("nobody@example.com");
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());

    // The link is issued after the reply — that is what closes the timing
    // gap — so wait for it rather than expecting it synchronously.
    const deadline = Date.now() + 10_000;
    let rows = await t.db.select().from(passwordResets);
    while (rows.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      rows = await t.db.select().from(passwordResets);
    }
    expect(rows).toHaveLength(1);
  });
});
