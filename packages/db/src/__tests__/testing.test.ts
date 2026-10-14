import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { users } from "../schema.js";
import { createTestDb, type TestDb } from "../testing.js";

/**
 * The contract every db-backed test in the repo leans on: `createTestDb()`
 * hands back a database with every migration applied and nothing else in it.
 * The instance is shared across a file and wiped between calls, so what is
 * pinned here is exactly the wipe — rows and sequences — and that a caller
 * who asks to watch SQL is kept out of the shared one.
 */
const journal = JSON.parse(
  readFileSync(new URL("../../migrations/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: unknown[] };

describe("createTestDb", () => {
  const open: TestDb[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((t) => t.close()));
  });
  async function openDb(options?: Parameters<typeof createTestDb>[0]): Promise<TestDb> {
    const t = await createTestDb(options);
    open.push(t);
    return t;
  }

  it("has every migration in the journal applied", async () => {
    const t = await openDb();
    const result = await t.db.execute(
      sql`select count(*)::int as applied from drizzle.__drizzle_migrations`,
    );
    expect(result.rows[0]).toEqual({ applied: journal.entries.length });
  });

  it("starts every call from an empty database", async () => {
    const first = await openDb();
    await first.db.insert(users).values({ email: "a@example.com", role: "admin" });
    const second = await openDb();
    expect(await second.db.select().from(users)).toEqual([]);
  });

  it("restarts sequences between calls", async () => {
    const first = await openDb();
    await first.db.execute(sql`select nextval(pg_get_serial_sequence('audit_events', 'seq'))`);
    const second = await openDb();
    const result = await second.db.execute(
      sql`select nextval(pg_get_serial_sequence('audit_events', 'seq'))::int as next`,
    );
    expect(result.rows[0]).toEqual({ next: 1 });
  });

  it("hands a caller that watches SQL a private database", async () => {
    const shared = await openDb();
    await shared.db.insert(users).values({ email: "a@example.com", role: "admin" });

    const seen: string[] = [];
    const watched = await openDb({ onQuery: (statement) => seen.push(statement) });
    expect(await watched.db.select().from(users)).toEqual([]);
    expect(seen.some((statement) => /from "users"/.test(statement))).toBe(true);

    // The same address again: no clash with the shared instance's row, and
    // the shared instance never sees this one.
    await watched.db.insert(users).values({ email: "a@example.com", role: "admin" });
    expect((await shared.db.select().from(users)).map((u) => u.email)).toEqual(["a@example.com"]);
  });
});
