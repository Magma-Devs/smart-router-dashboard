import { getTableName, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { auditEventChanges, auditEvents } from "./schema-audit.js";

/**
 * The runtime role — the database role the api serves requests as when the
 * deployment gives it one beside the role that owns the schema.
 *
 * The append-only trigger on the audit log stops a stray `UPDATE` or `DELETE`,
 * and it is not a boundary against whoever holds the credential: any role with
 * `DELETE` on the table opens the retention hatch with
 * `SET LOCAL audit.purge = 'on'` (a custom setting any role may set), and the
 * table's owner can drop the trigger outright. So the log is only as
 * tamper-resistant as the privileges of the role on the request path. With one
 * credential that role owns everything; with two, the request path holds this
 * one, which may read and append to the audit log and do nothing else to it:
 *
 *   - every table in `public`: SELECT, INSERT, UPDATE, DELETE
 *   - the audit tables (`AUDIT_TABLES`): SELECT, INSERT only — no UPDATE or
 *     DELETE (the hatch needs one of them), no TRUNCATE (row triggers never
 *     fire on it), no REFERENCES, no TRIGGER
 *   - every sequence in `public`: USAGE (a `bigserial` insert calls nextval)
 *   - schema `public`: USAGE
 *   - ownership of nothing: not of a table (the trigger), not of the schema
 *     (a schema's owner may drop any table in it — on Postgres 15 and later
 *     the database owner owns `public`), and no membership of a role that
 *     owns one or of a superuser.
 *
 * **Granted by the migration step, not by provisioning.** A later migration
 * adds tables, and the runtime role cannot touch a table nobody granted it.
 * `ALTER DEFAULT PRIVILEGES` on the provisioning side would cover new tables
 * and would also hand `DELETE` to any audit table a migration adds, with the
 * exception living in a repository that does not know which tables those are.
 * Here the owner — right after migrating, with every table in place — grants
 * the runtime role exactly the set above, and the exception sits beside the
 * schema that defines the audit tables. The pass converges rather than adds:
 * it revokes everything the role holds in `public` first, so a privilege
 * granted by hand or by an older shape is removed, and then checks the result
 * from the catalog and refuses (`RuntimeRoleError`) when the role could still
 * alter the log or lacks what the api needs.
 */

/** The append-only tables: the runtime role may read and append, nothing else.
 *  Every table carrying the `audit_append_only()` trigger — a test pins the two
 *  lists equal. `audit_tokens` is NOT one: it is mutable state (a token's last
 *  use and its revocation are updates). */
export const AUDIT_TABLES: readonly string[] = [getTableName(auditEvents), getTableName(auditEventChanges)];

/** What the runtime role holds on every other table in `public`. */
export const RUNTIME_TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/** What it holds on an audit table. */
export const RUNTIME_AUDIT_PRIVILEGES = ["SELECT", "INSERT"] as const;

/** What it must never be able to use on an audit table, by any role it can
 *  become. UPDATE and DELETE are what the retention hatch lets through;
 *  TRUNCATE empties a table without firing a row trigger; REFERENCES and
 *  TRIGGER attach objects of its own to the table. */
export const AUDIT_FORBIDDEN_PRIVILEGES = ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

/** The schema the migrations build in. `drizzle` (the migrator's bookkeeping)
 *  is deliberately left out: the runtime role never reads it. */
const SCHEMA = "public";

/** Serialises the pass between backends that boot at the same moment: two
 *  concurrent GRANTs on one table fail with "tuple concurrently updated". */
const GRANT_LOCK_KEY = 4444_0001;

/** Raised when the runtime role cannot be given its shape — it could still
 *  alter the audit log, it lacks a privilege the api needs, or the role running
 *  the pass cannot grant on a table. Nothing the pass granted is kept: it runs
 *  in one transaction, which this rolls back. */
export class RuntimeRoleError extends Error {
  constructor(
    readonly role: string,
    readonly problems: readonly string[],
  ) {
    super(`refusing ${JSON.stringify(role)} as the runtime role: ${problems.join("; ")}`);
    this.name = "RuntimeRoleError";
  }
}

export interface RuntimeGrantReport {
  /** The runtime role the pass granted to. */
  role: string;
  /** The role the pass ran as — the one that owns the schema. */
  owner: string;
  /** Tables the runtime role reads and writes. */
  tables: string[];
  /** Tables it may only read and append to. */
  appendOnly: string[];
}

/** The role a connection acts as — what every privilege check is made against. */
export async function currentRole(db: Database): Promise<string> {
  const rows = rowsOf<{ role?: unknown }>(await db.execute(sql`select current_user::text as role`));
  const role = rows[0]?.role;
  if (typeof role !== "string" || role === "") throw new Error("could not read current_user");
  return role;
}

/**
 * Give `role` the runtime shape described above, as the role `owner` is
 * connected as, and prove it from the catalog. Idempotent; one transaction.
 * Throws `RuntimeRoleError` (and grants nothing) when the result would let the
 * runtime role alter the audit log, or leaves it short of what the api needs.
 */
export async function grantRuntimeRole(owner: Database, role: string): Promise<RuntimeGrantReport> {
  return await owner.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${GRANT_LOCK_KEY})`);
    const self = await currentRole(tx);

    const exists = rowsOf(await tx.execute(sql`select 1 from pg_roles where rolname = ${role}`));
    if (exists.length === 0) throw new RuntimeRoleError(role, ["no such role"]);
    if (role === self) {
      throw new RuntimeRoleError(role, [
        "it is the role that runs the migrations; the runtime role must be a different role",
      ]);
    }

    const tables = rowsOf<{ name: string; owned_by: string; ours: boolean }>(
      await tx.execute(sql`
        select c.relname::text as name, pg_get_userbyid(c.relowner)::text as owned_by,
               pg_has_role(current_user, c.relowner, 'USAGE') as ours
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = ${SCHEMA} and c.relkind in ('r', 'p')
         order by 1`),
    );
    const names = tables.map((t) => t.name);
    const missing = AUDIT_TABLES.filter((t) => !names.includes(t));
    if (missing.length > 0) {
      throw new RuntimeRoleError(role, [`the audit tables ${missing.join(", ")} do not exist in ${SCHEMA}`]);
    }
    // A GRANT or REVOKE on another role's table fails or only warns. Say which
    // table and whose it is, rather than let either surface as a puzzle.
    const foreign = tables.filter((t) => !t.ours);
    if (foreign.length > 0) {
      throw new RuntimeRoleError(role, [
        `${self}, the role running the migrations, does not own ${foreign.map((t) => `${t.name} (owned by ${t.owned_by})`).join(", ")}, so it cannot grant on it`,
      ]);
    }

    const grantee = sql.identifier(role);
    const schema = sql.identifier(SCHEMA);
    await tx.execute(sql`grant usage on schema ${schema} to ${grantee}`);
    await tx.execute(sql`revoke all on all tables in schema ${schema} from ${grantee}`);
    await tx.execute(sql`revoke all on all sequences in schema ${schema} from ${grantee}`);
    for (const table of names) {
      const privileges = AUDIT_TABLES.includes(table) ? RUNTIME_AUDIT_PRIVILEGES : RUNTIME_TABLE_PRIVILEGES;
      await tx.execute(
        sql`grant ${sql.raw(privileges.join(", "))} on table ${schema}.${sql.identifier(table)} to ${grantee}`,
      );
    }
    await tx.execute(sql`grant usage on all sequences in schema ${schema} to ${grantee}`);

    const problems = await separationProblems(tx, role, names);
    if (problems.length > 0) throw new RuntimeRoleError(role, problems);

    return {
      role,
      owner: self,
      tables: names.filter((t) => !AUDIT_TABLES.includes(t)),
      appendOnly: names.filter((t) => AUDIT_TABLES.includes(t)),
    };
  });
}

/**
 * Everything that stops `role` from having the runtime shape, read back from
 * the catalog after the grants — empty when it has it.
 *
 * The effective privileges are what count, not the statements that ran. And
 * the forbidden side is checked through every role `role` can become, not only
 * its own grants: `SET ROLE` to a role that owns the table, or holds DELETE on
 * it, is the same purge by another name.
 */
async function separationProblems(tx: Database, role: string, tables: string[]): Promise<string[]> {
  const problems: string[] = [];
  const r = sql`${role}::name`;

  const superuser = rowsOf<{ name: string }>(
    await tx.execute(sql`
      select rolname::text as name from pg_roles
       where rolsuper and pg_has_role(${r}, oid, 'MEMBER') order by 1`),
  );
  if (superuser.length > 0) {
    problems.push(`it is, or can become, a superuser (${superuser.map((s) => s.name).join(", ")})`);
  }

  const schemaFacts = rowsOf<{ usage: boolean; acts_as_owner: boolean; owned_by: string }>(
    await tx.execute(sql`
      select has_schema_privilege(${r}, n.oid, 'USAGE') as usage,
             pg_has_role(${r}, n.nspowner, 'MEMBER') as acts_as_owner,
             pg_get_userbyid(n.nspowner)::text as owned_by
        from pg_namespace n where n.nspname = ${SCHEMA}`),
  );
  if (!schemaFacts[0]?.usage) problems.push(`it has no USAGE on schema ${SCHEMA}`);
  if (schemaFacts[0]?.acts_as_owner) {
    problems.push(
      `it is, or can become, ${schemaFacts[0].owned_by}, the owner of schema ${SCHEMA}, which may drop any table in it (on Postgres 15 and later the database's owner owns ${SCHEMA})`,
    );
  }

  const owners = rowsOf<{ owned_by: string; tables: string }>(
    await tx.execute(sql`
      select pg_get_userbyid(c.relowner)::text as owned_by,
             string_agg(c.relname::text, ', ' order by c.relname) as tables
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = ${SCHEMA} and c.relname::text = any(${textArray(AUDIT_TABLES)})
         and pg_has_role(${r}, c.relowner, 'MEMBER')
       group by c.relowner`),
  );
  for (const o of owners) {
    problems.push(`it is, or can become, ${o.owned_by}, the owner of ${o.tables}, which may drop the append-only trigger`);
  }

  const held = rowsOf<{ name: string; privilege: string }>(
    await tx.execute(sql`
      select c.relname::text as name, p.privilege
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(privilege)
       where n.nspname = ${SCHEMA} and c.relkind in ('r', 'p')
         and has_table_privilege(${r}, c.oid, p.privilege)`),
  );
  const sequences = rowsOf<{ name: string }>(
    await tx.execute(sql`
      select c.relname::text as name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = ${SCHEMA} and c.relkind = 'S'
         -- Guarded: WHERE has no evaluation order, and the function raises
         -- on any relation that is not a sequence.
         and case when c.relkind = 'S' then not has_sequence_privilege(${r}, c.oid, 'USAGE') else false end`),
  );
  if (sequences.length > 0) {
    problems.push(`it lacks USAGE on the sequences ${sequences.map((s) => s.name).join(", ")}`);
  }
  // Every (audit table, forbidden privilege, role) where `role` can become
  // that role — itself included — and that role holds the privilege. UPDATE
  // and REFERENCES also exist per column, which has_table_privilege does not
  // see: UPDATE on `note` alone is enough to rewrite a row under the hatch.
  const reachable = rowsOf<{ name: string; privilege: string; via: string }>(
    await tx.execute(sql`
      select c.relname::text as name, p.privilege, g.rolname::text as via
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join unnest(${textArray(AUDIT_FORBIDDEN_PRIVILEGES)}) as p(privilege)
        join pg_roles g on pg_has_role(${r}, g.oid, 'MEMBER')
       where n.nspname = ${SCHEMA} and c.relname::text = any(${textArray(AUDIT_TABLES)})
         and case when p.privilege in ('UPDATE', 'REFERENCES')
                  then has_any_column_privilege(g.oid, c.oid, p.privilege)
                  else has_table_privilege(g.oid, c.oid, p.privilege) end`),
  );

  for (const table of tables) {
    const audit = AUDIT_TABLES.includes(table);
    const want: readonly string[] = audit ? RUNTIME_AUDIT_PRIVILEGES : RUNTIME_TABLE_PRIVILEGES;
    const lacking = want.filter((p) => !held.some((h) => h.name === table && h.privilege === p));
    if (lacking.length > 0) problems.push(`it lacks ${lacking.join(", ")} on ${table}`);
    if (!audit) continue;
    const forbidden = AUDIT_FORBIDDEN_PRIVILEGES.flatMap((privilege) => {
      const via = reachable.filter((h) => h.name === table && h.privilege === privilege).map((h) => h.via);
      if (via.length === 0) return [];
      return [via.includes(role) ? privilege : `${privilege} (as ${via.sort().join(" or ")})`];
    });
    if (forbidden.length > 0) problems.push(`it can use ${forbidden.join(", ")} on ${table}`);
  }
  return problems;
}

/** A `text[]` of constants, each bound as a parameter. */
function textArray(values: readonly string[]) {
  return sql`array[${sql.join(
    values.map((v) => sql`${v}::text`),
    sql`, `,
  )}]`;
}

/** The two drivers disagree on the shape of a raw result: postgres-js returns
 *  the rows as an array, pglite wraps them in `{ rows }`. */
function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  return ((Array.isArray(result) ? result : (result as { rows?: unknown[] } | null)?.rows) ?? []) as T[];
}
