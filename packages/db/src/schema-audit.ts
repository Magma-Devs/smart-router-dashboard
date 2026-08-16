import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  inet,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * The audit log's tables — MAG-2770.
 *
 * Kept beside `schema.ts` rather than inside it because they are a separate
 * domain with a separate lifecycle: `users` and `sessions` are mutable account
 * state, these two are an append-only record that outlives them. `schema.ts`
 * re-exports this module, so `import * as schema` still sees everything.
 *
 * The migration (`migrations/0002_audit.sql`) is the authority — it carries the
 * append-only triggers and the retention escape hatch, neither of which Drizzle
 * can express. This file exists so the writer and the read API get typed
 * columns, and so a drift between the two is caught by `migrations.test.ts`.
 */

/** Where an event came from. */
export const auditSourceEnum = pgEnum("audit_source", ["dashboard", "system", "host"]);

/**
 * What kind of thing acted. `host` is MAG-2730's recovery commands, run from a
 * shell on the machine — no browser, no session, and the operator's name is the
 * whole attribution.
 */
export const auditActorKindEnum = pgEnum("audit_actor_kind", ["user", "system", "host"]);

export const auditEvents = pgTable(
  "audit_events",
  {
    /**
     * The read cursor. A puller resumes on this, so it has to be monotonic and
     * dense — a timestamp ties under concurrency and goes backwards when a clock
     * is corrected.
     *
     * `mode: "number"` because a deployment would need ~9 quadrillion audit rows
     * to exceed a JS safe integer, and a bigint here would infect every JSON
     * response with a type that doesn't serialise.
     */
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    /**
     * The public identifier. MAG-2770 requires it be "stable forever" so a
     * customer's tooling can drop duplicates across re-pulls. A uuid rather than
     * the sequence, so the published surface doesn't leak how many events the
     * deployment has recorded.
     */
    id: uuid("id").notNull().unique().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),

    /** An event name from `@sr/shared`'s catalog. */
    action: varchar("action", { length: 64 }).notNull(),
    /** The catalog's group for that action — denormalised so filtering by group
     *  is an index scan rather than a forty-way IN list. */
    actionGroup: varchar("action_group", { length: 32 }).notNull(),
    source: auditSourceEnum("source").notNull(),

    actorKind: auditActorKindEnum("actor_kind").notNull(),
    /** Null for system and host actors, and for a sign-in attempt against an
     *  address with no account. Not a foreign key — see the note below. */
    actorUserId: uuid("actor_user_id"),
    /** The actor's name **at the time**. For an unattributed sign-in attempt,
     *  the address that was typed. */
    actorName: text("actor_name").notNull(),
    actorEmail: varchar("actor_email", { length: 255 }),

    /** `member` · `invite` · `session` · `endpoint` · `provider` · `apikey` … */
    targetType: varchar("target_type", { length: 32 }),
    targetId: varchar("target_id", { length: 128 }),
    /** The target's name **at the time**. Stored apart from `targetId` because
     *  the API filters on the id and displays the name. */
    targetName: text("target_name"),

    /** The approval request this came from (MAG-2731); null when the change
     *  skipped approval. A change that skipped approval has to read exactly like
     *  one that didn't, minus this reference. */
    requestId: varchar("request_id", { length: 64 }),
    /** Rejection reason, self-approve note, probe-override reason. */
    note: text("note"),

    /* ── Access context. Present only on the events the catalog marks as
       carrying it; never on config or approval events, which the CHECK below
       enforces independently of the writer. ── */
    ip: inet("ip"),
    /** Parsed at sign-in ("Chrome 141 / macOS"), never re-derived on read. */
    client: varchar("client", { length: 128 }),
    /**
     * Ties a run of actions to one sign-in.
     *
     * **Not a foreign key.** Sessions are pruned once they expire, and a FK with
     * `ON DELETE SET NULL` would quietly blank this on rows that are years old —
     * which is exactly the evidence an incident review is looking for. Same
     * reasoning as `users.removed_by` and `sessions.revoked_by`: the audit row
     * has to outlive whatever it points at.
     */
    sessionId: uuid("session_id"),
  },
  (table) => [
    /** The viewer's default ordering. */
    index("audit_events_occurred_at_idx").on(table.occurredAt.desc()),
    /** The four filters the read API documents. */
    index("audit_events_group_time_idx").on(table.actionGroup, table.occurredAt.desc()),
    index("audit_events_action_time_idx").on(table.action, table.occurredAt.desc()),
    index("audit_events_actor_time_idx").on(table.actorUserId, table.occurredAt.desc()),
    index("audit_events_target_idx").on(
      table.targetType,
      table.targetId,
      table.occurredAt.desc(),
    ),
    /**
     * MAG-2770's done-when: "Access events carry the IP, the client and the
     * session. Config events do not."
     *
     * A backstop, not the rule. Which events may carry context is decided per
     * event in `@sr/shared`'s catalog and applied by the writer; this stops a
     * hand-written INSERT from putting an address on a config row.
     */
    check(
      "audit_events_no_context_on_config",
      sql`${table.actionGroup} not in ('config', 'approval')
          or (${table.ip} is null and ${table.client} is null and ${table.sessionId} is null)`,
    ),
  ],
);

/**
 * One row per field touched by an event.
 *
 * A child table rather than a JSONB column because the CSV export is specified
 * as exactly this shape — "one line per changed field, so a change touching
 * three fields becomes three lines sharing the same event id". Nested storage
 * would mean unrolling it again in the export, the viewer and the API.
 */
export const auditEventChanges = pgTable(
  "audit_event_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventSeq: bigint("event_seq", { mode: "number" })
      .notNull()
      .references(() => auditEvents.seq, { onDelete: "cascade" }),
    /** Display order, so a multi-field change reads the same way every time. */
    ord: integer("ord").notNull(),
    field: varchar("field", { length: 64 }).notNull(),
    /**
     * Already redacted and formatted by the writer — `(none)`, `(new)`,
     * `(deleted)`, `yes`/`no`, a stable comma-joined list, or
     * `(changed, ends a91f)`. There is no un-redacted copy in this table, which
     * is what makes "no secret or node URL appears as a value in the log, the
     * export, or the API" a property of the schema rather than a rule three read
     * paths have to remember.
     */
    fromValue: text("from_value").notNull(),
    toValue: text("to_value").notNull(),
  },
  (table) => [index("audit_event_changes_event_idx").on(table.eventSeq, table.ord)],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
export type AuditEventChangeRow = typeof auditEventChanges.$inferSelect;
export type NewAuditEventChangeRow = typeof auditEventChanges.$inferInsert;
