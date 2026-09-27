import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { auditEvents, sessions, users, type User } from "@sr/db";
import { buildApp } from "../app.js";
import { hashPassword } from "../services/password.js";
import { totpCodeAtStep, totpStepAt } from "../services/totp.js";
import { beginEnrolment, confirmEnrolment, resetTotpKeyForTests } from "../services/two-factor.js";

/**
 * Google and GitHub sign-in against an account with an authenticator.
 *
 * The provider proves who holds the Google or GitHub account — one factor.
 * MAG-2730's rule is two for everybody, so an enrolled account is asked for its
 * code after a provider sign-in exactly as after a password: a challenge and no
 * session, then `/auth/2fa/verify`.
 */

const oauth = vi.hoisted(() => ({ email: "dana@example.com" }));
vi.mock("../services/oauth.js", () => ({
  verifyOAuthToken: async (provider: string) => ({
    providerId: `${provider}-subject-123`,
    email: oauth.email,
    name: "Dana Levi",
    avatarUrl: null,
  }),
}));

const SECRET = "test-secret-for-auth-tests-32-chars!";
const INTERNAL = "internal-secret-for-tests";
const KEY = Buffer.alloc(32, 7).toString("base64");
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

beforeEach(async () => {
  t = await createTestDb();
  resetTotpKeyForTests();
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    INTERNAL_AUTH_SECRET: INTERNAL,
    TOTP_ENCRYPTION_KEY: KEY,
  });
  app = await buildApp();
  app.db = t.db;
});

afterEach(async () => {
  await app?.close();
  app = null;
  await t.close();
  resetTotpKeyForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

async function dana(): Promise<User> {
  const [created] = await t.db
    .insert(users)
    .values({
      email: "dana@example.com",
      name: "Dana Levi",
      role: "read_only",
      passwordHash: await hashPassword("correct horse battery staple"),
    })
    .returning();
  return created!;
}

async function enrol(user: User): Promise<string> {
  const offer = await beginEnrolment(t.db, user);
  const [pending] = await t.db.select().from(users).where(eq(users.id, user.id));
  const outcome = await confirmEnrolment(t.db, pending!, totpCodeAtStep(offer.secret, totpStepAt())!);
  expect(outcome.ok).toBe(true);
  return offer.secret;
}

const googleSignIn = () =>
  app!.inject({ method: "POST", url: "/auth/oauth/google", payload: { token: "an-id-token" } });

describe("Google or GitHub sign-in with an authenticator", () => {
  it("answers with a challenge and opens no session", async () => {
    const user = await dana();
    await enrol(user);

    const res = await googleSignIn();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      twoFactorRequired: true,
      challenge: expect.any(String),
      email: "dana@example.com",
    });
    expect(res.json().sessionId).toBeUndefined();
    expect(await t.db.select().from(sessions)).toHaveLength(0);
    // No sign-in has happened yet, so nothing says one did.
    const actions = (await t.db.select().from(auditEvents)).map((r) => r.action);
    expect(actions).not.toContain("signin.succeeded");
  });

  it("opens the session once the code is right, and records the provider it followed", async () => {
    const user = await dana();
    const secret = await enrol(user);

    const first = await googleSignIn();
    const done = await app!.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: {
        challenge: first.json().challenge,
        code: totpCodeAtStep(secret, totpStepAt() + 1)!,
      },
    });

    expect(done.statusCode).toBe(200);
    const [session] = await t.db.select().from(sessions);
    expect(session?.id).toBe(done.json().sessionId);
    // Not "password+totp": nobody typed a password.
    expect(session?.authMethod).toBe("google+totp");
  });

  it("refuses a wrong code the way a password sign-in's wrong code is refused", async () => {
    const user = await dana();
    await enrol(user);

    const first = await googleSignIn();
    const wrong = await app!.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge: first.json().challenge, code: "000000" },
    });

    expect(wrong.statusCode).toBe(401);
    expect(await t.db.select().from(sessions)).toHaveLength(0);
  });

  it("still signs an account without an authenticator straight in", async () => {
    await dana();

    const res = await googleSignIn();

    expect(res.statusCode).toBe(200);
    expect(res.json().sessionId).toEqual(expect.any(String));
    const [session] = await t.db.select().from(sessions);
    expect(session?.authMethod).toBe("google");
  });
});
