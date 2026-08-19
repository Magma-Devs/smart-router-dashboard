import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, type TestDb } from "@sr/db/testing";
import {
  AUDIT_TOKEN_PREFIX,
  createAuditWriter,
  hashAuditToken,
  mintAuditToken,
  resolveAuditToken,
  revokeAuditToken,
  users,
  type User,
} from "@sr/db";
import type { Role } from "@sr/shared";
import { buildApp } from "../app.js";
import { auditTokenMayReach, SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";

/**
 * The read-only audit token.
 *
 * The ticket's fourth non-negotiable, and the one DFNS's review actually turns
 * on: "handing a security team a token that also edits routing fails that
 * review". So most of what follows is about what the token *cannot* do.
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

async function buildAuthedApp(): Promise<FastifyInstance> {
  setEnv({ AUTH_MODE: "enabled", AUTH_SECRET: SECRET, DATABASE_URL: DEAD_DB });
  const instance = await buildApp();
  instance.db = t.db;
  return instance;
}

let seq = 0;
async function signedIn(role: Role = "admin"): Promise<{ user: User; token: string }> {
  const [user] = await t.db
    .insert(users)
    .values({ email: `a+${++seq}@example.com`, name: "Dana Levi", role })
    .returning();
  const session = await createSession(t.db, {
    userId: user!.id,
    authMethod: "password",
    client: { ip: "84.229.11.6", userAgent: "Chrome/141 (Macintosh)" },
  });
  const token = await new SignJWT({ sub: user!.id, email: user!.email, role, sid: session.id })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  return { user: user!, token };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("auditTokenMayReach", () => {
  /**
   * The read-only guarantee, as a pure function. Everything else in the gate
   * routes through this, so it is the one place the claim is decided.
   */
  it("allows only GETs under /api/audit", () => {
    expect(auditTokenMayReach("GET", "/api/audit/events")).toBe(true);
    expect(auditTokenMayReach("GET", "/api/audit/export.csv?group=config")).toBe(true);
    expect(auditTokenMayReach("HEAD", "/api/audit/events")).toBe(true);
  });

  it("refuses every write, on any path", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(auditTokenMayReach(method, "/api/audit/events"), method).toBe(false);
    }
  });

  it("refuses the rest of the product", () => {
    expect(auditTokenMayReach("GET", "/api/metrics/specs")).toBe(false);
    expect(auditTokenMayReach("GET", "/api/config/routers")).toBe(false);
    // Not fooled by a path that merely starts with the same letters.
    expect(auditTokenMayReach("GET", "/api/auditing-something")).toBe(false);
  });

  /** A token that could mint another token would be an escalation dressed as
   *  a read. */
  it("refuses token management even though it is under /api/audit", () => {
    expect(auditTokenMayReach("GET", "/api/audit/tokens")).toBe(false);
  });
});

describe("minting and resolving", () => {
  it("returns the secret once and stores only a hash", async () => {
    const minted = await mintAuditToken(t.db, {
      name: "DFNS SIEM",
      createdBy: null,
      createdByName: "Dana Levi",
    });
    expect(minted.secret.startsWith(AUDIT_TOKEN_PREFIX)).toBe(true);
    expect(minted.row.tokenHash).toBe(hashAuditToken(minted.secret));
    // The row must not carry anything that reconstructs the value.
    expect(JSON.stringify(minted.row)).not.toContain(
      minted.secret.slice(AUDIT_TOKEN_PREFIX.length),
    );
    expect(minted.row.suffix).toBe(minted.secret.slice(-4));
  });

  it("issues a different secret every time", async () => {
    const a = await mintAuditToken(t.db, { name: "a", createdBy: null, createdByName: "x" });
    const b = await mintAuditToken(t.db, { name: "b", createdBy: null, createdByName: "x" });
    expect(a.secret).not.toBe(b.secret);
  });

  it("resolves a live token and refuses a revoked one", async () => {
    const minted = await mintAuditToken(t.db, {
      name: "SIEM",
      createdBy: null,
      createdByName: "Dana",
    });
    expect(await resolveAuditToken(t.db, minted.secret)).not.toBeNull();

    await revokeAuditToken(t.db, { id: minted.row.id, revokedBy: null, revokedByName: "Dana" });
    expect(await resolveAuditToken(t.db, minted.secret)).toBeNull();
  });

  it("refuses anything that is not one of ours", async () => {
    for (const bad of ["", "nonsense", "Bearer x", `${AUDIT_TOKEN_PREFIX}wrong`]) {
      expect(await resolveAuditToken(t.db, bad), bad).toBeNull();
    }
  });

  it("revokes once, so a second call cannot rewrite who did it", async () => {
    const minted = await mintAuditToken(t.db, {
      name: "x",
      createdBy: null,
      createdByName: "Dana",
    });
    const first = await revokeAuditToken(t.db, {
      id: minted.row.id,
      revokedBy: null,
      revokedByName: "Dana",
    });
    expect(first).not.toBeNull();
    const second = await revokeAuditToken(t.db, {
      id: minted.row.id,
      revokedBy: null,
      revokedByName: "Someone Else",
    });
    expect(second).toBeNull();
  });
});

describe("the token as a principal", () => {
  async function mintViaApi(adminToken: string): Promise<string> {
    const res = await app!.inject({
      method: "POST",
      url: "/api/audit/tokens",
      headers: auth(adminToken),
      payload: { name: "DFNS SIEM" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().secret as string;
  }

  it("reads the audit log", async () => {
    app = await buildAuthedApp();
    await createAuditWriter(t.db).write({
      action: "signout",
      actor: { id: null, kind: "system" },
    });
    const { token: adminToken } = await signedIn("admin");
    const secret = await mintViaApi(adminToken);

    const res = await app.inject({
      method: "GET",
      url: "/api/audit/events",
      headers: auth(secret),
    });
    expect(res.statusCode).toBe(200);
    // Two events, not one: minting the token above logged `apikey.created`,
    // which is the lifecycle audit working rather than noise.
    const actions = res.json().items.map((i: { action: string }) => i.action);
    expect(actions).toContain("signout");
    expect(actions).toContain("apikey.created");
  });

  it("downloads the export", async () => {
    app = await buildAuthedApp();
    const { token: adminToken } = await signedIn("admin");
    const secret = await mintViaApi(adminToken);

    const res = await app.inject({
      method: "GET",
      url: "/api/audit/export.csv",
      headers: auth(secret),
    });
    expect(res.statusCode).toBe(200);
  });

  /** The claim the whole slice exists to make. */
  it("cannot touch anything outside the audit log", async () => {
    app = await buildAuthedApp();
    const { token: adminToken } = await signedIn("admin");
    const secret = await mintViaApi(adminToken);

    for (const url of ["/api/metrics/specs", "/api/config/routers"]) {
      const res = await app.inject({ method: "GET", url, headers: auth(secret) });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("cannot mint or revoke a token", async () => {
    app = await buildAuthedApp();
    const { token: adminToken } = await signedIn("admin");
    const secret = await mintViaApi(adminToken);

    const create = await app.inject({
      method: "POST",
      url: "/api/audit/tokens",
      headers: auth(secret),
      payload: { name: "escalation" },
    });
    expect(create.statusCode).toBe(403);

    const list = await app.inject({
      method: "GET",
      url: "/api/audit/tokens",
      headers: auth(secret),
    });
    expect(list.statusCode).toBe(403);
  });

  it("stops working the moment it is revoked", async () => {
    app = await buildAuthedApp();
    const { token: adminToken } = await signedIn("admin");
    const created = await app.inject({
      method: "POST",
      url: "/api/audit/tokens",
      headers: auth(adminToken),
      payload: { name: "SIEM" },
    });
    const secret = created.json().secret as string;
    const id = created.json().token.id as string;

    expect(
      (await app.inject({ method: "GET", url: "/api/audit/events", headers: auth(secret) }))
        .statusCode,
    ).toBe(200);

    await app.inject({
      method: "DELETE",
      url: `/api/audit/tokens/${id}`,
      headers: auth(adminToken),
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/audit/events",
      headers: auth(secret),
    });
    expect(after.statusCode).toBe(401);
  });

  it("tells the caller its rate limit", async () => {
    app = await buildAuthedApp();
    const { token: adminToken } = await signedIn("admin");
    const secret = await mintViaApi(adminToken);

    const res = await app.inject({
      method: "GET",
      url: "/api/audit/events",
      headers: auth(secret),
    });
    // The ticket asks for the limit and reset to be visible to the caller.
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("records that it was used", async () => {
    app = await buildAuthedApp();
    const { token: adminToken } = await signedIn("admin");
    const created = await app.inject({
      method: "POST",
      url: "/api/audit/tokens",
      headers: auth(adminToken),
      payload: { name: "SIEM" },
    });
    const secret = created.json().secret as string;

    await app.inject({ method: "GET", url: "/api/audit/events", headers: auth(secret) });
    // The heartbeat is fire-and-forget so the read never waits on it.
    await new Promise((r) => setTimeout(r, 50));

    const list = await app.inject({
      method: "GET",
      url: "/api/audit/tokens",
      headers: auth(adminToken),
    });
    expect(list.json().tokens[0].lastUsedAt).not.toBeNull();
  });
});

describe("token management is admin-only", () => {
  for (const role of ["read_only", "requester", "approver"] as const) {
    it(`refuses a ${role}`, async () => {
      app = await buildAuthedApp();
      const { token } = await signedIn(role);
      const res = await app.inject({
        method: "POST",
        url: "/api/audit/tokens",
        headers: auth(token),
        payload: { name: "nope" },
      });
      expect(res.statusCode).toBe(403);
    });
  }

  it("never returns a hash in a listing", async () => {
    app = await buildAuthedApp();
    const { token } = await signedIn("admin");
    await app.inject({
      method: "POST",
      url: "/api/audit/tokens",
      headers: auth(token),
      payload: { name: "SIEM" },
    });
    const list = await app.inject({
      method: "GET",
      url: "/api/audit/tokens",
      headers: auth(token),
    });
    expect(list.body).not.toContain("tokenHash");
    expect(list.body).not.toContain("token_hash");
    expect(list.json().tokens[0].suffix).toHaveLength(4);
  });

  it("logs the token's creation and revocation, not every pull", async () => {
    app = await buildAuthedApp();
    const { token } = await signedIn("admin");
    const created = await app.inject({
      method: "POST",
      url: "/api/audit/tokens",
      headers: auth(token),
      payload: { name: "SIEM" },
    });
    const id = created.json().token.id as string;
    const secret = created.json().secret as string;

    // Several pulls: none of them should add a row, or the log becomes a
    // record of itself and buries what somebody is looking for.
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "GET", url: "/api/audit/events", headers: auth(secret) });
    }
    await app.inject({ method: "DELETE", url: `/api/audit/tokens/${id}`, headers: auth(token) });

    const events = await app.inject({
      method: "GET",
      url: "/api/audit/events",
      headers: auth(token),
    });
    const actions = events.json().items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(["apikey.created", "apikey.deleted"]);
  });
});
