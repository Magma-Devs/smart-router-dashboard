import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { users } from "@sr/db";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { resetSetupTokenForTests } from "../services/setup.js";

/**
 * First-run over HTTP. The cases that matter are the ones where getting it
 * wrong hands a stranger an admin account.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
const TOKEN = "setup-token-from-the-installer";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const GOOD_PASSWORD = "correct horse battery staple";

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

beforeEach(async () => {
  t = await createTestDb();
  resetSetupTokenForTests();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await t.close();
  resetSetupTokenForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function buildSetupApp(mode: "managed" | "onprem" = "onprem"): Promise<FastifyInstance> {
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    SETUP_TOKEN: TOKEN,
    DEPLOYMENT_MODE: mode,
    // No network from tests. The policy itself is covered in password-policy.test.ts.
    PASSWORD_BREACH_CHECK: "off",
  });
  const instance = await buildApp();
  instance.db = t.db;
  return instance;
}

const bootstrap = () => app!.inject({ method: "GET", url: "/auth/bootstrap" });
const setup = (payload: Record<string, unknown>) =>
  app!.inject({ method: "POST", url: "/auth/setup", payload });

describe("GET /auth/bootstrap", () => {
  it("reports a fresh install as needing setup, with its mode", async () => {
    app = await buildSetupApp("onprem");
    const res = await bootstrap();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: true, mode: "onprem" });
  });

  it("stops asking once an admin exists", async () => {
    app = await buildSetupApp();
    await t.db.insert(users).values({ email: "admin@example.com", role: "admin" });
    expect((await bootstrap()).json().needsSetup).toBe(false);
  });

  it("never reveals the setup token", async () => {
    // Anyone may ask whether an install is unclaimed — that is visible from the
    // login page anyway. Only log or filesystem access should let them claim it.
    app = await buildSetupApp();
    expect((await bootstrap()).body).not.toContain(TOKEN);
  });

  it("is reachable without a session, because there is nobody to be yet", async () => {
    app = await buildSetupApp();
    expect((await bootstrap()).statusCode).not.toBe(401);
  });
});

describe("POST /auth/setup", () => {
  it("refuses without the installer's token", async () => {
    app = await buildSetupApp();
    const res = await setup({ token: "guessed", email: "a@example.com", password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(await t.db.select().from(users)).toHaveLength(0);
  });

  it("creates the first admin and signs them in", async () => {
    app = await buildSetupApp();
    const res = await setup({
      token: TOKEN,
      email: "Dana@Example.com",
      password: GOOD_PASSWORD,
      name: "Dana Levi",
    });
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.user.role).toBe("admin");
    expect(body.user.email).toBe("dana@example.com");

    // The returned session must be one the gate then accepts — otherwise the
    // operator finishes setup and is immediately locked out.
    const token = await new SignJWT({
      sub: body.user.id,
      email: body.user.email,
      role: "admin",
      sid: body.sessionId,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(SESSION_JWT_ISSUER)
      .setAudience(SESSION_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));

    const after = await app.inject({
      method: "GET",
      url: "/api/metrics/specs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).not.toBe(401);
  });

  it("closes the door behind itself", async () => {
    app = await buildSetupApp();
    expect(
      (await setup({ token: TOKEN, email: "one@example.com", password: GOOD_PASSWORD })).statusCode,
    ).toBe(201);

    const second = await setup({ token: TOKEN, email: "two@example.com", password: GOOD_PASSWORD });
    expect(second.statusCode).toBe(409);
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("refuses a claimed install even with the right token", async () => {
    // Belt and braces: the token is not a master key, it is a one-time claim.
    app = await buildSetupApp();
    await t.db.insert(users).values({ email: "someone@example.com", role: "admin" });

    const res = await setup({
      token: TOKEN,
      email: "attacker@example.com",
      password: GOOD_PASSWORD,
    });
    expect(res.statusCode).toBe(409);
  });

  it("applies the password policy", async () => {
    app = await buildSetupApp();
    const res = await setup({ token: TOKEN, email: "a@example.com", password: "short" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/at least 8/);
    expect(await t.db.select().from(users)).toHaveLength(0);
  });

  it("reopens for an install whose accounts have all been removed", async () => {
    app = await buildSetupApp();
    await t.db
      .insert(users)
      .values({ email: "gone@example.com", role: "admin", status: "removed" });
    expect((await bootstrap()).json().needsSetup).toBe(true);

    const res = await setup({ token: TOKEN, email: "new@example.com", password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(201);
  });
});
