import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../testing.js";
import { createAuditWriter } from "../audit.js";
import {
  auditFilterFingerprint,
  checkAuditCursor,
  decodeAuditCursor,
  encodeAuditCursor,
  listAuditEvents,
  type AuditCursor,
} from "../audit-read.js";
import { auditEvents } from "../schema-audit.js";
import { users } from "../schema.js";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

function writer() {
  return createAuditWriter(t.db);
}

/** Rows are append-only; the retention gate is the only way to stage a state
 *  the writer cannot produce. Used here to pin `xact_id` values, standing in
 *  for transactions that committed in an order the sequence doesn't reflect. */
async function setXactId(seq: number, xactId: string): Promise<void> {
  await t.db.transaction(async (tx) => {
    await tx.execute(sql`set local audit.purge = 'on'`);
    await tx.execute(sql`update audit_events set xact_id = ${xactId}::xid8 where seq = ${seq}`);
  });
}

async function seedUser(email: string, name: string): Promise<string> {
  const [row] = await t.db.insert(users).values({ email, name }).returning({ id: users.id });
  return row!.id;
}

describe("cursor codec", () => {
  const cursor: AuditCursor = { seq: 42, horizon: "1234", order: "asc", fingerprint: "abc" };

  it("round-trips", () => {
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it("is opaque rather than readable", () => {
    // Not a security boundary — but a caller who hand-builds one is a caller
    // who can break the resume guarantee without knowing it.
    expect(encodeAuditCursor(cursor)).not.toContain("42");
  });

  it("rejects anything that is not one of ours", () => {
    for (const bad of ["", "not-base64!", Buffer.from("{}").toString("base64url")]) {
      expect(decodeAuditCursor(bad), `should reject ${bad}`).toBeNull();
    }
    // Shape-valid JSON with the wrong field types is still a rejection, not a
    // coercion — a cursor with seq "12" would silently compare as a string.
    const wrong = Buffer.from(
      JSON.stringify({ seq: "12", horizon: "1", order: "asc", fingerprint: "x" }),
    ).toString("base64url");
    expect(decodeAuditCursor(wrong)).toBeNull();
  });

  it("ignores page size but notices every real filter", () => {
    const base = { actions: ["signin.failed"] } as const;
    expect(auditFilterFingerprint({ ...base, limit: 10 })).toBe(
      auditFilterFingerprint({ ...base, limit: 500 }),
    );
    expect(auditFilterFingerprint({ actions: ["signin.failed", "signout"] })).not.toBe(
      auditFilterFingerprint(base),
    );
    expect(auditFilterFingerprint({ ...base, targetId: "ep_1" })).not.toBe(
      auditFilterFingerprint(base),
    );
  });

  it("treats a reordered filter list as the same filter", () => {
    // A puller rebuilding its query string must not be told to start over.
    expect(auditFilterFingerprint({ groups: ["access", "people"] })).toBe(
      auditFilterFingerprint({ groups: ["people", "access"] }),
    );
  });

  it("refuses a resume whose filters or direction moved", () => {
    const query = { actions: ["signin.failed"] };
    const good: AuditCursor = {
      seq: 1,
      horizon: "1",
      order: "asc",
      fingerprint: auditFilterFingerprint(query),
    };
    expect(checkAuditCursor(good, query)).toBeNull();
    expect(checkAuditCursor(good, { actions: ["signout"] })).toBe("filters-changed");
    expect(checkAuditCursor({ ...good, order: "desc" }, query)).toBe("order-changed");
  });
});

describe("listAuditEvents", () => {
  it("defaults to oldest first", async () => {
    const w = writer();
    await w.write({ action: "signin.succeeded", actor: { id: null, kind: "system" } });
    await w.write({ action: "signout", actor: { id: null, kind: "system" } });

    const page = await listAuditEvents(t.db);
    expect(page.items.map((i) => i.action)).toEqual(["signin.succeeded", "signout"]);
  });

  it("reverses for the viewer when asked", async () => {
    const w = writer();
    await w.write({ action: "signin.succeeded", actor: { id: null, kind: "system" } });
    await w.write({ action: "signout", actor: { id: null, kind: "system" } });

    const page = await listAuditEvents(t.db, { order: "desc" });
    expect(page.items.map((i) => i.action)).toEqual(["signout", "signin.succeeded"]);
  });

  it("carries the changes in the order they were written", async () => {
    await writer().write({
      action: "provider.edited",
      actor: { id: null, kind: "system" },
      target: { type: "provider", id: "pr_331", name: "QuickNode" },
      changes: [
        { field: "node URL", from: "(changed, ends 4c02)", to: "(changed, ends 91be)" },
        { field: "capabilities", from: "archive, debug", to: "archive, debug, trace" },
      ],
    });

    const [item] = (await listAuditEvents(t.db)).items;
    expect(item?.changes.map((c) => c.field)).toEqual(["node URL", "capabilities"]);
    expect(item?.target).toEqual({ type: "provider", id: "pr_331", name: "QuickNode" });
  });

  it("gives access events a context block and everything else none", async () => {
    const w = writer();
    await w.write({
      action: "signin.failed",
      actor: { id: null, kind: "user", label: "who@example.com" },
      access: { ip: "84.229.11.6", client: "Chrome 141 / macOS", sessionId: null },
    });
    await w.write({
      action: "provider.renamed",
      actor: { id: null, kind: "system" },
      changes: [{ field: "name", from: "a", to: "b" }],
    });

    const [signin, renamed] = (await listAuditEvents(t.db)).items;
    expect(signin?.context).toEqual({
      ip: "84.229.11.6",
      client: "Chrome 141 / macOS",
      session: null,
    });
    // Absent, not nulled: the shape says which kind of row this is.
    expect(renamed && "context" in renamed).toBe(false);
  });

  it("filters by person, by verb, by group and by object", async () => {
    const dana = await seedUser("dana@customer.com", "Dana Levi");
    const w = writer();
    await w.write({ action: "member.invited", actor: { id: dana, kind: "user" } });
    await w.write({ action: "signout", actor: { id: null, kind: "system" } });
    await w.write({
      action: "endpoint.deleted",
      actor: { id: null, kind: "system" },
      target: { type: "endpoint", id: "ep_8143", name: "eth-jsonrpc" },
      changes: [{ field: "host", from: "eth.example.com", to: "(deleted)" }],
    });

    const byActor = await listAuditEvents(t.db, { actor: { userId: dana } });
    expect(byActor.items.map((i) => i.action)).toEqual(["member.invited"]);

    const byEmail = await listAuditEvents(t.db, { actor: { email: "DANA@CUSTOMER.COM" } });
    expect(byEmail.items.map((i) => i.action)).toEqual(["member.invited"]);

    const byAction = await listAuditEvents(t.db, { actions: ["signout"] });
    expect(byAction.items.map((i) => i.action)).toEqual(["signout"]);

    const byGroup = await listAuditEvents(t.db, { groups: ["config"] });
    expect(byGroup.items.map((i) => i.action)).toEqual(["endpoint.deleted"]);

    const byTarget = await listAuditEvents(t.db, { targetType: "endpoint", targetId: "ep_8143" });
    expect(byTarget.items.map((i) => i.action)).toEqual(["endpoint.deleted"]);
  });

  it("filters by time range on the recorded time", async () => {
    const w = writer();
    await w.write({
      action: "signout",
      actor: { id: null, kind: "system" },
      occurredAt: new Date("2026-08-01T00:00:00Z"),
    });
    await w.write({
      action: "signin.succeeded",
      actor: { id: null, kind: "system" },
      occurredAt: new Date("2026-08-10T00:00:00Z"),
    });

    const page = await listAuditEvents(t.db, { from: new Date("2026-08-05T00:00:00Z") });
    expect(page.items.map((i) => i.action)).toEqual(["signin.succeeded"]);
    expect(page.items[0]?.time).toBe("2026-08-10T00:00:00.000Z");
  });

  it("pages, and says whether there is more", async () => {
    const w = writer();
    for (let i = 0; i < 5; i++) {
      await w.write({ action: "signout", actor: { id: null, kind: "system" } });
    }

    const first = await listAuditEvents(t.db, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await listAuditEvents(t.db, { limit: 2, cursor: first.cursor! });
    expect(second.items).toHaveLength(2);

    const third = await listAuditEvents(t.db, { limit: 2, cursor: second.cursor! });
    expect(third.items).toHaveLength(1);
    expect(third.hasMore).toBe(false);
  });

  it("drains a feed exactly once, with no gaps and no repeats", async () => {
    const w = writer();
    for (let i = 0; i < 11; i++) {
      await w.write({
        action: "signout",
        actor: { id: null, kind: "system" },
        note: `event-${i}`,
      });
    }

    const seen: string[] = [];
    let cursor: AuditCursor | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await listAuditEvents(t.db, { limit: 3, cursor });
      seen.push(...page.items.map((i) => i.note!));
      cursor = page.cursor ?? cursor;
      if (!page.hasMore) break;
    }

    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);
    expect(seen).toEqual(Array.from({ length: 11 }, (_, i) => `event-${i}`));
  });

  it("returns an id that survives a re-pull of the same range", async () => {
    await writer().write({ action: "signout", actor: { id: null, kind: "system" } });
    const first = await listAuditEvents(t.db);
    const again = await listAuditEvents(t.db);
    expect(again.items[0]?.id).toBe(first.items[0]?.id);
  });
});

/**
 * The property the whole design is for.
 *
 * `seq` is handed out at INSERT, not at COMMIT, so two writers can take 100 and
 * 101 and commit in the other order. A reader that trusted `seq` alone would
 * serve 101, the puller would store it, and 100 would surface afterwards behind
 * the cursor — lost from that customer's copy permanently, with nothing to show
 * for it.
 *
 * The horizon is pinned here rather than raced for: this is a statement about
 * two overlapping transactions, and the in-process Postgres has one connection.
 * Pinning reproduces the exact interleaving deterministically.
 */
describe("a transaction that commits out of sequence order", () => {
  async function twoRowsCommittedOutOfOrder() {
    const w = writer();
    await w.write({ action: "signout", actor: { id: null, kind: "system" }, note: "slow" });
    await w.write({ action: "signout", actor: { id: null, kind: "system" }, note: "fast" });

    const rows = await t.db.select().from(auditEvents).orderBy(auditEvents.seq);
    const [slow, fast] = rows;
    // `slow` took the lower sequence but its transaction is still open;
    // `fast` took the higher one and has already settled.
    await setXactId(slow!.seq, "5000");
    await setXactId(fast!.seq, "100");
    return { slowSeq: slow!.seq, fastSeq: fast!.seq };
  }

  it("withholds the row whose transaction is still open", async () => {
    await twoRowsCommittedOutOfOrder();
    const page = await listAuditEvents(t.db, { horizonOverride: "1000" });
    // Serving `slow` here would be wrong in the other direction — a row that
    // might yet roll back.
    expect(page.items.map((i) => i.note)).toEqual(["fast"]);
  });

  it("delivers it once its transaction settles, behind the cursor", async () => {
    const { slowSeq } = await twoRowsCommittedOutOfOrder();

    const first = await listAuditEvents(t.db, { horizonOverride: "1000" });
    expect(first.items.map((i) => i.note)).toEqual(["fast"]);
    // The position is now past `slow`'s sequence. A seq-only reader stops here.
    expect(first.cursor!.seq).toBeGreaterThan(slowSeq);

    const second = await listAuditEvents(t.db, {
      horizonOverride: "9000",
      cursor: first.cursor!,
    });
    expect(second.items.map((i) => i.note)).toEqual(["slow"]);
  });

  it("does not re-deliver the row it already served", async () => {
    await twoRowsCommittedOutOfOrder();
    const first = await listAuditEvents(t.db, { horizonOverride: "1000" });
    const second = await listAuditEvents(t.db, {
      horizonOverride: "9000",
      cursor: first.cursor!,
    });
    const third = await listAuditEvents(t.db, {
      horizonOverride: "9000",
      cursor: second.cursor!,
    });

    const delivered = [...first.items, ...second.items, ...third.items].map((i) => i.note);
    expect(delivered).toEqual(["fast", "slow"]);
  });

  it("keeps the position monotonic when a straggler arrives", async () => {
    const { fastSeq } = await twoRowsCommittedOutOfOrder();
    const first = await listAuditEvents(t.db, { horizonOverride: "1000" });
    const second = await listAuditEvents(t.db, {
      horizonOverride: "9000",
      cursor: first.cursor!,
    });
    // The straggler's sequence is lower; letting it drag the cursor back would
    // re-deliver everything after it on the next read.
    expect(second.cursor!.seq).toBe(fastSeq);
  });
});
