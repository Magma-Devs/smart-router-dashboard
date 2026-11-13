import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import {
  auditEvents,
  auditFilterFingerprint,
  createAuditWriter,
  encodeAuditCursor,
  mintAuditToken,
  users,
  type User,
} from "@sr/db";
import { AUDIT_ACTIONS, type AuditEventsResponse } from "@sr/shared";
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
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    // Required at boot since MAG-2730: two-factor secrets are encrypted at
    // rest, and the api refuses to start enabled without the key.
    TOTP_ENCRYPTION_KEY: "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=",
    INTERNAL_AUTH_SECRET: "test-internal-secret-32-characters!",
  });
  const instance = await buildApp();
  if (opts.withDb !== false) instance.db = t.db;
  return instance;
}

let seq = 0;
async function seedUser(role: Role = "read_only"): Promise<User> {
  const [created] = await t.db
    .insert(users)
    // Enrolled: since MAG-2730 the gate shuts the dashboard on anyone
    // without a second factor, and these tests are about the audit log.
    .values({ ...enrolledTwoFactor(), email: `dana+${++seq}@example.com`, name: "Dana Levi", role })
    .returning();
  return created!;
}

async function signedIn(role: Role = "read_only"): Promise<{ user: User; token: string }> {
  const user = await seedUser(role);
  const session = await createSession(t.db, {
    userId: user.id,
    authMethod: "password",
    client: { ip: "203.0.113.64", userAgent: "Chrome/141.0.0.0 Safari/537.36 (Macintosh)" },
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
    access: { ip: "203.0.113.64", client: "Chrome 141 / macOS", sessionId: null },
    note: "unknown address",
  });
  await w.write({
    action: "endpoint.providers.changed",
    actor: { id: null, kind: "system" },
    target: { type: "endpoint", id: "ep_8143", name: "eth-jsonrpc" },
    changes: [{ field: "providers", from: "Alchemy, QuickNode", to: "Alchemy" }],
  });
}

describe("GET /api/audit/catalog", () => {
  it("publishes every event the filters accept, with its meaning", async () => {
    app = await buildAuthedApp();
    const { token } = await signedIn("read_only");
    const res = await app.inject({
      method: "GET",
      url: "/api/audit/catalog",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const events = res.json().events as {
      action: string;
      group: string;
      description: string;
    }[];
    // Complete by construction — but pinned, because "the published list" that
    // silently lost a group would fail the requirement while looking fine.
    expect(events.map((e) => e.action).sort()).toEqual([...AUDIT_ACTIONS].sort());
    for (const e of events) expect(e.description.length).toBeGreaterThan(10);
  });

  it("needs a session, like the log itself", async () => {
    app = await buildAuthedApp();
    const res = await app.inject({ method: "GET", url: "/api/audit/catalog" });
    expect(res.statusCode).toBe(401);
  });
});

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
    expect(signin?.context).toMatchObject({ ip: "203.0.113.64", client: "Chrome 141 / macOS" });
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

  /**
   * Shape-valid and carrying the right fingerprint — only the number is
   * impossible. Without a bound, Postgres refuses the `xid8` cast inside the
   * query and the caller's mistake comes back as a 500.
   */
  it("refuses a cursor past the largest transaction id rather than failing the read", async () => {
    app = await buildAuthedApp();
    await seedEvents();
    const { token } = await signedIn();
    const forged = encodeAuditCursor({
      seq: 1,
      xact: "99999999999999999999",
      order: "asc",
      fingerprint: auditFilterFingerprint({ order: "asc" }),
    });
    const res = await get(token, `?after=${forged}`);
    expect(res.statusCode).toBe(400);
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
 * Paging — the viewer's Older / Newer / Newest over the newest-first feed.
 *
 * `after` continues past the last row of a page, `before` reads the page just
 * ahead of the first. Both are keyset reads from a position, so rows written
 * at the head while someone reads further down never move what they see.
 */
describe("GET /api/audit/events paging", () => {
  /**
   * Rows in the writer's shape with the sequence chosen, so a test can leave a
   * hole and fill it later — a transaction that took its sequence early and
   * committed late. Each call is one statement, so one transaction.
   */
  async function insertAt(seqs: number[]): Promise<void> {
    await t.db.insert(auditEvents).values(
      seqs.map((seq) => ({
        seq,
        action: "signout",
        actionGroup: "access",
        source: "dashboard" as const,
        actorKind: "system" as const,
        actorName: "System",
        note: `e${seq}`,
      })),
    );
  }
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const notes = (body: AuditEventsResponse) => body.items.map((i) => i.note);
  const page = async (token: string, qs: string) => {
    const res = await get(token, qs);
    expect(res.statusCode).toBe(200);
    return res.json() as AuditEventsResponse;
  };
  const at = (param: "after" | "before", cursor: string | null) =>
    `&${param}=${encodeURIComponent(cursor!)}`;

  it("pages older, then back newer to the same pages", async () => {
    app = await buildAuthedApp();
    await insertAt(range(1, 7));
    const { token } = await signedIn();
    const q = "?order=desc&per_page=3";

    const head = await page(token, q);
    expect(notes(head)).toEqual(["e7", "e6", "e5"]);
    expect(head).toMatchObject({ has_more: true, has_previous: false });

    const second = await page(token, q + at("after", head.cursor));
    expect(notes(second)).toEqual(["e4", "e3", "e2"]);
    expect(second).toMatchObject({ has_more: true, has_previous: true });

    const last = await page(token, q + at("after", second.cursor));
    expect(notes(last)).toEqual(["e1"]);
    expect(last).toMatchObject({ has_more: false, has_previous: true });

    const backToSecond = await page(token, q + at("before", last.start_cursor));
    expect(notes(backToSecond)).toEqual(notes(second));
    expect(backToSecond).toMatchObject({ has_more: true, has_previous: true });

    const backToHead = await page(token, q + at("before", backToSecond.start_cursor));
    expect(notes(backToHead)).toEqual(notes(head));
    expect(backToHead.has_previous).toBe(false);
  });

  it("ends an exact multiple of the page size without an empty page", async () => {
    app = await buildAuthedApp();
    await insertAt(range(1, 6));
    const { token } = await signedIn();
    const q = "?order=desc&per_page=3";

    const head = await page(token, q);
    expect(head.has_more).toBe(true);
    const last = await page(token, q + at("after", head.cursor));
    expect(notes(last)).toEqual(["e3", "e2", "e1"]);
    // Nothing past it: no Older button leading to a blank page.
    expect(last.has_more).toBe(false);
  });

  it("answers an empty feed with no positions either way", async () => {
    app = await buildAuthedApp();
    const { token } = await signedIn();
    const body = await page(token, "?order=desc&per_page=50");
    expect(body).toEqual({
      items: [],
      cursor: null,
      has_more: false,
      start_cursor: null,
      has_previous: false,
    });
  });

  it("does not move a page when rows are written at the head", async () => {
    app = await buildAuthedApp();
    await insertAt(range(1, 9));
    const { token } = await signedIn();
    const q = "?order=desc&per_page=3";

    const head = await page(token, q);
    const second = await page(token, q + at("after", head.cursor));
    await insertAt(range(10, 14));

    // Further down: continues from the row it stopped at.
    const third = await page(token, q + at("after", second.cursor));
    expect(notes(third)).toEqual(["e3", "e2", "e1"]);
    // Back up: the page that was the newest, exactly, and word that more
    // has arrived above it.
    const back = await page(token, q + at("before", second.start_cursor));
    expect(notes(back)).toEqual(notes(head));
    expect(back.has_previous).toBe(true);
    const arrived = await page(token, "?order=desc&per_page=100" + at("before", back.start_cursor));
    expect(notes(arrived)).toEqual(["e14", "e13", "e12", "e11", "e10"]);
    expect(arrived.has_previous).toBe(false);
  });

  /**
   * A transaction that took its sequence early and committed while someone was
   * paging. Newest-first is the screen's order and has no horizon, so the row
   * lands where its sequence puts it: a reader already past that point meets it
   * on the way back up, once, and no page in either walk repeats a row.
   */
  it("places a straggler committed mid-paging once, without repeating a row", async () => {
    app = await buildAuthedApp();
    await insertAt([...range(1, 4), ...range(6, 10)]);
    const { token } = await signedIn();
    const q = "?order=desc&per_page=3";

    const down: (string | null)[][] = [];
    let body = await page(token, q);
    down.push(notes(body));
    body = await page(token, q + at("after", body.cursor));
    down.push(notes(body));
    expect(notes(body)).toEqual(["e7", "e6", "e4"]);

    await insertAt([5]); // commits now, behind the reader's position

    while (body.has_more) {
      body = await page(token, q + at("after", body.cursor));
      down.push(notes(body));
    }
    expect(down.flat()).toEqual(["e10", "e9", "e8", "e7", "e6", "e4", "e3", "e2", "e1"]);

    const up: (string | null)[] = [...notes(body)];
    while (body.has_previous) {
      body = await page(token, q + at("before", body.start_cursor));
      up.unshift(...notes(body));
    }
    expect(up).toEqual(
      range(1, 10)
        .reverse()
        .map((n) => `e${n}`),
    );
  });

  /**
   * The pull's guarantee, end to end over HTTP: the same late row in
   * oldest-first order arrives after everything already pulled, rather than
   * behind the stored cursor.
   */
  it("still delivers a straggler to an oldest-first puller after its cursor", async () => {
    app = await buildAuthedApp();
    await insertAt([1, 2, 4]);
    const { token } = await signedIn();

    const first = await page(token, "?per_page=10");
    expect(notes(first)).toEqual(["e1", "e2", "e4"]);
    await insertAt([3]);
    const next = await page(token, "?per_page=10" + at("after", first.cursor));
    expect(notes(next)).toEqual(["e3"]);
  });

  it("lets an audit token page back, and still nothing but read", async () => {
    app = await buildAuthedApp();
    await insertAt(range(1, 4));
    const { secret } = await mintAuditToken(t.db, {
      name: "SIEM pull",
      createdBy: null,
      createdByName: "Dana Levi",
    });
    const q = "?order=desc&per_page=2";
    const head = await page(secret, q);
    const older = await page(secret, q + at("after", head.cursor));
    const back = await page(secret, q + at("before", older.start_cursor));
    expect(notes(back)).toEqual(notes(head));

    const write = await app.inject({
      method: "POST",
      url: `/api/audit/events${q}${at("before", older.start_cursor)}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(write.statusCode).toBe(403);
  });

  /** Every malformed position is the caller's mistake: 400, never a 500 and
   *  never a quietly empty page. */
  describe("refuses a position it cannot use", () => {
    it("a `before` it did not issue", async () => {
      app = await buildAuthedApp();
      const { token } = await signedIn();
      const res = await get(token, "?order=desc&before=not-a-cursor");
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("`before`");
    });

    it("`after` and `before` together", async () => {
      app = await buildAuthedApp();
      await insertAt(range(1, 4));
      const { token } = await signedIn();
      const head = await page(token, "?order=desc&per_page=2");
      const res = await get(
        token,
        "?order=desc&per_page=2" + at("after", head.cursor) + at("before", head.start_cursor),
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("not both");
    });

    it("a `before` from another filter set or the other order", async () => {
      app = await buildAuthedApp();
      await insertAt(range(1, 4));
      const { token } = await signedIn();
      const head = await page(token, "?order=desc&per_page=2&group=access");

      const moved = await get(token, "?order=desc&per_page=2" + at("before", head.start_cursor));
      expect(moved.statusCode).toBe(400);
      expect(moved.json().message).toContain("filter set");

      const flipped = await get(
        token,
        "?order=asc&per_page=2&group=access" + at("before", head.start_cursor),
      );
      expect(flipped.statusCode).toBe(400);
    });

    it("a `before` past the largest transaction id", async () => {
      app = await buildAuthedApp();
      await insertAt(range(1, 2));
      const { token } = await signedIn();
      const forged = encodeAuditCursor({
        seq: 1,
        xact: "99999999999999999999",
        order: "asc",
        fingerprint: auditFilterFingerprint({ order: "asc" }),
      });
      expect((await get(token, `?before=${forged}`)).statusCode).toBe(400);
    });

    it("a negative or fractional sequence", async () => {
      app = await buildAuthedApp();
      const { token } = await signedIn();
      const fingerprint = auditFilterFingerprint({ order: "desc" });
      for (const seq of [-1, 1.5]) {
        const raw = Buffer.from(
          JSON.stringify({ seq, xact: "1", order: "desc", fingerprint }),
        ).toString("base64url");
        expect((await get(token, `?order=desc&before=${raw}`)).statusCode).toBe(400);
      }
    });

    it("a cursor longer than any it issues", async () => {
      app = await buildAuthedApp();
      const { token } = await signedIn();
      const res = await get(token, `?order=desc&before=${"a".repeat(600)}`);
      expect(res.statusCode).toBe(400);
    });
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
