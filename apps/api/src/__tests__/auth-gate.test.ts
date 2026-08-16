import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { users, type User } from "@sr/db";
import type { Role } from "@sr/shared";
import { buildApp } from "../app.js";
import { requireRole, SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession, revokeSession } from "../services/sessions.js";
import { hashPassword } from "../services/password.js";

/**
 * The request gate, end to end, against a real database.
 *
 * `auth.test.ts` covers the signature/issuer/audience checks with no database.
 * These are the ones that need rows: a token is only as good as the session it
 * addresses and the account behind it, and every case below is a line on the
 * ticket's "done when".
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
const INTERNAL = "internal-secret-for-tests";
// Unroutable per RFC 5737 — the lazy connect loop fails fast and we swap in
// pglite by hand, so nothing waits on a real Postgres.
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

/** An enabled app wired to the in-process Postgres, plus a role-gated fixture
 *  route so `requireRole` is exercised through the real hook rather than in a
 *  vacuum. */
async function buildGatedApp(): Promise<FastifyInstance> {
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    INTERNAL_AUTH_SECRET: INTERNAL,
  });
  const instance = await buildApp();
  instance.db = t.db;
  instance.get("/api/_fixture/admin-only", (request, reply) => {
    const authUser = requireRole(request, reply, "admin");
    if (!authUser) return reply;
    return { role: authUser.role };
  });
  return instance;
}

/** Distinct address per call — the partial unique index means two active
 *  accounts can't share one, which is the point of it. */
let seq = 0;
async function seedUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<User> {
  const [created] = await t.db
    .insert(users)
    .values({
      email: `dana+${++seq}@example.com`,
      name: "Dana Levi",
      role: "read_only",
      ...overrides,
    })
    .returning();
  return created!;
}

async function mint(opts: { sub: string; sid: string; role?: Role; iat?: number }): Promise<string> {
  const jwt = new SignJWT({ sub: opts.sub, email: "dana@example.com", role: opts.role ?? "read_only", sid: opts.sid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setExpirationTime("1h");
  jwt.setIssuedAt(opts.iat);
  return jwt.sign(new TextEncoder().encode(SECRET));
}

async function signedInUser(role: Role = "read_only") {
  const user = await seedUser({ role });
  const session = await createSession(t.db, {
    userId: user.id,
    authMethod: "password",
    client: { ip: "84.229.11.6", userAgent: "Chrome/141.0.0.0 Safari/537.36 (Macintosh)" },
  });
  const token = await mint({ sub: user.id, sid: session.id, role });
  return { user, session, token };
}

const get = (token: string, url = "/api/metrics/specs") =>
  app!.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("the gate, with a live database", () => {
  it("admits a request whose session resolves", async () => {
    app = await buildGatedApp();
    const { token } = await signedInUser();
    expect((await get(token)).statusCode).not.toBe(401);
  });

  it("refuses the very next request after the session is revoked", async () => {
    app = await buildGatedApp();
    const { token, session } = await signedInUser();
    expect((await get(token)).statusCode).not.toBe(401);

    await revokeSession(t.db, session.id, { reason: "self" });

    const after = await get(token);
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe("SESSION_INVALID");
  });

  it("cuts a removed person off immediately, and says why", async () => {
    app = await buildGatedApp();
    const { token, user } = await signedInUser();
    await t.db.update(users).set({ status: "removed" }).where(eq(users.id, user.id));

    const res = await get(token);
    expect(res.statusCode).toBe(403);
    // Not 401: signing in again will not help, and saying so beats a login loop.
    expect(res.json().code).toBe("ACCOUNT_INACTIVE");
  });

  it("refuses a session id that resolves to nothing", async () => {
    app = await buildGatedApp();
    const user = await seedUser();
    const token = await mint({ sub: user.id, sid: "00000000-0000-4000-8000-00000000dead" });
    expect((await get(token)).statusCode).toBe(401);
  });

  it("keeps /health public even with auth on", async () => {
    app = await buildGatedApp();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("role enforcement reads the live row", () => {
  it("admits an admin", async () => {
    app = await buildGatedApp();
    const { token } = await signedInUser("admin");
    const res = await get(token, "/api/_fixture/admin-only");
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("admin");
  });

  it("refuses a role below the bar", async () => {
    app = await buildGatedApp();
    const { token } = await signedInUser("approver");
    const res = await get(token, "/api/_fixture/admin-only");
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });

  it("applies a demotion to the session already in flight", async () => {
    // The ticket: "Demoting someone has to take effect straight away, not at
    // their next sign-in." The token still says admin; the row no longer does.
    app = await buildGatedApp();
    const { token, user } = await signedInUser("admin");
    expect((await get(token, "/api/_fixture/admin-only")).statusCode).toBe(200);

    await t.db.update(users).set({ role: "requester" }).where(eq(users.id, user.id));

    const after = await get(token, "/api/_fixture/admin-only");
    expect(after.statusCode).toBe(403);
  });

  it("does not let a forged role claim promote anyone", async () => {
    app = await buildGatedApp();
    const user = await seedUser({ role: "read_only" });
    const session = await createSession(t.db, {
      userId: user.id,
      authMethod: "password",
      client: { ip: null, userAgent: null },
    });
    // Correctly signed, but claiming a role the row doesn't have.
    const token = await mint({ sub: user.id, sid: session.id, role: "admin" });
    expect((await get(token, "/api/_fixture/admin-only")).statusCode).toBe(403);
  });
});

describe("POST /auth/sign-in", () => {
  const signIn = (payload: unknown, headers: Record<string, string> = {}) =>
    app!.inject({ method: "POST", url: "/auth/sign-in", payload: payload as object, headers });

  beforeEach(async () => {
    app = await buildGatedApp();
    await seedUser({
      email: "dana@example.com",
      passwordHash: await hashPassword("correct horse battery staple"),
    });
  });

  it("opens a session and returns its id", async () => {
    const res = await signIn({ email: "dana@example.com", password: "correct horse battery staple" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toEqual(expect.any(String));
    expect(body.user.role).toBe("read_only");

    // The id must address a session the gate will then accept.
    const token = await mint({ sub: body.user.id, sid: body.sessionId });
    expect((await get(token)).statusCode).not.toBe(401);
  });

  it("answers identically for a wrong password and an unknown address", async () => {
    const wrong = await signIn({ email: "dana@example.com", password: "nope" });
    const unknown = await signIn({ email: "ghost@example.com", password: "nope" });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("refuses a removed account without resurrecting it", async () => {
    await t.db.update(users).set({ status: "removed" }).where(eq(users.email, "dana@example.com"));
    const res = await signIn({ email: "dana@example.com", password: "correct horse battery staple" });
    expect(res.statusCode).toBe(401);
  });

  describe("forwarded client context", () => {
    const credentials = {
      email: "dana@example.com",
      password: "correct horse battery staple",
      clientContext: { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Windows NT 10.0) Firefox/131.0" },
    };

    it("is recorded when the caller proves it is our web tier", async () => {
      const res = await signIn(credentials, { "x-internal-auth": INTERNAL });
      expect(res.statusCode).toBe(200);

      const [row] = await t.db.query.sessions.findMany({ limit: 1 });
      expect(row?.ip).toBe("203.0.113.7");
      expect(row?.client).toBe("Firefox 131 / Windows");
    });

    it("is ignored without the internal secret, so nobody can forge an audit trail", async () => {
      // The route is publicly reachable. Without this, an attacker could pin
      // any address to their own sign-in attempts.
      const res = await signIn(credentials);
      expect(res.statusCode).toBe(200);

      const [row] = await t.db.query.sessions.findMany({ limit: 1 });
      expect(row?.ip).not.toBe("203.0.113.7");
    });

    it("is ignored when the secret is wrong", async () => {
      const res = await signIn(credentials, { "x-internal-auth": "not-the-secret" });
      expect(res.statusCode).toBe(200);

      const [row] = await t.db.query.sessions.findMany({ limit: 1 });
      expect(row?.ip).not.toBe("203.0.113.7");
    });
  });
});

describe("POST /auth/sign-out", () => {
  it("revokes the calling session and nothing else", async () => {
    app = await buildGatedApp();
    const { token } = await signedInUser();
    const other = await signedInUser();

    const res = await app.inject({
      method: "POST",
      url: "/auth/sign-out",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    expect((await get(token)).statusCode).toBe(401);
    expect((await get(other.token)).statusCode).not.toBe(401);
  });
});
