import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { sessions, users, type User } from "@sr/db";
import type { Role } from "@sr/shared";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";

/**
 * The member list over HTTP.
 *
 * `members.test.ts` covers the services. These pin what only the routes
 * decide: who may read the list and who may change it, what the export
 * actually contains, and that a role change or a removal lands on a session
 * the target already holds.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
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

async function member(email: string, role: Role, name?: string): Promise<User> {
  const [row] = await t.db.insert(users).values({ email, role, name }).returning();
  return row!;
}

/** A Bearer for a real session row, which the gate resolves on every request. */
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

const call = (
  method: "GET" | "PATCH" | "DELETE",
  url: string,
  token?: string,
  payload?: Record<string, unknown>,
) =>
  app!.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  });

beforeEach(async () => {
  t = await createTestDb();
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    PUBLIC_WEB_ORIGIN: "https://dash.example.com",
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

describe("GET /api/team/members", () => {
  it("is readable by every role, because the review is for everyone", async () => {
    await member("admin@example.com", "admin");
    const reader = await member("reader@example.com", "read_only");

    const res = await call("GET", "/api/team/members", await bearer(reader));

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members.map((m: { email: string }) => m.email)).toEqual([
      "admin@example.com",
      "reader@example.com",
    ]);
    expect(body.soleAdmin).toBe(true);
    expect(body.members[0].twoFactorEnabled).toBeNull();
  });

  it("needs a session at all", async () => {
    expect((await call("GET", "/api/team/members")).statusCode).toBe(401);
  });
});

describe("GET /api/team/members.csv", () => {
  it("exports the list with every formula lead neutralised", async () => {
    // Display names are chosen by the people in the list, and the file opens in
    // a spreadsheet by default.
    await member("admin@example.com", "admin", '=HYPERLINK("http://evil","x")');
    const reader = await member("reader@example.com", "read_only");

    const res = await call("GET", "/api/team/members.csv", await bearer(reader));

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["content-disposition"]).toContain("members.csv");
    // The UTF-8 byte-order mark reaches the wire, so Excel reads the file as
    // UTF-8 rather than the system code page.
    expect([...res.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [header, first] = res.body.slice(1).split("\r\n");
    expect(header).toBe("name,email,role,two_factor,last_active,joined,magma_account");
    expect(first!.startsWith(`"'=HYPERLINK(""http://evil"",""x"")",admin@example.com,admin,,`)).toBe(
      true,
    );
  });
});

describe("PATCH /api/team/members/:id", () => {
  it("lands on the session the target already holds", async () => {
    // Nothing is revoked, because nothing needs to be: the gate reads the role
    // from the row on every request.
    const admin = await member("admin@example.com", "admin");
    const dana = await member("dana@example.com", "admin");
    const danaToken = await bearer(dana);
    expect((await call("GET", "/api/team/invites", danaToken)).statusCode).toBe(200);

    const res = await call("PATCH", `/api/team/members/${dana.id}`, await bearer(admin), {
      role: "read_only",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().member.role).toBe("read_only");
    expect((await call("GET", "/api/team/invites", danaToken)).statusCode).toBe(403);
    expect((await call("GET", "/api/team/members", danaToken)).statusCode).toBe(200);
  });

  it("is admin-only", async () => {
    const approver = await member("approver@example.com", "approver");
    const dana = await member("dana@example.com", "read_only");
    const res = await call("PATCH", `/api/team/members/${dana.id}`, await bearer(approver), {
      role: "admin",
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses the caller's own row", async () => {
    const admin = await member("admin@example.com", "admin");
    const res = await call("PATCH", `/api/team/members/${admin.id}`, await bearer(admin), {
      role: "read_only",
    });
    expect(res.statusCode).toBe(409);
  });

  it("treats an upper-cased id as the same member", async () => {
    // Postgres compares uuids case-insensitively; the self check must too.
    const admin = await member("admin@example.com", "admin");
    const dana = await member("dana@example.com", "read_only");
    const token = await bearer(admin);

    const self = await call("PATCH", `/api/team/members/${admin.id.toUpperCase()}`, token, {
      role: "read_only",
    });
    expect(self.statusCode).toBe(409);

    const other = await call("PATCH", `/api/team/members/${dana.id.toUpperCase()}`, token, {
      role: "approver",
    });
    expect(other.statusCode).toBe(200);
  });

  it("refuses a role that doesn't exist, at the schema", async () => {
    const admin = await member("admin@example.com", "admin");
    const dana = await member("dana@example.com", "read_only");
    const res = await call("PATCH", `/api/team/members/${dana.id}`, await bearer(admin), {
      role: "owner",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/team/members/:id", () => {
  it("ends the target's open session on its very next request, and says why", async () => {
    const admin = await member("admin@example.com", "admin");
    const dana = await member("dana@example.com", "approver");
    const danaToken = await bearer(dana);
    expect((await call("GET", "/api/team/members", danaToken)).statusCode).toBe(200);

    const res = await call("DELETE", `/api/team/members/${dana.id}`, await bearer(admin));

    expect(res.statusCode).toBe(200);
    // Not "sign in again": removal revokes her sessions too, but signing in
    // again cannot help a removed person, and the code is what the web keys on.
    const after = await call("GET", "/api/team/members", danaToken);
    expect(after.statusCode).toBe(403);
    expect(after.json().code).toBe("ACCOUNT_INACTIVE");
  });

  it("is admin-only", async () => {
    const approver = await member("approver@example.com", "approver");
    const dana = await member("dana@example.com", "read_only");
    expect(
      (await call("DELETE", `/api/team/members/${dana.id}`, await bearer(approver))).statusCode,
    ).toBe(403);
  });

  it("refuses the caller's own row", async () => {
    const admin = await member("admin@example.com", "admin");
    expect((await call("DELETE", `/api/team/members/${admin.id}`, await bearer(admin))).statusCode).toBe(
      409,
    );
  });

  it("refuses an id in urn form at the schema, not with a 500 from Postgres", async () => {
    const admin = await member("admin@example.com", "admin");
    const dana = await member("dana@example.com", "read_only");
    const res = await call("DELETE", `/api/team/members/urn:uuid:${dana.id}`, await bearer(admin));
    expect(res.statusCode).toBe(400);
  });

  it("answers 404 for someone already removed", async () => {
    const admin = await member("admin@example.com", "admin");
    const dana = await member("dana@example.com", "read_only");
    const token = await bearer(admin);
    await call("DELETE", `/api/team/members/${dana.id}`, token);
    expect((await call("DELETE", `/api/team/members/${dana.id}`, token)).statusCode).toBe(404);
  });
});
