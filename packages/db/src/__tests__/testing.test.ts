import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { users } from "../schema.js";
import { createTestDb, type TestDb } from "../testing.js";

/**
 * The contract every db-backed test in the repo leans on: `createTestDb()`
 * hands back a database with every migration applied and nothing else in it.
 * Pinned here so a change to how instances are made (they load from a cached
 * snapshot rather than running `initdb`) cannot quietly hand a test a stale
 * schema or another test's rows.
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

  it("gives each caller its own database", async () => {
    const a = await openDb();
    const b = await openDb();
    await a.db.insert(users).values({ email: "a@example.com", role: "admin" });
    expect(await b.db.select().from(users)).toEqual([]);
  });

  it("starts empty", async () => {
    const t = await openDb();
    expect(await t.db.select().from(users)).toEqual([]);
  });

  it("reports every statement to onQuery", async () => {
    const seen: string[] = [];
    const t = await openDb({ onQuery: (statement) => seen.push(statement) });
    await t.db.select().from(users);
    expect(seen.some((statement) => /from "users"/.test(statement))).toBe(true);
  });
});
