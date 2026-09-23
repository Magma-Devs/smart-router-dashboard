import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
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

/** 297 characters: valid as an address, too long for a `varchar(255)` column. */
const TOO_LONG =
  "a".repeat(60) + "." + "b".repeat(60) + "@" + ["c", "d", "e", "f"].map((x) => x.repeat(40)).join(".") + ".example.com";

async function lockOut(email: string): Promise<void> {
  for (let i = 0; i < LOCKOUT_MAX_FAILURES; i++) await signIn(email, "wrong-password-every-time");
}

describe("sign-in", () => {
  it("refuses an over-long address at the schema, rather than 500ing on the lockout's INSERT", async () => {
    // The lockout records any address submitted, and every email column is
    // varchar(255): a 297-character address reached the INSERT and came back
    // as a 500 on the most public route there is.
    expect(TOO_LONG.length).toBeGreaterThan(255);
    const res = await signIn(TOO_LONG, "whatever");
    expect(res.statusCode).toBe(400);
  });

  it("spends a bcrypt on an address with no account, so timing cannot tell them apart", async () => {
    // A real account cost one bcrypt (~380 ms) and a stranger none (~8 ms): a
    // gap that answers "is this person a member?" as surely as a different
    // status would. Asserted on the call, not the clock — the clock flakes.
    const compare = vi.spyOn(bcrypt, "compare");
    await signIn("nobody@example.com", "whatever");
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });
});

describe("sign-in lockout", () => {
  it("answers 423 once tripped, and says when it lifts", async () => {
    await member("dana@example.com");
    await lockOut("dana@example.com");

    const res = await signIn("dana@example.com", OLD_PASSWORD);
    expect(res.statusCode).toBe(423);
    // `until` exists for exactly this: telling the person when.
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.json().message).toMatch(/Try again in \d+ minutes?/);
  });

  it("lets the owner straight back in after a completed reset", async () => {
    // End to end: locked out, handed a reset link, sets a new password — and
    // is let straight in with it, because the reset clears the lock.
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
  it("is limited like sign-in per address, because it tests a credential too", async () => {
    // One guess per member, all from one address: the per-account budget never
    // fires, so what stops the eleventh is the per-IP limit alone. One shared
    // hash, because eleven bcrypt hashes at cost 12 outrun the test timeout.
    const passwordHash = await hashPassword(OLD_PASSWORD);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const [who] = await t.db
        .insert(users)
        .values({ email: `member-${i}@example.com`, passwordHash })
        .returning();
      const res = await app!.inject({
        method: "POST",
        url: "/api/account/password",
        headers: { authorization: `Bearer ${await bearer(who!)}` },
        payload: { current: "a-guess-at-the-current", next: NEW_PASSWORD },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("audits the address THIS request came from, not the one the session opened at", async () => {
    // The request's address and the session's sign-in address differ exactly
    // when a session is used from somewhere else — a stolen token, say.
    const dana = await member("dana@example.com");
    const token = await bearer(dana);
    const debug = vi.spyOn(app!.log, "debug");

    const res = await app!.inject({
      method: "POST",
      url: "/api/account/password",
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: "203.0.113.9",
      payload: { current: OLD_PASSWORD, next: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(200);

    const event = debug.mock.calls
      .map((c) => (c[0] as { audit?: { action: string; access?: { ip: string | null } } }).audit)
      .find((a) => a?.action === "password.changed");
    expect(event?.access?.ip).toBe("203.0.113.9");
    debug.mockRestore();
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
  // There is no way to deliver a link (email is MAG-2870), so it fails closed:
  // the same answer on every deployment and for every address, and nothing
  // written — issuing a link nobody receives would also kill any live one.
  const forgot = (email: string) =>
    app!.inject({ method: "POST", url: "/auth/password/forgot", payload: { email } });

  it.each(["onprem", "managed"])("answers 404 on %s, member or stranger alike", async (mode) => {
    setEnv({ DEPLOYMENT_MODE: mode });
    await member("dana@example.com");
    const known = await forgot("dana@example.com");
    const unknown = await forgot("nobody@example.com");
    expect(known.statusCode).toBe(404);
    expect(known.json()).toEqual(unknown.json());
    expect(await t.db.select().from(passwordResets)).toHaveLength(0);
  });

  it("leaves a member's live admin-issued link working", async () => {
    setEnv({ DEPLOYMENT_MODE: "managed" });
    const admin = await member("admin@example.com", { role: "admin" });
    const dana = await member("dana@example.com");
    const link = await app!.inject({
      method: "POST",
      url: `/api/team/members/${dana.id}/reset-link`,
      headers: { authorization: `Bearer ${await bearer(admin)}` },
    });
    const token = (link.json().url as string).split("/reset/")[1]!;

    await forgot("dana@example.com");

    const reset = await app!.inject({
      method: "POST",
      url: "/auth/password/reset",
      payload: { token, password: NEW_PASSWORD },
    });
    expect(reset.statusCode).toBe(200);
  });
});

describe("the per-account budget", () => {
  it("holds against a parallel burst from many addresses", async () => {
    // Counted before bcrypt, so the burst cannot all pass a read-then-check.
    await member("dana@example.com");
    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        app!.inject({
          method: "POST",
          url: "/auth/sign-in",
          remoteAddress: `198.51.100.${i + 1}`,
          payload: { email: "dana@example.com", password: `guess-${i}` },
        }),
      ),
    );
    const codes = res.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(LOCKOUT_MAX_FAILURES);
    expect(codes.filter((c) => c === 423)).toHaveLength(10 - LOCKOUT_MAX_FAILURES);
  });

  it("covers the current-password check, whatever address the guesses come from", async () => {
    // A spoofed X-Forwarded-For sidesteps the per-IP limit; the account's
    // budget is keyed on the identity, so it does not.
    const dana = await member("dana@example.com");
    const token = await bearer(dana);
    const codes: number[] = [];
    for (let i = 0; i <= LOCKOUT_MAX_FAILURES; i++) {
      const res = await app!.inject({
        method: "POST",
        url: "/api/account/password",
        headers: { authorization: `Bearer ${token}`, "x-forwarded-for": `198.51.100.${i + 1}` },
        payload: { current: `guess-${i}`, next: NEW_PASSWORD },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, LOCKOUT_MAX_FAILURES).every((c) => c === 401)).toBe(true);
    expect(codes[LOCKOUT_MAX_FAILURES]).toBe(423);
  });

  it("audits a refused sign-in with the account and how many attempts", async () => {
    // "who, how many attempts, IP" — what MAG-2729 asks signin.blocked to carry.
    const dana = await member("dana@example.com");
    await lockOut("dana@example.com");
    const debug = vi.spyOn(app!.log, "debug");
    await signIn("dana@example.com", OLD_PASSWORD);
    const event = debug.mock.calls
      .map((c) => (c[0] as { audit?: { action: string; target?: { id: string }; note?: string } }).audit)
      .find((a) => a?.action === "signin.blocked");
    expect(event?.target?.id).toBe(dana.id);
    expect(event?.note).toMatch(/^6 attempts on dana@example\.com/);
    debug.mockRestore();
  });
});

describe("POST /auth/password/reset", () => {
  it("records who generated the link it redeemed", async () => {
    // The link is a bearer credential, so who USED it is unknowable; who issued
    // it is what connects an admin-generated link to its redemption.
    const admin = await member("admin@example.com", { role: "admin" });
    const dana = await member("dana@example.com");
    const link = await app!.inject({
      method: "POST",
      url: `/api/team/members/${dana.id}/reset-link`,
      headers: { authorization: `Bearer ${await bearer(admin)}` },
    });
    const token = (link.json().url as string).split("/reset/")[1]!;
    const debug = vi.spyOn(app!.log, "debug");
    await app!.inject({ method: "POST", url: "/auth/password/reset", payload: { token, password: NEW_PASSWORD } });
    const event = debug.mock.calls
      .map((c) => (c[0] as { audit?: { action: string; note?: string } }).audit)
      .find((a) => a?.action === "password.reset_completed");
    expect(event?.note).toContain(admin.id);
    debug.mockRestore();
  });
});

describe("/api/account/sessions", () => {
  async function sessionFor(user: User, ip: string) {
    const [row] = await t.db
      .insert(sessions)
      .values({ userId: user.id, expiresAt: new Date(Date.now() + 3_600_000), authMethod: "password", ip })
      .returning();
    return row!;
  }

  it("lists only your own live sessions, marking the one you're on", async () => {
    const dana = await member("dana@example.com");
    const other = await member("other@example.com");
    await sessionFor(dana, "10.0.0.2");
    await sessionFor(other, "10.0.0.9");
    const token = await bearer(dana);

    const res = await app!.inject({
      method: "GET",
      url: "/api/account/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().sessions as Array<{ ip: string | null; current: boolean }>;
    expect(list).toHaveLength(2);
    expect(list.filter((x) => x.current)).toHaveLength(1);
    expect(list.map((x) => x.ip)).not.toContain("10.0.0.9");
  });

  it("signs out one of your own devices", async () => {
    const dana = await member("dana@example.com");
    const laptop = await sessionFor(dana, "10.0.0.2");
    const res = await app!.inject({
      method: "DELETE",
      url: `/api/account/sessions/${laptop.id}`,
      headers: { authorization: `Bearer ${await bearer(dana)}` },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await t.db.select().from(sessions).where(eq(sessions.id, laptop.id));
    expect(row?.revokedAt).not.toBeNull();
  });

  it("refuses to sign out someone else's device, and says nothing about it existing", async () => {
    const dana = await member("dana@example.com");
    const other = await member("other@example.com");
    const theirs = await sessionFor(other, "10.0.0.9");
    const res = await app!.inject({
      method: "DELETE",
      url: `/api/account/sessions/${theirs.id}`,
      headers: { authorization: `Bearer ${await bearer(dana)}` },
    });
    expect(res.statusCode).toBe(404);
    const [row] = await t.db.select().from(sessions).where(eq(sessions.id, theirs.id));
    expect(row?.revokedAt).toBeNull();
  });

  it("signs out everywhere, this device included", async () => {
    const dana = await member("dana@example.com");
    await sessionFor(dana, "10.0.0.2");
    const token = await bearer(dana);
    const res = await app!.inject({
      method: "DELETE",
      url: "/api/account/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked).toBe(2);
    const after = await app!.inject({
      method: "GET",
      url: "/api/account/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });
});
