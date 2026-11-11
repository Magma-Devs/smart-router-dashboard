import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import type { Database } from "../client.js";
import { createAuditWriter } from "../audit.js";
import { auditEventChanges, auditEvents } from "../schema-audit.js";
import { users } from "../schema.js";
import {
  AUDIT_FORBIDDEN_PRIVILEGES,
  AUDIT_TABLES,
  currentRole,
  grantRuntimeRole,
  RuntimeRoleError,
} from "../runtime-role.js";

/**
 * The two-role split, against a real Postgres (pglite, in-process) — the
 * privilege system is the whole subject, and a fake store has none.
 *
 * Built the way a deployment is: an owner role that owns the database runs
 * every migration, so it owns every table, and a second role (`sr_app`) is
 * granted the runtime shape by `grantRuntimeRole`. pglite is one session, so
 * "connecting as" a role is `SET ROLE` — privilege checks run against
 * `current_user` either way, which is what these assert. The shared migrated
 * snapshot is no use here (its tables belong to the bootstrap superuser), so
 * this file builds its own database once and runs every case against it; each
 * case undoes what it changes.
 */

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const OWNER = "sr_owner";
const RUNTIME = "sr_app";

let client: PGlite;
let db: Database;

/** Run `fn` as `role` (`SET ROLE`), back to the superuser afterwards. */
async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await client.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await client.exec("reset role");
  }
}

/** The Postgres error behind drizzle's `Failed query` wrapper. */
async function pgErrorOf(query: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await query;
  } catch (err) {
    const cause = (err as { cause?: Record<string, unknown> }).cause ?? (err as Record<string, unknown>);
    return { message: String(cause.message ?? (err as Error).message), code: cause.code as string | undefined };
  }
  throw new Error("expected the query to be rejected, but it succeeded");
}

/** Privileges `role` holds on `table`, as the catalog reports them. */
async function privilegesOf(role: string, table: string): Promise<string[]> {
  const { rows } = await client.query<{ privilege: string }>(
    `select p.privilege from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(privilege)
      where has_table_privilege($1, $2, p.privilege) order by 1`,
    [role, `public.${table}`],
  );
  return rows.map((r) => r.privilege);
}

async function auditRowCount(): Promise<number> {
  const { rows } = await client.query<{ n: number }>("select count(*)::int as n from audit_events");
  return rows[0]!.n;
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  // What provisioning creates: the owner owns the database, so on Postgres 15
  // and later it owns `public` too; the runtime role owns nothing.
  await client.exec(`
    create role ${OWNER} nologin;
    create role ${RUNTIME} nologin;
    do $$ begin execute format('alter database %I owner to ${OWNER}', current_database()); end $$;
  `);
  await as(OWNER, () => migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS }));
  await as(OWNER, () => grantRuntimeRole(db, RUNTIME));
});

afterAll(async () => {
  await client.close();
});

describe("grantRuntimeRole", () => {
  it("grants DML on every table, and only SELECT and INSERT on the audit tables", async () => {
    const report = await as(OWNER, () => grantRuntimeRole(db, RUNTIME));
    expect(report.role).toBe(RUNTIME);
    expect(report.owner).toBe(OWNER);
    expect(report.appendOnly).toEqual([...AUDIT_TABLES].sort());
    expect(report.tables).toEqual(
      expect.arrayContaining(["users", "sessions", "invitations", "password_resets", "audit_tokens"]),
    );
    for (const table of report.tables) {
      expect(await privilegesOf(RUNTIME, table), table).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    }
    for (const table of AUDIT_TABLES) {
      expect(await privilegesOf(RUNTIME, table), table).toEqual(["INSERT", "SELECT"]);
    }
  });

  it("names the role a connection acts as", async () => {
    expect(await as(RUNTIME, () => currentRole(db))).toBe(RUNTIME);
  });

  it("is idempotent", async () => {
    const before = await Promise.all(AUDIT_TABLES.map((t) => privilegesOf(RUNTIME, t)));
    await as(OWNER, () => grantRuntimeRole(db, RUNTIME));
    await as(OWNER, () => grantRuntimeRole(db, RUNTIME));
    expect(await Promise.all(AUDIT_TABLES.map((t) => privilegesOf(RUNTIME, t)))).toEqual(before);
  });

  it("converges: a privilege granted outside it is taken away again", async () => {
    await client.exec(`
      grant update, delete, truncate, references, trigger on audit_events to ${RUNTIME};
      grant truncate, references on users to ${RUNTIME};
    `);
    expect(await privilegesOf(RUNTIME, "audit_events")).toContain("DELETE");
    await as(OWNER, () => grantRuntimeRole(db, RUNTIME));
    expect(await privilegesOf(RUNTIME, "audit_events")).toEqual(["INSERT", "SELECT"]);
    expect(await privilegesOf(RUNTIME, "users")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });

  it("converges on column privileges too: UPDATE on one column of the log is taken away", async () => {
    await client.exec(`grant update (note) on audit_events to ${RUNTIME}`);
    const column = async () =>
      (
        await client.query<{ ok: boolean }>(
          `select has_any_column_privilege($1, 'public.audit_events', 'UPDATE') as ok`,
          [RUNTIME],
        )
      ).rows[0]!.ok;
    expect(await column()).toBe(true);
    await as(OWNER, () => grantRuntimeRole(db, RUNTIME));
    expect(await column()).toBe(false);
  });

  it("covers a table a later migration adds, sequence included", async () => {
    await as(OWNER, () =>
      db.execute(sql`create table later_feature (id bigserial primary key, note text)`),
    );
    try {
      // Before the pass the runtime role cannot touch it — the reason the pass
      // runs after every migration rather than once at provisioning.
      expect((await pgErrorOf(as(RUNTIME, () => db.execute(sql`select * from later_feature`)))).code).toBe("42501");
      await as(OWNER, () => grantRuntimeRole(db, RUNTIME));
      await as(RUNTIME, async () => {
        await db.execute(sql`insert into later_feature (note) values ('a')`);
        await db.execute(sql`update later_feature set note = 'b'`);
        await db.execute(sql`delete from later_feature`);
      });
    } finally {
      await as(OWNER, () => db.execute(sql`drop table later_feature`));
    }
  });
});

describe("serving as the runtime role", () => {
  it("does what the api does: account writes and audit appends", async () => {
    await as(RUNTIME, async () => {
      const [user] = await db.insert(users).values({ email: "dana@example.com", name: "Dana" }).returning();
      await db.update(users).set({ name: "Dana Levi" }).where(sql`${users.id} = ${user!.id}`);
      await db.transaction(async (tx) => {
        await createAuditWriter(tx).write(
          {
            action: "member.role_changed",
            actor: { id: user!.id, kind: "user" },
            target: { type: "member", id: user!.id, name: "Dana Levi" },
            changes: [{ field: "role", from: "read_only", to: "admin" }],
          },
          tx,
        );
      });
      await db.delete(users).where(sql`${users.id} = ${user!.id}`);
    });
    expect(await auditRowCount()).toBeGreaterThan(0);
    const changes = await db.select().from(auditEventChanges);
    expect(changes.length).toBeGreaterThan(0);
  });

  it("cannot delete, update or truncate an audit row", async () => {
    const before = await auditRowCount();
    for (const table of AUDIT_TABLES) {
      for (const statement of [
        `delete from ${table}`,
        `update ${table} set ${table === "audit_events" ? "note" : "field"} = 'x'`,
        `truncate ${table}`,
        `truncate ${table} cascade`,
      ]) {
        const err = await pgErrorOf(as(RUNTIME, () => db.execute(sql.raw(statement))));
        expect(err.code, statement).toBe("42501");
        expect(err.message, statement).toMatch(/permission denied/);
      }
    }
    expect(await auditRowCount()).toBe(before);
  });

  it("cannot open the retention hatch: SET LOCAL audit.purge changes nothing", async () => {
    const before = await auditRowCount();
    const err = await pgErrorOf(
      as(RUNTIME, () =>
        db.transaction(async (tx) => {
          await tx.execute(sql`set local audit.purge = 'on'`);
          await tx.execute(sql`delete from audit_events`);
        }),
      ),
    );
    expect(err.code).toBe("42501");
    expect(await auditRowCount()).toBe(before);
  });

  it("cannot drop or disable the append-only trigger, or drop the table", async () => {
    for (const statement of [
      "drop trigger audit_events_append_only on audit_events",
      "alter table audit_events disable trigger audit_events_append_only",
      "alter table audit_event_changes disable trigger all",
      "drop table audit_event_changes",
      "drop function audit_append_only() cascade",
    ]) {
      const err = await pgErrorOf(as(RUNTIME, () => db.execute(sql.raw(statement))));
      expect(err.code, statement).toBe("42501");
      expect(err.message, statement).toMatch(/must be owner/);
    }
  });

  it("leaves the hatch to the owner, which is where the erasure runbook runs", async () => {
    await as(RUNTIME, () =>
      createAuditWriter(db).write({ action: "signin.succeeded", actor: { id: null, kind: "system" } }),
    );
    const before = await auditRowCount();
    await as(OWNER, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local audit.purge = 'on'`);
        await tx.execute(sql`delete from audit_events where action = 'signin.succeeded'`);
      }),
    );
    expect(await auditRowCount()).toBeLessThan(before);
  });
});

describe("what grantRuntimeRole refuses", () => {
  /** The RuntimeRoleError a pass for `role`, run as the owner, refuses with. */
  async function refusal(role: string): Promise<RuntimeRoleError> {
    try {
      await as(OWNER, () => grantRuntimeRole(db, role));
    } catch (err) {
      if (err instanceof RuntimeRoleError) return err;
      throw err;
    }
    throw new Error("expected grantRuntimeRole to refuse");
  }

  it("the role that runs the migrations", async () => {
    expect((await refusal(OWNER)).message).toMatch(/must be a different role/);
  });

  it("a role that does not exist", async () => {
    expect((await refusal("nobody_here")).problems).toEqual(["no such role"]);
  });

  it("a role that can become the owner, and grants nothing when it refuses", async () => {
    await client.exec(`grant ${OWNER} to ${RUNTIME}`);
    try {
      const err = await refusal(RUNTIME);
      expect(err.message).toMatch(
        /can become, sr_owner, the owner of audit_event_changes, audit_events, which may drop the append-only trigger/,
      );
      // Inherited, so its own: the privilege needs no SET ROLE to use.
      expect(err.message).toMatch(/it can use UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on audit_events/);
    } finally {
      await client.exec(`revoke ${OWNER} from ${RUNTIME}`);
    }
    // The refused pass rolled back; the role is as the last good pass left it.
    expect(await privilegesOf(RUNTIME, "audit_events")).toEqual(["INSERT", "SELECT"]);
  });

  it("a role that reaches DELETE on the log through a group", async () => {
    await client.exec(`create role sr_purgers nologin`);
    await as(OWNER, () => db.execute(sql`grant delete on audit_events to sr_purgers`));
    await client.exec(`grant sr_purgers to ${RUNTIME} with inherit false`);
    try {
      expect((await refusal(RUNTIME)).message).toMatch(/can use DELETE \(as sr_purgers\) on audit_events/);
    } finally {
      await client.exec(`revoke sr_purgers from ${RUNTIME}`);
      await as(OWNER, () => db.execute(sql`revoke all on audit_events from sr_purgers`));
      await client.exec(`drop role sr_purgers`);
    }
  });

  it("a role that reaches UPDATE on a single column of the log through a group", async () => {
    await client.exec(`create role sr_editors nologin`);
    await as(OWNER, () => db.execute(sql`grant update (note) on audit_events to sr_editors`));
    await client.exec(`grant sr_editors to ${RUNTIME}`);
    try {
      expect((await refusal(RUNTIME)).message).toMatch(/can use UPDATE on audit_events/);
    } finally {
      await client.exec(`revoke sr_editors from ${RUNTIME}`);
      await as(OWNER, () => db.execute(sql`revoke all on audit_events from sr_editors`));
      await client.exec(`drop role sr_editors`);
    }
  });

  it("a role that owns the database, and with it schema public", async () => {
    await client.exec(`create role sr_db_owner nologin`);
    await client.exec(`do $$ begin execute format('alter database %I owner to sr_db_owner', current_database()); end $$`);
    try {
      expect((await refusal("sr_db_owner")).message).toMatch(
        /can become, pg_database_owner, the owner of schema public, which may drop any table in it/,
      );
    } finally {
      await client.exec(`do $$ begin execute format('alter database %I owner to ${OWNER}', current_database()); end $$`);
      await client.exec(`drop role sr_db_owner`);
    }
  });

  it("a superuser", async () => {
    await client.exec(`create role sr_root superuser nologin`);
    try {
      expect((await refusal("sr_root")).message).toMatch(/it is, or can become, a superuser \([^)]*sr_root[^)]*\)/);
    } finally {
      await client.exec(`drop role sr_root`);
    }
  });

  it("a table in public the migration role does not own", async () => {
    await client.exec(`create table someone_elses (id int)`);
    try {
      expect((await refusal(RUNTIME)).message).toMatch(
        /sr_owner, the role running the migrations, does not own someone_elses \(owned by postgres\)/,
      );
    } finally {
      await client.exec(`drop table someone_elses`);
    }
  });
});

describe("what the pass assumes about the migrations", () => {
  it("names exactly the tables that carry the append-only trigger", async () => {
    const { rows } = await client.query<{ name: string }>(`
      select distinct c.relname::text as name
        from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
       where p.proname = 'audit_append_only' and not t.tgisinternal
       order by 1`);
    expect(rows.map((r) => r.name)).toEqual([...AUDIT_TABLES].sort());
  });

  it("finds only tables, sequences and indexes in public, one function, and no other schema", async () => {
    // The pass grants on tables and sequences in `public`. A migration that
    // adds a view, a partitioned table, another schema or a function the api
    // calls needs runtime-role.ts extended first — this is where that shows.
    const kinds = await client.query<{ relkind: string }>(
      `select distinct c.relkind::text as relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' order by 1`,
    );
    expect(kinds.rows.map((r) => r.relkind)).toEqual(["S", "i", "r"]);
    const schemas = await client.query<{ name: string }>(
      `select nspname::text as name from pg_namespace
        where nspname not like 'pg\\_%' and nspname <> 'information_schema' order by 1`,
    );
    expect(schemas.rows.map((r) => r.name)).toEqual(["drizzle", "public"]);
    const functions = await client.query<{ name: string }>(
      `select p.proname::text as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' order by 1`,
    );
    expect(functions.rows.map((r) => r.name)).toEqual(["audit_append_only"]);
  });

  it("forbids every privilege that reaches a row without a row trigger", () => {
    expect([...AUDIT_FORBIDDEN_PRIVILEGES].sort()).toEqual(["DELETE", "REFERENCES", "TRIGGER", "TRUNCATE", "UPDATE"]);
  });

  it("leaves the audit rows readable by the runtime role", async () => {
    const rows = await as(RUNTIME, () => db.select().from(auditEvents).limit(1));
    expect(Array.isArray(rows)).toBe(true);
  });
});
