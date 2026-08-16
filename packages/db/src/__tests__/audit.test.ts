import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../testing.js";
import { createAuditWriter, type AuditViolation } from "../audit.js";
import { auditEventChanges, auditEvents } from "../schema-audit.js";
import { users } from "../schema.js";

/**
 * The audit log, against a real Postgres (pglite, in-process).
 *
 * What is worth testing here is precisely what a fake store cannot reproduce:
 * the append-only triggers, the retention escape hatch that has to punch through
 * them, and the CHECK constraint that stops a config row carrying an address.
 * The catalog and the redaction rules are pure functions and are tested in
 * `@sr/shared`.
 */

let t: TestDb;
let violations: AuditViolation[];

/**
 * Drizzle wraps a driver error as `Failed query: …` and hangs the real one off
 * `cause`, so asserting on `.message` tests the wrapper rather than the
 * database. Unwrap to the Postgres error itself — its `code` and `constraint`
 * are what actually pin the behaviour.
 */
async function pgErrorOf(
  query: Promise<unknown>,
): Promise<{ message: string; code?: string; constraint?: string }> {
  try {
    await query;
  } catch (err) {
    const cause = (err as { cause?: Record<string, unknown> }).cause ?? {};
    return {
      message: String(cause.message ?? (err as Error).message),
      code: cause.code as string | undefined,
      constraint: cause.constraint as string | undefined,
    };
  }
  throw new Error("expected the query to be rejected, but it succeeded");
}

function writer() {
  return createAuditWriter(t.db, { onViolation: (v) => violations.push(v) });
}

async function seedUser(email: string, name: string | null): Promise<string> {
  const [row] = await t.db.insert(users).values({ email, name }).returning({ id: users.id });
  return row!.id;
}

beforeEach(async () => {
  t = await createTestDb();
  violations = [];
});
afterEach(async () => {
  await t.close();
});

/**
 * Shape pins, mirroring `schema.test.ts`. The case is stronger here than for
 * `users`: `0002_audit.sql` and `schema-audit.ts` are two hand-written
 * descriptions of the same two tables, and nothing else compares them. A
 * snake_case typo on a column no query happens to read — `request_id`,
 * `actor_email`, `target_type` — would typecheck cleanly and fail at runtime in
 * whichever slice first tried to use it.
 */
describe("audit schema", () => {
  it("names the tables the migration creates", () => {
    expect(getTableName(auditEvents)).toBe("audit_events");
    expect(getTableName(auditEventChanges)).toBe("audit_event_changes");
  });

  it("carries every column a row holds", () => {
    const cols = getTableColumns(auditEvents);
    for (const key of [
      "seq",
      "id",
      "occurredAt",
      "action",
      "actionGroup",
      "source",
      "actorKind",
      "actorUserId",
      "actorName",
      "actorEmail",
      "targetType",
      "targetId",
      "targetName",
      "requestId",
      "note",
      "ip",
      "client",
      "sessionId",
    ]) {
      expect(cols, `missing column mapping: ${key}`).toHaveProperty(key);
    }
  });

  it("maps camelCase properties to snake_case SQL names", () => {
    const cols = getTableColumns(auditEvents);
    expect(cols.occurredAt!.name).toBe("occurred_at");
    expect(cols.actionGroup!.name).toBe("action_group");
    expect(cols.actorKind!.name).toBe("actor_kind");
    expect(cols.actorUserId!.name).toBe("actor_user_id");
    expect(cols.actorName!.name).toBe("actor_name");
    expect(cols.actorEmail!.name).toBe("actor_email");
    expect(cols.targetType!.name).toBe("target_type");
    expect(cols.targetId!.name).toBe("target_id");
    expect(cols.targetName!.name).toBe("target_name");
    expect(cols.requestId!.name).toBe("request_id");
    expect(cols.sessionId!.name).toBe("session_id");

    const changes = getTableColumns(auditEventChanges);
    expect(changes.eventSeq!.name).toBe("event_seq");
    expect(changes.fromValue!.name).toBe("from_value");
    expect(changes.toValue!.name).toBe("to_value");
  });

  it("requires what a row cannot be honest without", () => {
    const cols = getTableColumns(auditEvents);
    // An event with no name, no time or no actor is not a record of anything.
    expect(cols.action!.notNull).toBe(true);
    expect(cols.actionGroup!.notNull).toBe(true);
    expect(cols.occurredAt!.notNull).toBe(true);
    expect(cols.actorKind!.notNull).toBe(true);
    expect(cols.actorName!.notNull).toBe(true);
    // Everything a row may legitimately lack.
    expect(cols.actorUserId!.notNull).toBe(false);
    expect(cols.targetType!.notNull).toBe(false);
    expect(cols.requestId!.notNull).toBe(false);
    expect(cols.ip!.notNull).toBe(false);

    const changes = getTableColumns(auditEventChanges);
    // "(none)" is a value; blank is not. Both sides are always written.
    expect(changes.fromValue!.notNull).toBe(true);
    expect(changes.toValue!.notNull).toBe(true);
  });

  /**
   * Every column the Drizzle schema declares must exist in the database with
   * the same name — the check that catches the two hand-written files drifting.
   */
  it("matches the columns the migration actually created", async () => {
    for (const [table, columns] of [
      [getTableName(auditEvents), getTableColumns(auditEvents)],
      [getTableName(auditEventChanges), getTableColumns(auditEventChanges)],
    ] as const) {
      const live = await t.db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns
             where table_schema = 'public' and table_name = ${table}`,
      );
      const actual = new Set(live.rows.map((r) => r.column_name));
      for (const col of Object.values(columns)) {
        expect(actual, `${table}.${col.name} declared but not in the migration`).toContain(
          col.name,
        );
      }
      expect(actual.size, `${table} has columns the schema does not declare`).toBe(
        Object.keys(columns).length,
      );
    }
  });
});

describe("0002_audit migration", () => {
  it("applies cleanly and leaves both audit tables", async () => {
    const rows = await t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
           where table_schema = 'public'
             and table_name in ('audit_events', 'audit_event_changes')
           order by table_name`,
    );
    expect(rows.rows.map((r) => r.table_name)).toEqual(["audit_event_changes", "audit_events"]);
  });

  it("refuses an update to a recorded event", async () => {
    await writer().write({ action: "signin.succeeded", actor: { id: null, kind: "system" } });
    const err = await pgErrorOf(t.db.execute(sql`update audit_events set action = 'signout'`));
    expect(err.message).toMatch(/append-only/);
    expect(err.code).toBe("23001"); // restrict_violation
  });

  it("refuses a delete of a recorded event", async () => {
    await writer().write({ action: "signin.succeeded", actor: { id: null, kind: "system" } });
    const err = await pgErrorOf(t.db.execute(sql`delete from audit_events`));
    expect(err.message).toMatch(/append-only/);
    expect(err.code).toBe("23001");
  });

  /**
   * The child guard is the one that is easy to miss: in normal operation the
   * parent trigger refuses first and the cascade never reaches the child, so an
   * unguarded child looks correct until the first purge.
   */
  it("refuses an update or delete of a change row directly", async () => {
    await writer().write({
      action: "member.role_changed",
      actor: { id: null, kind: "system" },
      changes: [{ field: "role", from: "requester", to: "approver" }],
    });
    const del = await pgErrorOf(t.db.execute(sql`delete from audit_event_changes`));
    expect(del.message).toMatch(/append-only.*audit_event_changes/);
    const upd = await pgErrorOf(t.db.execute(sql`update audit_event_changes set field = 'x'`));
    expect(upd.message).toMatch(/append-only/);
  });

  /**
   * Retention is the one legitimate writer. Deliberately exercised against an
   * event that HAS a diff — the cascade into the child table is what an
   * unguarded child trigger would abort on, and a bare event would pass while
   * the real sweep failed on its first interesting row.
   */
  it("lets the retention sweep delete an event and cascade its changes", async () => {
    await writer().write({
      action: "member.role_changed",
      actor: { id: null, kind: "system" },
      target: { type: "member", id: "u1", name: "Dana Levi" },
      changes: [
        { field: "role", from: "requester", to: "approver" },
        { field: "note", from: "(none)", to: "promoted" },
      ],
    });

    await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local audit.purge = 'on'`);
      await tx.execute(sql`delete from audit_events`);
    });

    const events = await t.db.select().from(auditEvents);
    const changes = await t.db.select().from(auditEventChanges);
    expect(events).toHaveLength(0);
    expect(changes).toHaveLength(0);
  });

  it("closes the purge gate again after the sweep's transaction ends", async () => {
    await writer().write({ action: "signin.succeeded", actor: { id: null, kind: "system" } });
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local audit.purge = 'on'`);
    });
    // SET LOCAL died with that transaction; the guard is back up.
    const err = await pgErrorOf(t.db.execute(sql`delete from audit_events`));
    expect(err.message).toMatch(/append-only/);
  });

  it("rejects access context on a config event even from a direct insert", async () => {
    const err = await pgErrorOf(
      t.db.execute(sql`
        insert into audit_events
          (action, action_group, source, actor_kind, actor_name, ip)
        values
          ('provider.edited', 'config', 'dashboard', 'user', 'Ron Katz', '84.229.11.6')
      `),
    );
    expect(err.constraint).toBe("audit_events_no_context_on_config");
    expect(err.code).toBe("23514"); // check_violation
  });
});

describe("createAuditWriter", () => {
  it("resolves the group and the source from the catalog, not the caller", async () => {
    await writer().write({
      action: "endpoint.providers.changed",
      actor: { id: null, kind: "system" },
      target: { type: "endpoint", id: "ep_8143", name: "eth-jsonrpc" },
    });

    const [row] = await t.db.select().from(auditEvents);
    expect(row?.actionGroup).toBe("config");
    expect(row?.source).toBe("system");
    expect(row?.actorKind).toBe("system");
  });

  it("records a person acting in the UI as source dashboard", async () => {
    const id = await seedUser("dana@customer.com", "Dana Levi");
    await writer().write({ action: "member.invited", actor: { id, kind: "user" } });

    const [row] = await t.db.select().from(auditEvents);
    expect(row?.source).toBe("dashboard");
  });

  /** Names are snapshots. This is what keeps a removed person in the log. */
  it("snapshots the actor's name and email off their row", async () => {
    const id = await seedUser("dana@customer.com", "Dana Levi");
    await writer().write({ action: "member.invited", actor: { id, kind: "user" } });

    const [row] = await t.db.select().from(auditEvents);
    expect(row?.actorName).toBe("Dana Levi");
    expect(row?.actorEmail).toBe("dana@customer.com");
    expect(row?.actorUserId).toBe(id);
  });

  it("keeps the snapshot after the person is renamed and removed", async () => {
    const id = await seedUser("dana@customer.com", "Dana Levi");
    await writer().write({ action: "member.invited", actor: { id, kind: "user" } });

    await t.db.execute(
      sql`update users set name = 'Dana Cohen', status = 'removed', removed_at = now() where id = ${id}`,
    );

    const [row] = await t.db.select().from(auditEvents);
    // Reading through a join would now say "Dana Cohen" and hide the rename.
    expect(row?.actorName).toBe("Dana Levi");
  });

  it("falls back to the email when a user row has no display name", async () => {
    const id = await seedUser("nameless@customer.com", null);
    await writer().write({ action: "member.invited", actor: { id, kind: "user" } });

    const [row] = await t.db.select().from(auditEvents);
    expect(row?.actorName).toBe("nameless@customer.com");
  });

  /** A failed sign-in against an address with no account. */
  it("records the typed address as the actor label when there is no user", async () => {
    await writer().write({
      action: "signin.failed",
      actor: { id: null, kind: "user", label: "attacker@elsewhere.com" },
      note: "unknown address",
      access: { ip: "84.229.11.6", client: "Chrome 141 / macOS", sessionId: null },
    });

    const [row] = await t.db.select().from(auditEvents);
    expect(row?.actorName).toBe("attacker@elsewhere.com");
    expect(row?.actorUserId).toBeNull();
    expect(row?.note).toBe("unknown address");
    expect(row?.ip).toBe("84.229.11.6");
    expect(row?.client).toBe("Chrome 141 / macOS");
  });

  it("never leaves the actor blank", async () => {
    await writer().write({ action: "invite.expired", actor: { id: null, kind: "system" } });
    const [row] = await t.db.select().from(auditEvents);
    expect(row?.actorName).toBe("(system)");
  });

  /**
   * MAG-2730's done-when is that a recovery command "shows up in the audit log
   * naming who ran it". `label` is mandatory on a host actor at the type level,
   * so the anonymous version of this row cannot be written — the CLI that
   * produces it belongs to another ticket, which is exactly where a
   * remember-to-pass-this rule would have been dropped.
   */
  it("records who ran a host recovery command", async () => {
    await writer().write({
      action: "host.recovery",
      actor: { kind: "host", label: "ops@magmadevs.com (reset-2fa)" },
      target: { type: "member", id: "u1", name: "Dana Levi" },
    });

    const [row] = await t.db.select().from(auditEvents);
    expect(row?.source).toBe("host");
    expect(row?.actorKind).toBe("host");
    expect(row?.actorName).toBe("ops@magmadevs.com (reset-2fa)");
    // No browser, so nothing to record about one.
    expect(row?.ip).toBeNull();
    expect(row?.sessionId).toBeNull();
  });

  it("ignores a label when the id resolves to a real person", async () => {
    const id = await seedUser("dana@customer.com", "Dana Levi");
    await writer().write({
      action: "member.invited",
      actor: { id, kind: "user", label: "stale@example.com" },
    });
    const [row] = await t.db.select().from(auditEvents);
    expect(row?.actorName).toBe("Dana Levi");
  });

  it("stores access context on the events that carry it", async () => {
    const session = "11111111-1111-4111-8111-111111111111";
    await writer().write({
      action: "signin.succeeded",
      actor: { id: null, kind: "user", label: "dana@customer.com" },
      access: { ip: "84.229.11.6", client: "Chrome 141 / macOS", sessionId: session },
    });

    const [row] = await t.db.select().from(auditEvents);
    expect(row?.sessionId).toBe(session);
    expect(violations).toEqual([]);
  });

  /**
   * Dropped rather than refused: losing an address off a row is a smaller
   * failure than losing the row, and the CHECK constraint would reject the whole
   * insert otherwise.
   */
  it("drops access context from an event that must not carry it, and says so", async () => {
    await writer().write({
      action: "provider.edited",
      actor: { id: null, kind: "system" },
      access: { ip: "84.229.11.6", client: "Chrome 141 / macOS", sessionId: null },
    });

    const [row] = await t.db.select().from(auditEvents);
    expect(row?.ip).toBeNull();
    expect(row?.client).toBeNull();
    expect(violations).toEqual([{ action: "provider.edited", reason: "context-not-allowed" }]);
  });

  it("keeps changes on an event that did not expect them, and reports it", async () => {
    // The database accepts these; silently discarding data a caller meant to
    // record is the worse outcome, so this one is reported and kept.
    await writer().write({
      action: "change.approved",
      actor: { id: null, kind: "system" },
      changes: [{ field: "state", from: "pending", to: "approved" }],
    });

    const changes = await t.db.select().from(auditEventChanges);
    expect(changes).toHaveLength(1);
    expect(violations[0]?.reason).toBe("changes-not-expected");
  });

  it("writes field changes in the order it was given them", async () => {
    await writer().write({
      action: "provider.edited",
      actor: { id: null, kind: "system" },
      target: { type: "provider", id: "pr_331", name: "QuickNode" },
      changes: [
        { field: "node URL", from: "(changed, ends 4c02)", to: "(changed, ends 91be)" },
        { field: "capabilities", from: "archive, debug", to: "archive, debug, trace" },
      ],
    });

    const rows = await t.db.select().from(auditEventChanges).orderBy(auditEventChanges.ord);
    expect(rows.map((r) => [r.ord, r.field])).toEqual([
      [0, "node URL"],
      [1, "capabilities"],
    ]);
    expect(rows[0]?.fromValue).toBe("(changed, ends 4c02)");
  });

  it("gives every event a distinct stable id and an increasing sequence", async () => {
    const w = writer();
    await w.write({ action: "signin.succeeded", actor: { id: null, kind: "system" } });
    await w.write({ action: "signout", actor: { id: null, kind: "system" } });

    const rows = await t.db.select().from(auditEvents).orderBy(auditEvents.seq);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("files an event name it does not recognise rather than dropping it", async () => {
    // Unreachable through the types; the guard is for a JS caller or a rolling
    // deploy. The row still lands, because "we didn't recognise this" is a
    // truthful thing for the log to say and losing it is not.
    await writer().write({
      action: "totally.made.up" as never,
      actor: { id: null, kind: "system" },
    });

    const [row] = await t.db.select().from(auditEvents);
    expect(row?.actionGroup).toBe("unclassified");
    expect(violations[0]).toEqual({ action: "totally.made.up", reason: "unknown-action" });
  });
});

describe("createAuditWriter failure behaviour", () => {
  /** `client` is varchar(128); this overflows it and fails the insert. */
  const tooLong = { ip: null, client: "x".repeat(200), sessionId: null };

  it("swallows a standalone failure and reports it", async () => {
    await expect(
      writer().write({
        action: "signin.succeeded",
        actor: { id: null, kind: "system" },
        access: tooLong,
      }),
    ).resolves.toBeUndefined();

    expect(violations[0]?.reason).toBe("write-failed");
    const rows = await t.db.select().from(auditEvents);
    expect(rows).toHaveLength(0);
  });

  /**
   * Inside the caller's transaction the failure must propagate. Catching it
   * would buy nothing — the failed insert has already aborted their transaction
   * — and would turn "the row and the mutation land together" into a silent
   * maybe.
   */
  it("propagates a failure raised inside the caller's transaction", async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await writer().write(
          {
            action: "signin.succeeded",
            actor: { id: null, kind: "system" },
            access: tooLong,
          },
          tx,
        );
      }),
    ).rejects.toThrow();

    expect(violations).toEqual([]);
  });

  it("rolls the event back with the mutation it records", async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await writer().write(
          { action: "member.removed", actor: { id: null, kind: "system" } },
          tx,
        );
        throw new Error("the mutation failed after the row was written");
      }),
    ).rejects.toThrow(/the mutation failed/);

    const rows = await t.db.select().from(auditEvents);
    expect(rows).toHaveLength(0);
  });

  it("keeps an event and its changes atomic when standalone", async () => {
    // A reader must never see an event whose diff is half written.
    await writer().write({
      action: "member.role_changed",
      actor: { id: null, kind: "system" },
      changes: [{ field: "role", from: "requester", to: "approver" }],
    });

    const events = await t.db.select().from(auditEvents);
    const changes = await t.db.select().from(auditEventChanges);
    expect(events).toHaveLength(1);
    expect(changes[0]?.eventSeq).toBe(events[0]?.seq);
  });
});
