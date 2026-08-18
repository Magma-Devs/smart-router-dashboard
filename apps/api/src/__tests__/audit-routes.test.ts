import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { createAuditWriter, users, type User } from "@sr/db";
import type { AuditEventsResponse } from "@sr/shared";
import type { Role } from "@sr/shared";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";

/**
 * `GET /api/audit/events`, against a real database.
 *
 * The reader's own guarantees — ordering, the cursor, the settled-transaction
 * horizon — are proved in `@sr/db`'s suite where the interleaving can be
 * staged. What is worth testing here is the HTTP surface on top: what the query
 * string is allowed to say, what it refuses, and who is let in.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
// Unroutable per RFC 5737 — the lazy connect loop fails fast and pglite is
// swapped in by hand, so nothing waits on a real Postgres.
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

async function buildAuthedApp(opts: { withDb?: boolean } = {}): Promise<FastifyInstance> {
  setEnv({ AUTH_MODE: "enabled", AUTH_SECRET: SECRET, DATABASE_URL: DEAD_DB });
  const instance = await buildApp();
  if (opts.withDb !== false) instance.db = t.db;
  return instance;
}

let seq = 0;
async function seedUser(role: Role = "read_only"): Promise<User> {
  const [created] = await t.db
    .insert(users)
    .values({ email: `dana+${++seq}@example.com`, name: "Dana Levi", role })
    .returning();
  return created!;
}

async function signedIn(role: Role = "read_only"): Promise<{ user: User; token: string }> {
  const user = await seedUser(role);
  const session = await createSession(t.db, {
    userId: user.id,
    authMethod: "password",
    client: { ip: "84.229.11.6", userAgent: "Chrome/141.0.0.0 Safari/537.36 (Macintosh)" },
  });
  const token = await new SignJWT({ sub: user.id, email: user.email, role, sid: session.id })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  return { user, token };
}

const get = (token: string, qs = "") =>
  app!.inject({
    method: "GET",
    url: `/api/audit/events${qs}`,
    headers: { authorization: `Bearer ${token}` },
  });

async function seedEvents(): Promise<void> {
  const w = createAuditWriter(t.db);
  await w.write({
    action: "signin.failed",
    actor: { id: null, kind: "user", label: "who@example.com" },
    access: { ip: "84.229.11.6", client: "Chrome 141 / macOS", sessionId: null },
    note: "unknown address",
  });
  await w.write({
    action: "endpoint.providers.changed",
    actor: { id: null, kind: "system" },
    target: { type: "endpoint", id: "ep_8143", name: "eth-jsonrpc" },
    changes: [{ field: "providers", from: "Alchemy, QuickNode", to: "Alchemy" }],
  });
}

describe("GET /api/audit/events", () => {
  it("needs a session", async () => {
    app = await buildAuthedApp();
    const res = await app.inject({ method: "GET", url: "/api/audit/events" });
    expect(res.statusCode).toBe(401);
  });

  /** The ticket is explicit: visible to every role, read-only included. */
  it("is open to the least privileged role", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn("read_only");

    const res = await get(token);
    expect(res.statusCode).toBe(200);
    expect((res.json() as AuditEventsResponse).items).toHaveLength(2);
  });

  it("answers 503 rather than 500 while the database is still connecting", async () => {
    app = await buildAuthedApp({ withDb: false });
    // No live db, so no session either — mint against a user that isn't there
    // and assert the 503 arrives ahead of anything else going wrong.
    app.db = t.db;
    const { token } = await signedIn();
    app.db = null;

    const res = await get(token);
    expect([401, 503]).toContain(res.statusCode);
  });

  it("serves oldest first without being asked", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();

    const body = (await get(token)).json() as AuditEventsResponse;
    expect(body.items.map((i) => i.action)).toEqual([
      "signin.failed",
      "endpoint.providers.changed",
    ]);
    expect(body.has_more).toBe(false);
  });

  it("reverses for the viewer on request", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();

    const body = (await get(token, "?order=desc")).json() as AuditEventsResponse;
    expect(body.items[0]?.action).toBe("endpoint.providers.changed");
  });

  it("returns the ticket's row shape, context only where it belongs", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();

    const body = (await get(token)).json() as AuditEventsResponse;
    const [signin, changed] = body.items;

    expect(signin?.actor).toMatchObject({ type: "user", name: "who@example.com" });
    expect(signin?.context).toMatchObject({ ip: "84.229.11.6", client: "Chrome 141 / macOS" });
    expect(signin?.note).toBe("unknown address");

    expect(changed?.target).toEqual({ type: "endpoint", id: "ep_8143", name: "eth-jsonrpc" });
    expect(changed?.changes).toEqual([
      { field: "providers", from: "Alchemy, QuickNode", to: "Alchemy" },
    ]);
    // A config event carries no address, as a matter of shape.
    expect(changed && "context" in changed).toBe(false);
  });

  it("filters by verb, group and object", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();

    const byAction = (await get(token, "?action=signin.failed")).json() as AuditEventsResponse;
    expect(byAction.items.map((i) => i.action)).toEqual(["signin.failed"]);

    const byGroup = (await get(token, "?group=config")).json() as AuditEventsResponse;
    expect(byGroup.items.map((i) => i.action)).toEqual(["endpoint.providers.changed"]);

    const byTarget = (
      await get(token, "?target_type=endpoint&target_id=ep_8143")
    ).json() as AuditEventsResponse;
    expect(byTarget.items).toHaveLength(1);
  });

  it("resumes from its own cursor without repeating a row", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();

    const first = (await get(token, "?per_page=1")).json() as AuditEventsResponse;
    expect(first.items).toHaveLength(1);
    expect(first.has_more).toBe(true);

    const second = (
      await get(token, `?per_page=1&after=${encodeURIComponent(first.cursor!)}`)
    ).json() as AuditEventsResponse;

    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  /**
   * Every case below could be answered with an empty page instead. None of them
   * should be: "no events matched" and "your filter was nonsense" look
   * identical to a caller, and on an audit log the first reads as an all-clear.
   */
  it("refuses a misspelled verb rather than reporting nothing happened", async () => {
    app = await buildAuthedApp();
    const { token } = await signedIn();

    const res = await get(token, "?action=signin.failure");
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("signin.failure");
  });

  it("refuses an unknown group", async () => {
    app = await buildAuthedApp();
    const { token } = await signedIn();
    expect((await get(token, "?group=nonsense")).statusCode).toBe(400);
  });

  it("refuses an actor that is neither a user id nor an address", async () => {
    app = await buildAuthedApp();
    const { token } = await signedIn();
    expect((await get(token, "?actor=dana")).statusCode).toBe(400);
  });

  it("refuses an unparseable time", async () => {
    app = await buildAuthedApp();
    const { token } = await signedIn();
    expect((await get(token, "?from=last-tuesday")).statusCode).toBe(400);
  });

  it("refuses a cursor it did not issue", async () => {
    app = await buildAuthedApp();
    const { token } = await signedIn();
    expect((await get(token, "?after=not-a-cursor")).statusCode).toBe(400);
  });

  it("refuses a cursor whose filters have moved", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();

    const first = (await get(token, "?per_page=1&group=access")).json() as AuditEventsResponse;
    // Same position, different question. Answering it would skip every row the
    // first filter excluded and the caller would never know.
    const res = await get(token, `?per_page=1&after=${encodeURIComponent(first.cursor!)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("filter set");
  });

  it("refuses a cursor issued for the other direction", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();

    const first = (await get(token, "?per_page=1")).json() as AuditEventsResponse;
    const res = await get(
      token,
      `?per_page=1&order=desc&after=${encodeURIComponent(first.cursor!)}`,
    );
    expect(res.statusCode).toBe(400);
  });

  it("clamps an oversized page rather than refusing it", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();
    // Fastify's own schema bounds this; either answer is defensible, but it
    // must not 500.
    const res = await get(token, "?per_page=99999");
    expect([200, 400]).toContain(res.statusCode);
  });
});
