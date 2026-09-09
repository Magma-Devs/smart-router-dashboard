import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { loginAttempts, sessions, twoFactorChallenges, users, type User } from "@sr/db";
import type { Role } from "@sr/shared";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";
import { hashPassword } from "../services/password.js";
import { resetSetupTokenForTests } from "../services/setup.js";
import { totpCodeAtStep, totpStepAt } from "../services/totp.js";
import {
  beginEnrolment,
  clearEnrolment,
  confirmEnrolment,
  consumeChallenge,
  consumeCode,
  GRACE_PERIOD_MS,
  isEnrolled,
  issueChallenge,
  open,
  resetTotpKeyForTests,
  seal,
  twoFactorStatus,
} from "../services/two-factor.js";

/**
 * Two-factor login, MAG-2730 — the service, and the two-step sign-in end to end.
 *
 * The RFC 6238 arithmetic is `totp.test.ts`'s. These are the things that only
 * mean anything against a database: that a password alone opens no session, that
 * a code cannot be spent twice, and that the grace period runs for exactly one
 * account.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
const INTERNAL = "internal-secret-for-tests";
const KEY = Buffer.alloc(32, 7).toString("base64");
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const PASSWORD = "correct horse battery staple";

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
  setEnv({ TOTP_ENCRYPTION_KEY: KEY });
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

async function buildAuthApp(): Promise<FastifyInstance> {
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    INTERNAL_AUTH_SECRET: INTERNAL,
    TOTP_ENCRYPTION_KEY: KEY,
    PUBLIC_WEB_ORIGIN: "https://dash.example.com",
  });
  const instance = await buildApp();
  instance.db = t.db;
  return instance;
}

let seq = 0;
async function seedUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<User> {
  const [created] = await t.db
    .insert(users)
    .values({
      email: `dana+${++seq}@example.com`,
      name: "Dana Levi",
      role: "read_only",
      passwordHash: await hashPassword(PASSWORD),
      ...overrides,
    })
    .returning();
  return created!;
}

async function reload(id: string): Promise<User> {
  const rows = await t.db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0]!;
}

/** Enrol an account for real — offer, then confirm with a live code. */
async function enrol(user: User): Promise<{ user: User; secret: string }> {
  const offer = await beginEnrolment(t.db, user);
  const pending = await reload(user.id);
  const code = totpCodeAtStep(offer.secret, totpStepAt())!;
  const outcome = await confirmEnrolment(t.db, pending, code);
  expect(outcome.ok).toBe(true);
  return { user: await reload(user.id), secret: offer.secret };
}

async function mint(opts: { sub: string; sid: string; role?: Role }): Promise<string> {
  return new SignJWT({
    sub: opts.sub,
    email: "dana@example.com",
    role: opts.role ?? "read_only",
    sid: opts.sid,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

async function tokenFor(user: User): Promise<string> {
  const session = await createSession(t.db, {
    userId: user.id,
    authMethod: "password",
    client: { ip: "84.229.11.6", userAgent: "Chrome/141.0.0.0 Safari/537.36 (Macintosh)" },
  });
  return mint({ sub: user.id, sid: session.id, role: user.role });
}

// ── Encryption at rest ──────────────────────────────────────────────────────

describe("secret storage", () => {
  it("round-trips through the envelope", () => {
    expect(open(seal("GEZDGNBVGY3TQOJQ"))).toBe("GEZDGNBVGY3TQOJQ");
  });

  it("never stores the secret in the clear", async () => {
    const user = await seedUser();
    const offer = await beginEnrolment(t.db, user);
    const stored = (await reload(user.id)).totpSecret!;
    expect(stored).not.toContain(offer.secret);
    expect(open(stored)).toBe(offer.secret);
  });

  it("produces a different envelope each time — a shared IV would leak equality", () => {
    expect(seal("SAME")).not.toBe(seal("SAME"));
  });

  it("refuses a tampered envelope rather than decrypting to garbage", () => {
    const envelope = seal("GEZDGNBVGY3TQOJQ");
    const bytes = Buffer.from(envelope, "base64");
    bytes[bytes.length - 1] ^= 0xff;
    expect(open(bytes.toString("base64"))).toBeNull();
  });

  it("refuses an envelope written under a different key", () => {
    const envelope = seal("GEZDGNBVGY3TQOJQ");
    resetTotpKeyForTests();
    setEnv({ TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") });
    expect(open(envelope)).toBeNull();
  });

  it("fails loudly when no key is configured — there is no safe default", () => {
    resetTotpKeyForTests();
    setEnv({ TOTP_ENCRYPTION_KEY: undefined });
    expect(() => seal("x")).toThrow(/TOTP_ENCRYPTION_KEY/);
  });

  it("refuses a key that is not 32 bytes", () => {
    resetTotpKeyForTests();
    setEnv({ TOTP_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") });
    expect(() => seal("x")).toThrow(/32 bytes/);
  });
});

// ── Enrolment ───────────────────────────────────────────────────────────────

describe("enrolment", () => {
  it("does not protect the account until a code is confirmed", async () => {
    const user = await seedUser();
    await beginEnrolment(t.db, user);
    expect(isEnrolled(await reload(user.id))).toBe(false);

    const { user: enrolled } = await enrol(await reload(user.id));
    expect(isEnrolled(enrolled)).toBe(true);
  });

  it("refuses a wrong confirmation code", async () => {
    const user = await seedUser();
    await beginEnrolment(t.db, user);
    const outcome = await confirmEnrolment(t.db, await reload(user.id), "000000");
    expect(outcome).toEqual({ ok: false, reason: "bad_code" });
    expect(isEnrolled(await reload(user.id))).toBe(false);
  });

  it("spends the confirming code, so it cannot then be replayed to sign in", async () => {
    const user = await seedUser();
    const offer = await beginEnrolment(t.db, user);
    const step = totpStepAt();
    const code = totpCodeAtStep(offer.secret, step)!;
    await confirmEnrolment(t.db, await reload(user.id), code);

    const enrolled = await reload(user.id);
    expect(enrolled.totpLastStep).toBe(step);
    // The enrolment screen and the login screen share one counter.
    expect(await consumeCode(t.db, enrolled, code)).toEqual({ ok: false, reason: "bad_code" });
  });

  it("replaces a pending secret when enrolment is restarted", async () => {
    const user = await seedUser();
    const first = await beginEnrolment(t.db, user);
    const second = await beginEnrolment(t.db, await reload(user.id));
    expect(second.secret).not.toBe(first.secret);
    // The abandoned secret is gone, not merely unused.
    expect(open((await reload(user.id)).totpSecret!)).toBe(second.secret);
  });

  it("renders a QR carrying the otpauth URI, not a link to one", async () => {
    const user = await seedUser();
    const offer = await beginEnrolment(t.db, user);
    expect(offer.qrSvg).toContain("<svg");
    // The URI itself never leaves as a URL — only as pixels and as the text
    // secret beside them.
    expect(offer.qrSvg).not.toContain("otpauth://");
    expect(offer.secret).toMatch(/^[A-Z2-7]{32}$/);
  });
});

// ── The replay guard ────────────────────────────────────────────────────────

describe("code replay", () => {
  it("accepts a code once and refuses the same code inside its own window", async () => {
    const user = await seedUser();
    const { user: enrolled, secret } = await enrol(user);
    // Enrolment already spent the current step, so use the next one.
    const step = totpStepAt() + 1;
    const code = totpCodeAtStep(secret, step)!;

    const withNext = { ...enrolled, totpLastStep: enrolled.totpLastStep };
    expect(await consumeCode(t.db, withNext, code)).toEqual({ ok: true });
    expect(await consumeCode(t.db, await reload(user.id), code)).toEqual({
      ok: false,
      reason: "bad_code",
    });
  });

  it("lets only one of two simultaneous submissions through", async () => {
    const user = await seedUser();
    const { secret } = await enrol(user);
    const enrolled = await reload(user.id);
    const code = totpCodeAtStep(secret, totpStepAt() + 1)!;

    // Both callers read the same pre-state, as two tabs would. The guard is in
    // the WHERE clause, so the second UPDATE matches no row.
    const [a, b] = await Promise.all([
      consumeCode(t.db, enrolled, code),
      consumeCode(t.db, enrolled, code),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("refuses a code for an account with no enrolment", async () => {
    const user = await seedUser();
    expect(await consumeCode(t.db, user, "123456")).toEqual({
      ok: false,
      reason: "not_enrolled",
    });
  });
});

// ── Challenges ──────────────────────────────────────────────────────────────

describe("challenges", () => {
  it("is single-use", async () => {
    const user = await seedUser();
    const { token } = await issueChallenge(t.db, user.id);
    expect((await consumeChallenge(t.db, token)).ok).toBe(true);
    expect(await consumeChallenge(t.db, token)).toEqual({ ok: false, reason: "used" });
  });

  it("retires an earlier unspent challenge, so one password leaves one way in", async () => {
    const user = await seedUser();
    const first = await issueChallenge(t.db, user.id);
    await issueChallenge(t.db, user.id);
    expect(await consumeChallenge(t.db, first.token)).toEqual({ ok: false, reason: "used" });
  });

  it("expires", async () => {
    const user = await seedUser();
    const { token } = await issueChallenge(t.db, user.id);
    await t.db
      .update(twoFactorChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(twoFactorChallenges.userId, user.id));
    expect(await consumeChallenge(t.db, token)).toEqual({ ok: false, reason: "expired" });
  });

  it("stores only a hash — a database read cannot be replayed as a challenge", async () => {
    const user = await seedUser();
    const { token } = await issueChallenge(t.db, user.id);
    const [row] = await t.db.select().from(twoFactorChallenges);
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses one belonging to an account that is no longer active", async () => {
    const user = await seedUser();
    const { token } = await issueChallenge(t.db, user.id);
    await t.db.update(users).set({ status: "removed" }).where(eq(users.id, user.id));
    expect(await consumeChallenge(t.db, token)).toEqual({ ok: false, reason: "user_inactive" });
  });
});

// ── The grace period ────────────────────────────────────────────────────────

describe("grace period", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("runs for the first admin only, from their first sign-in", async () => {
    const now = Date.now();
    const status = twoFactorStatus(
      {
        totpSecret: null,
        totpEnrolledAt: null,
        createdBySetup: true,
        firstSignInAt: new Date(now - 18 * DAY),
      },
      now,
    );
    expect(status.mayDefer).toBe(true);
    expect(status.enrolmentRequired).toBe(false);
    expect(status.daysLeft).toBe(12);
  });

  it("gives an invited person none at all", async () => {
    const status = twoFactorStatus({
      totpSecret: null,
      totpEnrolledAt: null,
      createdBySetup: false,
      firstSignInAt: new Date(),
    });
    expect(status.mayDefer).toBe(false);
    expect(status.enrolmentRequired).toBe(true);
    expect(status.daysLeft).toBeNull();
  });

  it("shuts at thirty days", async () => {
    const now = Date.now();
    const status = twoFactorStatus(
      {
        totpSecret: null,
        totpEnrolledAt: null,
        createdBySetup: true,
        firstSignInAt: new Date(now - GRACE_PERIOD_MS - 1),
      },
      now,
    );
    expect(status.mayDefer).toBe(false);
    expect(status.enrolmentRequired).toBe(true);
    expect(status.daysLeft).toBe(0);
  });

  it("rounds up, so the last day reads '1 day left' while the dashboard opens", async () => {
    const now = Date.now();
    const status = twoFactorStatus(
      {
        totpSecret: null,
        totpEnrolledAt: null,
        createdBySetup: true,
        firstSignInAt: new Date(now - GRACE_PERIOD_MS + 60_000),
      },
      now,
    );
    expect(status.daysLeft).toBe(1);
    expect(status.mayDefer).toBe(true);
  });

  it("stops mattering once they enrol", async () => {
    const status = twoFactorStatus({
      totpSecret: "envelope",
      totpEnrolledAt: new Date(),
      createdBySetup: true,
      firstSignInAt: new Date(Date.now() - 40 * DAY),
    });
    expect(status).toMatchObject({ enrolled: true, enrolmentRequired: false, daysLeft: null });
  });

  it("does not start until the account has actually signed in", async () => {
    // Setup creates the account and opens no session; the clock starts at the
    // sign-in that follows. Until then there is nothing to count from.
    const status = twoFactorStatus({
      totpSecret: null,
      totpEnrolledAt: null,
      createdBySetup: true,
      firstSignInAt: null,
    });
    expect(status.enrolmentRequired).toBe(true);
  });
});

// ── Sign-in, end to end ─────────────────────────────────────────────────────

describe("two-step sign-in", () => {
  it("opens no session when a password alone is presented to an enrolled account", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    await enrol(user);

    const res = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.twoFactorRequired).toBe(true);
    expect(body.challenge).toEqual(expect.any(String));
    // The whole architecture in one assertion: no session id, so no token the
    // web could mint that the api would honour.
    expect(body.sessionId).toBeUndefined();
  });

  it("still signs an un-enrolled account straight in", async () => {
    app = await buildAuthApp();
    const user = await seedUser();

    const res = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessionId).toEqual(expect.any(String));
    expect(res.json().twoFactorRequired).toBeUndefined();
  });

  it("opens no session on a probe, which is what the login form sends first", async () => {
    app = await buildAuthApp();
    const user = await seedUser();

    const res = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD, probe: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().twoFactorRequired).toBe(false);
    expect(res.json().sessionId).toBeUndefined();
    const rows = await t.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it("leaves one session behind for the two calls a sign-in without a code makes", async () => {
    app = await buildAuthApp();
    const user = await seedUser();

    // Exactly what the browser does: the form probes, then Auth.js signs in
    // through the same route. Before the probe flag both calls completed, and
    // the account was left holding a device it had never signed in from.
    await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD, probe: true },
    });
    const real = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });

    expect(real.json().sessionId).toEqual(expect.any(String));
    const rows = await t.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(real.json().sessionId);
  });

  it("still asks an enrolled account for a code when probed", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    await enrol(user);

    const res = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD, probe: true },
    });

    expect(res.json().twoFactorRequired).toBe(true);
    expect(res.json().challenge).toEqual(expect.any(String));
  });

  it("completes on a correct code", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    const { secret } = await enrol(user);

    const first = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    const code = totpCodeAtStep(secret, totpStepAt() + 1)!;

    const second = await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge: first.json().challenge, code },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().sessionId).toEqual(expect.any(String));
    expect(second.json().user.email).toBe(user.email);
  });

  it("says the same thing for a wrong code, a spent challenge and an invented one", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    await enrol(user);
    const first = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    const challenge = first.json().challenge;

    const wrongCode = await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge, code: "000000" },
    });
    const spent = await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge, code: "000000" },
    });
    const invented = await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge: "not-a-real-challenge", code: "000000" },
    });

    for (const res of [wrongCode, spent, invented]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe("Invalid email or password");
    }
  });

  it("burns the challenge on a wrong code, so codes cannot be guessed against one password", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    const { secret } = await enrol(user);
    const first = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    const challenge = first.json().challenge;

    await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge, code: "000000" },
    });
    // Now the RIGHT code, on the same challenge.
    const retry = await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge, code: totpCodeAtStep(secret, totpStepAt() + 1)! },
    });
    expect(retry.statusCode).toBe(401);
  });

  it("counts failed codes into the SAME lockout as failed passwords", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    await enrol(user);

    // Three wrong passwords, then two wrong codes: five failures on one
    // address. A separate code counter would have let this run to ten.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/auth/sign-in",
        payload: { email: user.email, password: "wrong" },
      });
    }
    for (let i = 0; i < 2; i++) {
      const first = await app.inject({
        method: "POST",
        url: "/auth/sign-in",
        payload: { email: user.email, password: PASSWORD },
      });
      await app.inject({
        method: "POST",
        url: "/auth/2fa/verify",
        payload: { challenge: first.json().challenge, code: "000000" },
      });
    }

    const locked = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(locked.statusCode).toBe(423);
  });

  it("does not clear the counter on a correct password alone", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    await enrol(user);

    // Four wrong passwords — one slip from the wall.
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: "POST",
        url: "/auth/sign-in",
        payload: { email: user.email, password: "wrong" },
      });
    }

    // A correct password must NOT clear it: the sign-in has not happened yet.
    // This is the hole that the clear used to leave — an attacker holding a
    // correct password reset the counter on every attempt, so five wrong codes
    // could never accumulate against exactly the person it most needs to stop.
    const first = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge: first.json().challenge, code: "000000" },
    });

    const locked = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(locked.statusCode).toBe(423);
  });

  it("clears the counter once both factors have passed", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    const { secret } = await enrol(user);

    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: "POST",
        url: "/auth/sign-in",
        payload: { email: user.email, password: "wrong" },
      });
    }
    expect(await t.db.select().from(loginAttempts)).toHaveLength(1);

    const first = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    const done = await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: {
        challenge: first.json().challenge,
        code: totpCodeAtStep(secret, totpStepAt() + 1)!,
      },
    });
    expect(done.statusCode).toBe(200);

    // The other half of the contract: somebody who mistyped four times is not
    // left one slip from a lockout for the rest of the window.
    expect(await t.db.select().from(loginAttempts)).toHaveLength(0);
  });

  it("writes signin.succeeded only after the code, and signin.failed for a wrong one", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    const { secret } = await enrol(user);

    const actions = async () =>
      (
        await t.db.execute<{ action: string; note: string | null }>(
          sql`select action, note from audit_events order by occurred_at`,
        )
      ).rows;

    // Phase 1 alone writes nothing. `signin.succeeded` about a sign-in that has
    // not happened would be a lie, and the catalog has no half-way event.
    const first = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    expect((await actions()).map((r) => r.action)).not.toContain("signin.succeeded");

    // A wrong code is a failed sign-in, attributed to the account. A run of
    // these means somebody is holding a correct password — which reads very
    // differently from a run of "wrong password", so the note says which.
    await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge: first.json().challenge, code: "000000" },
    });
    const afterWrong = await actions();
    expect(afterWrong.map((r) => r.action)).toContain("signin.failed");
    expect(afterWrong.find((r) => r.action === "signin.failed")?.note).toBe(
      "wrong two-factor code",
    );

    // And the whole thing, done properly.
    const second = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: {
        challenge: second.json().challenge,
        code: totpCodeAtStep(secret, totpStepAt() + 1)!,
      },
    });
    expect((await actions()).map((r) => r.action)).toContain("signin.succeeded");
  });

  it("stamps first_signin_at once and never moves it", async () => {
    app = await buildAuthApp();
    const user = await seedUser({ createdBySetup: true });

    await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    const firstStamp = (await reload(user.id)).firstSignInAt;
    expect(firstStamp).toBeInstanceOf(Date);

    await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: user.email, password: PASSWORD },
    });
    const after = await reload(user.id);
    // The grace period's start must survive every later sign-in.
    expect(after.firstSignInAt!.getTime()).toBe(firstStamp!.getTime());
    expect(after.lastSignInAt!.getTime()).toBeGreaterThanOrEqual(firstStamp!.getTime());
  });
});

// ── Enrolment over HTTP, and the admin reset ────────────────────────────────

describe("enrolment and reset over HTTP", () => {
  it("offers a secret once and turns 2FA on when a code proves it", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    const token = await tokenFor(user);
    const auth = { authorization: `Bearer ${token}` };

    const begin = await app.inject({
      method: "POST",
      url: "/api/account/2fa/begin",
      headers: auth,
    });
    expect(begin.statusCode).toBe(200);
    const { secret, qrSvg } = begin.json();
    expect(qrSvg).toContain("<svg");

    const confirm = await app.inject({
      method: "POST",
      url: "/api/account/2fa/confirm",
      headers: auth,
      payload: { code: totpCodeAtStep(secret, totpStepAt())! },
    });
    expect(confirm.statusCode).toBe(200);
    expect(isEnrolled(await reload(user.id))).toBe(true);
  });

  it("never hands the secret back afterwards", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    const { secret } = await enrol(user);
    const token = await tokenFor(await reload(user.id));

    const me = await app.inject({
      method: "GET",
      url: "/api/account/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(JSON.stringify(me.json())).not.toContain(secret);
    expect(me.json().twoFactor).toMatchObject({ enrolled: true, enrolmentRequired: false });
  });

  it("refuses self re-enrolment — an admin reset is the only way back", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    await enrol(user);
    const token = await tokenFor(await reload(user.id));

    const begin = await app.inject({
      method: "POST",
      url: "/api/account/2fa/begin",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(begin.statusCode).toBe(409);
  });

  it("lets an admin clear someone's authenticator and ends their sessions", async () => {
    app = await buildAuthApp();
    const admin = await seedUser({ role: "admin", email: `admin+${++seq}@example.com` });
    await enrol(admin);
    const member = await seedUser();
    await enrol(member);
    // A session and a challenge, both of which must not survive the reset.
    const memberSession = await createSession(t.db, {
      userId: member.id,
      authMethod: "password+totp",
      client: { ip: "84.229.11.6", userAgent: "Chrome/141" },
    });
    const stale = await issueChallenge(t.db, member.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/team/members/${member.id}/2fa/reset`,
      headers: { authorization: `Bearer ${await tokenFor(await reload(admin.id))}` },
    });
    expect(res.statusCode).toBe(200);

    const after = await reload(member.id);
    expect(after.totpSecret).toBeNull();
    expect(after.totpEnrolledAt).toBeNull();
    expect(after.totpLastStep).toBeNull();
    expect(await consumeChallenge(t.db, stale.token)).toEqual({ ok: false, reason: "used" });

    const probe = await app.inject({
      method: "GET",
      url: "/api/account/me",
      headers: { authorization: `Bearer ${await mint({ sub: member.id, sid: memberSession.id })}` },
    });
    expect(probe.statusCode).toBe(401);
  });

  it("refuses a non-admin the reset", async () => {
    app = await buildAuthApp();
    const approver = await seedUser({ role: "approver" });
    await enrol(approver);
    const member = await seedUser();
    await enrol(member);

    const res = await app.inject({
      method: "POST",
      url: `/api/team/members/${member.id}/2fa/reset`,
      headers: { authorization: `Bearer ${await tokenFor(await reload(approver.id))}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("says so rather than silently succeeding when there is nothing to reset", async () => {
    app = await buildAuthApp();
    const admin = await seedUser({ role: "admin" });
    await enrol(admin);
    const member = await seedUser();

    const res = await app.inject({
      method: "POST",
      url: `/api/team/members/${member.id}/2fa/reset`,
      headers: { authorization: `Bearer ${await tokenFor(await reload(admin.id))}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it("leaves the member able to enrol again, from a secret nobody else has seen", async () => {
    const user = await seedUser();
    const { secret: old } = await enrol(user);
    await clearEnrolment(t.db, user.id);
    const { secret: fresh } = await enrol(await reload(user.id));
    expect(fresh).not.toBe(old);
  });
});

// ── The must-enrol gate ─────────────────────────────────────────────────────

describe("the gate", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** Any authenticated route that is not part of the enrolment escape hatch. */
  const BLOCKED = "/api/account/sessions";

  it("shuts the dashboard to an invited person who has not enrolled", async () => {
    app = await buildAuthApp();
    const user = await seedUser();

    const res = await app.inject({
      method: "GET",
      url: BLOCKED,
      headers: { authorization: `Bearer ${await tokenFor(user)}` },
    });
    expect(res.statusCode).toBe(403);
    // Distinct from FORBIDDEN: the web has somewhere to send this person, and
    // bouncing them to the login page would be a dead end — their password is
    // fine and signing in again changes nothing.
    expect(res.json().code).toBe("TWO_FACTOR_REQUIRED");
  });

  it("leaves exactly the enrolment path open", async () => {
    app = await buildAuthApp();
    const user = await seedUser();
    const auth = { authorization: `Bearer ${await tokenFor(user)}` };

    const me = await app.inject({ method: "GET", url: "/api/account/me", headers: auth });
    expect(me.statusCode).toBe(200);
    expect(me.json().twoFactor.enrolmentRequired).toBe(true);

    const begin = await app.inject({
      method: "POST",
      url: "/api/account/2fa/begin",
      headers: auth,
    });
    expect(begin.statusCode).toBe(200);

    const confirm = await app.inject({
      method: "POST",
      url: "/api/account/2fa/confirm",
      headers: auth,
      payload: { code: totpCodeAtStep(begin.json().secret, totpStepAt())! },
    });
    expect(confirm.statusCode).toBe(200);

    // And the dashboard opens the moment enrolment lands — no new sign-in.
    const after = await app.inject({ method: "GET", url: BLOCKED, headers: auth });
    expect(after.statusCode).toBe(200);
  });

  it("lets the first admin through during their grace period", async () => {
    app = await buildAuthApp();
    const admin = await seedUser({
      role: "admin",
      createdBySetup: true,
      firstSignInAt: new Date(Date.now() - 18 * DAY),
    });

    const res = await app.inject({
      method: "GET",
      url: BLOCKED,
      headers: { authorization: `Bearer ${await tokenFor(admin)}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("shuts it on the first admin once thirty days are up", async () => {
    app = await buildAuthApp();
    const admin = await seedUser({
      role: "admin",
      createdBySetup: true,
      firstSignInAt: new Date(Date.now() - GRACE_PERIOD_MS - 1000),
    });

    const res = await app.inject({
      method: "GET",
      url: BLOCKED,
      headers: { authorization: `Bearer ${await tokenFor(admin)}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("TWO_FACTOR_REQUIRED");
  });

  it("gives an ordinary admin no grace at all — it is the first admin's alone", async () => {
    app = await buildAuthApp();
    // Same role, same age of account. The difference is createdBySetup.
    const admin = await seedUser({
      role: "admin",
      createdBySetup: false,
      firstSignInAt: new Date(Date.now() - DAY),
    });

    const res = await app.inject({
      method: "GET",
      url: BLOCKED,
      headers: { authorization: `Bearer ${await tokenFor(admin)}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("still 401s an unauthenticated caller rather than 403", async () => {
    app = await buildAuthApp();
    // The gate must not turn "who are you" into "set up 2FA" — that would leak
    // that the endpoint exists behind a valid session.
    const res = await app.inject({ method: "GET", url: BLOCKED });
    expect(res.statusCode).toBe(401);
  });
});

// ── The invite trigger ──────────────────────────────────────────────────────

describe("the invite trigger", () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function graceAdmin(): Promise<User> {
    return seedUser({
      role: "admin",
      createdBySetup: true,
      firstSignInAt: new Date(Date.now() - 3 * DAY),
    });
  }

  it("refuses an invite from an admin who is still deferring", async () => {
    app = await buildAuthApp();
    const admin = await graceAdmin();

    const res = await app.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: { authorization: `Bearer ${await tokenFor(admin)}` },
      payload: { email: "new@example.com", role: "requester" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("TWO_FACTOR_REQUIRED");
  });

  it("allows it the moment they enrol — no re-sign-in", async () => {
    app = await buildAuthApp();
    const admin = await graceAdmin();
    const token = await tokenFor(admin);
    await enrol(admin);

    const res = await app.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "new@example.com", role: "requester" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("blocks resend too, so 'invite, fail, resend' is not a way around it", async () => {
    app = await buildAuthApp();
    // An enrolled admin creates the invitation…
    const enroller = await seedUser({ role: "admin" });
    await enrol(enroller);
    const created = await app.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: { authorization: `Bearer ${await tokenFor(await reload(enroller.id))}` },
      payload: { email: "pending@example.com", role: "requester" },
    });
    expect(created.statusCode).toBe(201);

    // …and a deferring admin tries to send it again.
    const deferring = await graceAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/api/team/invites/${created.json().invite.id}/resend`,
      headers: { authorization: `Bearer ${await tokenFor(deferring)}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("leaves reading the member list alone — the block is on granting access", async () => {
    app = await buildAuthApp();
    const admin = await graceAdmin();

    const res = await app.inject({
      method: "GET",
      url: "/api/team/members",
      headers: { authorization: `Bearer ${await tokenFor(admin)}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── The wiring, end to end from a fresh install ─────────────────────────────

describe("the first admin, from /auth/setup onwards", () => {
  /**
   * The grace period tested through the routes that actually create and sign in
   * the account, rather than against a fixture with the columns set by hand.
   *
   * This is the gap that hand-set fixtures leave: `twoFactorStatus` was right
   * and `completeSetup` was not writing `created_by_setup` at all, so every
   * policy test passed while the deployment's first admin would have been
   * refused the dashboard on their first sign-in — the exact person the grace
   * period exists for.
   */
  it("is marked by setup, gets a countdown, and is blocked from inviting", async () => {
    setEnv({
      SETUP_TOKEN: "installer-printed-this",
      DEPLOYMENT_MODE: "onprem",
      // The route validates the password, and this fixture's is famously
      // breached. Off, so the test fails for a two-factor reason or not at all.
      PASSWORD_BREACH_CHECK: "off",
    });
    resetSetupTokenForTests();
    app = await buildAuthApp();

    const created = await app.inject({
      method: "POST",
      url: "/auth/setup",
      payload: {
        token: "installer-printed-this",
        email: "ops@example.com",
        password: PASSWORD,
        name: "Ops",
      },
    });
    expect(created.statusCode).toBe(201);

    // Setup opens no session; the clock starts at the sign-in that follows.
    const signedIn = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: "ops@example.com", password: PASSWORD },
    });
    expect(signedIn.statusCode).toBe(200);
    const token = await mint({
      sub: signedIn.json().user.id,
      sid: signedIn.json().sessionId,
      role: "admin",
    });
    const auth = { authorization: `Bearer ${token}` };

    // The dashboard opens, with a countdown.
    const me = await app.inject({ method: "GET", url: "/api/account/me", headers: auth });
    expect(me.json().twoFactor).toMatchObject({ enrolled: false, enrolmentRequired: false });
    expect(me.json().twoFactor.daysLeft).toBe(30);
    expect(
      (await app.inject({ method: "GET", url: "/api/account/sessions", headers: auth })).statusCode,
    ).toBe(200);

    // But inviting is not allowed — the moment they hand somebody else access,
    // the countdown is over.
    const invite = await app.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: auth,
      payload: { email: "dana@example.com", role: "requester" },
    });
    expect(invite.statusCode).toBe(403);
    expect(invite.json().code).toBe("TWO_FACTOR_REQUIRED");

    // Enrol, and it opens.
    const begin = await app.inject({
      method: "POST",
      url: "/api/account/2fa/begin",
      headers: auth,
    });
    await app.inject({
      method: "POST",
      url: "/api/account/2fa/confirm",
      headers: auth,
      payload: { code: totpCodeAtStep(begin.json().secret, totpStepAt())! },
    });
    const invited = await app.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: auth,
      payload: { email: "dana@example.com", role: "requester" },
    });
    expect(invited.statusCode).toBe(201);
  });

  it("gives an invited person no grace — they enrol before the dashboard opens", async () => {
    setEnv({
      SETUP_TOKEN: "installer-printed-this",
      DEPLOYMENT_MODE: "onprem",
      // The route validates the password, and this fixture's is famously
      // breached. Off, so the test fails for a two-factor reason or not at all.
      PASSWORD_BREACH_CHECK: "off",
    });
    resetSetupTokenForTests();
    app = await buildAuthApp();

    // Redeemed accounts must not inherit the marker. If they did, every person
    // who ever joined would arrive with thirty days of their own.
    const invited = await seedUser();
    expect(invited.createdBySetup).toBe(false);

    const res = await app.inject({
      method: "GET",
      url: "/api/account/sessions",
      headers: { authorization: `Bearer ${await tokenFor(invited)}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
