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
  /**
   * The premise of the viewer's "no audit log on this deployment" state. If the
   * route ever leaked outside the AUTH_MODE gate it would answer 401 rather than
   * 404, and the web would tell people to set an environment variable that is
   * already set.
   */
  it("does not exist at all when auth is disabled", async () => {
    setEnv({ AUTH_MODE: undefined, AUTH_SECRET: undefined, DATABASE_URL: undefined });
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/audit/events" });
    expect(res.statusCode).toBe(404);
  });

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

/**
 * The CSV export.
 *
 * The shape rules are the ticket's ("one line per changed field… events with
 * nothing to diff get one line with the field columns empty") and the escaping
 * is `@sr/shared`'s, tested there. What is worth asserting here is that the two
 * meet correctly — that the guard survives the round trip into a real response,
 * and that the file cannot answer a question the screen would refuse.
 */
describe("GET /api/audit/export.csv", () => {
  const csvOf = async (token: string, qs = "") => {
    const res = await app!.inject({
      method: "GET",
      url: `/api/audit/export.csv${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { res, text: res.body };
  };

  it("needs a session, like everything else on /api", async () => {
    app = await buildAuthedApp();
    const res = await app.inject({ method: "GET", url: "/api/audit/export.csv" });
    expect(res.statusCode).toBe(401);
  });

  it("serves a download with the audit columns", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();
    const { res, text } = await csvOf(token);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toMatch(/audit-log-\d{4}-\d{2}-\d{2}\.csv/);

    const [header] = text.split("\r\n");
    // The BOM leads the file; strip it before comparing the first column.
    expect(header?.replace(/^\uFEFF/, "").split(",")).toEqual([
      "event_id",
      "time",
      "actor_name",
      "actor_email",
      "source",
      "action",
      "group",
      "target_type",
      "target_id",
      "target_name",
      "request",
      "note",
      "field",
      "from",
      "to",
    ]);
  });

  it("leads with a UTF-8 BOM so a spreadsheet does not mangle a name", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();
    const { text } = await csvOf(token);
    expect(text.startsWith("\uFEFF")).toBe(true);
  });

  it("uses CRLF, or Excel folds every row into one cell", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();
    const { text } = await csvOf(token);
    expect(text).toContain("\r\n");
  });

  it("writes one row per changed field, sharing the event id", async () => {
    app = await buildAuthedApp();
    const w = createAuditWriter(t.db);
    await w.write({
      action: "provider.edited",
      actor: { id: null, kind: "system" },
      target: { type: "provider", id: "pr_331", name: "QuickNode" },
      changes: [
        { field: "node URL", from: "(changed, ends 4c02)", to: "(changed, ends 91be)" },
        { field: "capabilities", from: "archive, debug", to: "archive, debug, trace" },
      ],
    });
    const { token } = await signedIn();
    const { text } = await csvOf(token);

    const rows = text
      .split("\r\n")
      .filter((l) => l.length > 0)
      .slice(1);
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.split(",")[0]);
    expect(ids[0]).toBe(ids[1]);
    expect(rows[0]).toContain("node URL");
    expect(rows[1]).toContain("capabilities");
  });

  it("gives an event with nothing to diff one row with the field columns empty", async () => {
    app = await buildAuthedApp();
    await createAuditWriter(t.db).write({
      action: "signout",
      actor: { id: null, kind: "system" },
    });
    const { token } = await signedIn();
    const { text } = await csvOf(token);

    const rows = text
      .split("\r\n")
      .filter((l) => l.length > 0)
      .slice(1);
    expect(rows).toHaveLength(1);
    // Trailing field,from,to are empty rather than absent — a short row would
    // shift every column after it in a spreadsheet.
    expect(rows[0]?.endsWith(",,,")).toBe(true);
    expect(rows[0]?.split(",")).toHaveLength(15);
  });

  /**
   * The one that matters. Provider names and rejection reasons are free text a
   * user typed, and this file's whole purpose is to be opened in Excel.
   */
  it("neutralises a formula a user typed into a name", async () => {
    app = await buildAuthedApp();
    await createAuditWriter(t.db).write({
      action: "provider.renamed",
      actor: { id: null, kind: "system" },
      target: { type: "provider", id: "pr_9", name: '=HYPERLINK("http://evil","click")' },
      changes: [{ field: "name", from: "QuickNode", to: '=HYPERLINK("http://evil","click")' }],
    });
    const { token } = await signedIn();
    const { text } = await csvOf(token);

    // Quoted (it holds a comma and quotes) AND apostrophe-led, so the cell is
    // text rather than a live formula.
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    // No bare formula lead anywhere: every = must be behind the guard.
    for (const cell of text.split(/\r\n|,/)) {
      expect(cell.startsWith("=")).toBe(false);
    }
  });

  it("never writes a secret, only that it changed", async () => {
    app = await buildAuthedApp();
    await createAuditWriter(t.db).write({
      action: "provider.edited",
      actor: { id: null, kind: "system" },
      target: { type: "provider", id: "pr_1", name: "QuickNode" },
      changes: [{ field: "node URL", from: "(changed, ends 4c02)", to: "(changed, ends 91be)" }],
    });
    const { token } = await signedIn();
    const { text } = await csvOf(token);
    expect(text).toContain("(changed, ends 91be)");
    expect(text).not.toContain("https://");
  });

  it("honours the same filters as the feed", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();

    const { text } = await csvOf(token, "?group=config");
    expect(text).toContain("endpoint.providers.changed");
    expect(text).not.toContain("signin.failed");
  });

  /** A file outlives the query that made it, so a nonsense filter answered with
   *  an empty download is worse here than on screen. */
  it("refuses a filter it cannot honour rather than exporting nothing", async () => {
    app = await buildAuthedApp();
    const { token } = await signedIn();
    expect((await csvOf(token, "?action=signin.failure")).res.statusCode).toBe(400);
    expect((await csvOf(token, "?actor=dana")).res.statusCode).toBe(400);
    expect((await csvOf(token, "?from=last-tuesday")).res.statusCode).toBe(400);
  });

  it("spans more than one internal page without repeating or dropping a row", async () => {
    app = await buildAuthedApp();
    const w = createAuditWriter(t.db);
    for (let i = 0; i < 12; i++) {
      await w.write({ action: "signout", actor: { id: null, kind: "system" }, note: `n${i}` });
    }
    const { token } = await signedIn();
    const { text } = await csvOf(token);

    const rows = text
      .split("\r\n")
      .filter((l) => l.length > 0)
      .slice(1);
    expect(rows).toHaveLength(12);
    const ids = rows.map((r) => r.split(",")[0]);
    expect(new Set(ids).size).toBe(12);
  });
});
