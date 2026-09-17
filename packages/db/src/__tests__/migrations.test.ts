import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../testing.js";
import { sessions, users } from "../schema.js";

/**
 * The migrations, executed against a real Postgres (pglite, in-process).
 *
 * These assert the things the design actually leans on and a fake store cannot
 * reproduce — the partial unique index, the enum swap, cascade on delete. If
 * `0001_accounts.sql` and `schema.ts` ever drift, this is what catches it.
 */
describe("0001_accounts", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("applies cleanly and leaves users + sessions", async () => {
    const rows = await t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
           where table_schema = 'public' and table_name in ('users', 'sessions')
           order by table_name`,
    );
    expect(rows.rows.map((r) => r.table_name)).toEqual(["sessions", "users"]);
  });

  it("carries the four cumulative roles, defaulting to the least privileged", async () => {
    const labels = await t.db.execute<{ enumlabel: string }>(
      sql`select enumlabel from pg_enum e
            join pg_type ty on ty.oid = e.enumtypid
           where ty.typname = 'user_role' order by e.enumsortorder`,
    );
    expect(labels.rows.map((r) => r.enumlabel)).toEqual([
      "read_only",
      "requester",
      "approver",
      "admin",
    ]);

    const [created] = await t.db.insert(users).values({ email: "nobody@example.com" }).returning();
    expect(created?.role).toBe("read_only");
    expect(created?.status).toBe("active");
  });

  it("drops is_suspended in favour of status", async () => {
    const cols = await t.db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns
           where table_name = 'users' and column_name in ('is_suspended', 'status')`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(["status"]);
  });

  it("rejects a duplicate email among active accounts", async () => {
    await t.db.insert(users).values({ email: "dup@example.com" });
    await expect(t.db.insert(users).values({ email: "DUP@example.com" })).rejects.toThrow();
  });

  it("frees a removed person's email for a fresh account", async () => {
    const [first] = await t.db.insert(users).values({ email: "leaver@example.com" }).returning();
    await t.db.execute(
      sql`update users set status = 'removed', removed_at = now() where id = ${first!.id}`,
    );

    // The whole point of the partial index: this must not throw.
    const [second] = await t.db.insert(users).values({ email: "leaver@example.com" }).returning();
    expect(second?.id).not.toBe(first?.id);
    expect(second?.status).toBe("active");
  });

  it("cascades sessions when a user row is deleted", async () => {
    const [u] = await t.db.insert(users).values({ email: "s@example.com" }).returning();
    await t.db.insert(sessions).values({
      userId: u!.id,
      expiresAt: new Date(Date.now() + 60_000),
      authMethod: "password",
    });
    await t.db.execute(sql`delete from users where id = ${u!.id}`);

    const left = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from sessions`);
    expect(left.rows[0]?.n).toBe(0);
  });
});

/**
 * The Magma Devs account marker (MAG-2729, decided 26 Aug 2026). What matters
 * about this column is its default: every account that is not the managed
 * first-run one must come out false, or the label stops meaning anything.
 */
describe("0005_magma_account", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("defaults to false, so an account is never ours by accident", async () => {
    const [u] = await t.db.insert(users).values({ email: "customer@example.com" }).returning();
    expect(u?.isMagmaAccount).toBe(false);
  });

  it("is not nullable — 'unknown whose account this is' is not a state", async () => {
    const col = await t.db.execute<{ is_nullable: string; data_type: string }>(
      sql`select is_nullable, data_type from information_schema.columns
           where table_name = 'users' and column_name = 'is_magma_account'`,
    );
    expect(col.rows[0]).toEqual({ is_nullable: "NO", data_type: "boolean" });
  });

  it("backfills existing rows false", async () => {
    // A deployment that predates the column has no marked account to find:
    // on-prem never had one, and a managed install's operator account was
    // created before anything recorded provenance.
    await t.db.execute(sql`insert into users (email) values ('legacy@example.com')`);
    const rows = await t.db.execute<{ is_magma_account: boolean }>(
      sql`select is_magma_account from users where email = 'legacy@example.com'`,
    );
    expect(rows.rows[0]?.is_magma_account).toBe(false);
  });
});
