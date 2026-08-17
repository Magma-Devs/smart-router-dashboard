import { eq } from "drizzle-orm";
import {
  AUDIT_GROUP_FALLBACK,
  auditGroupOf,
  carriesAccessContext,
  carriesChanges,
  isAuditAction,
  type AuditAction,
  type AuditChange,
} from "@sr/shared";
import type { Database } from "./client.js";
import { users } from "./schema.js";
import { auditEventChanges, auditEvents } from "./schema-audit.js";

/**
 * The audit log's writer — MAG-2770.
 *
 * Implements the `AuditWriter` seam agreed in `docs/ACCOUNTS-DESIGN.md` §10, so
 * MAG-2729's call sites bind to this without changing shape. It lives in
 * `@sr/db` rather than in the api because MAG-2730's recovery commands run from
 * a shell on the host with no Fastify request anywhere in sight, and a writer
 * only the api can reach would leave `host.recovery` with nowhere to go.
 *
 * Everything policy-ish is resolved from `@sr/shared`'s catalog rather than
 * asked of the caller: the group, whether the row may carry access context, and
 * whether the event name is real at all. A caller supplies what happened; the
 * catalog decides how it is recorded.
 */

/** Request context. Recorded only on the events the catalog marks for it. */
export interface AuditAccessContext {
  ip: string | null;
  /** Parsed device string, e.g. "Chrome 141 / macOS". */
  client: string | null;
  /** Ties a run of actions to one sign-in. */
  sessionId: string | null;
}

/**
 * Who acted.
 *
 * A union rather than one shape with optional fields, because `host` has a
 * requirement the others don't: MAG-2730's done-when is that a recovery command
 * "shows up in the audit log **naming who ran it**", and the CLI that writes
 * those rows is a different ticket. Making `label` mandatory for host actors
 * means an anonymous recovery row cannot be written at all, rather than being a
 * rule someone has to remember in a file that doesn't exist yet.
 */
export type AuditActor =
  | {
      kind: "host";
      /** The operator who ran the command. Required — see above. */
      label: string;
      id?: null;
      email?: string;
    }
  | {
      kind: "user" | "system";
      /** Null for system actors, and for a sign-in attempt against an address
       *  with no account. */
      id: string | null;
      /**
       * What to record as the actor's name when `id` resolves to nothing — the
       * address someone typed at a failed sign-in. Ignored when `id` names a
       * real user, whose name is snapshotted from their row instead.
       */
      label?: string;
      /** Email to record alongside `label`, same rules. */
      email?: string;
    };

export interface AuditEventInput {
  action: AuditAction;
  actor: AuditActor;
  /** What was acted on, with the name **at the time**. */
  target?: { type: string; id: string; name: string };
  /** Already redacted and formatted — see `@sr/shared`'s `audit/format`. */
  changes?: readonly AuditChange[];
  access?: AuditAccessContext;
  /** The approval request this came from (MAG-2731). */
  requestId?: string;
  /** Rejection reason, self-approve note, probe-override reason. */
  note?: string;
  /** Overrides `now()`. For backfills and for tests; callers should not set it. */
  occurredAt?: Date;
}

export interface AuditWriter {
  /**
   * Append one event.
   *
   * `tx` is the caller's transaction when there is one, so the audit row and the
   * mutation it records commit or roll back together — a log that can disagree
   * with the thing it describes is worse than no log.
   */
  write(event: AuditEventInput, tx?: Database): Promise<void>;
}

/**
 * Reported instead of thrown: a call site that hands over slightly the wrong
 * shape should still get its row written.
 */
export interface AuditViolation {
  action: string;
  reason: "unknown-action" | "context-not-allowed" | "changes-not-expected" | "write-failed";
  detail?: unknown;
}

export interface AuditWriterOptions {
  /**
   * Called when a write is refused or degraded. Wire it to the app logger; the
   * api passes `(v) => log.warn({ audit: v }, "audit")`.
   */
  onViolation?: (violation: AuditViolation) => void;
}

/** `dashboard` for a person acting in the UI, otherwise the actor's own kind. */
function sourceFor(kind: AuditActor["kind"]): "dashboard" | "system" | "host" {
  if (kind === "user") return "dashboard";
  return kind;
}

export function createAuditWriter(db: Database, opts: AuditWriterOptions = {}): AuditWriter {
  const report = opts.onViolation ?? (() => {});

  async function insert(conn: Database, event: AuditEventInput): Promise<void> {
    const { action } = event;

    // An unknown verb is a bug in the caller, but refusing the row would lose
    // the only record that something happened. Store it under the catch-all
    // group so it is still visible, and report loudly.
    const known = isAuditAction(action);
    if (!known) report({ action, reason: "unknown-action" });
    const group = known ? auditGroupOf(action) : AUDIT_GROUP_FALLBACK;

    // Access context is DROPPED when the catalog forbids it, because the CHECK
    // constraint would otherwise reject the whole row — losing an address off a
    // row is a smaller failure than losing the row. Changes are only reported,
    // never dropped: the database accepts them, and silently discarding data a
    // caller meant to record is the worse outcome.
    let access = event.access;
    if (access && known && !carriesAccessContext(action)) {
      report({ action, reason: "context-not-allowed" });
      access = undefined;
    }
    const changes = event.changes ?? [];
    if (changes.length > 0 && known && !carriesChanges(action)) {
      report({ action, reason: "changes-not-expected", detail: changes.map((c) => c.field) });
    }

    // Names are snapshotted, never joined at read time: a removed person keeps
    // their name in the log permanently, and a rename must not rewrite history.
    let actorName = event.actor.label ?? "";
    let actorEmail = event.actor.email ?? null;
    if (event.actor.id) {
      const [row] = await conn
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, event.actor.id))
        .limit(1);
      if (row) {
        actorName = row.name ?? row.email;
        actorEmail = row.email;
      }
    }
    if (actorName === "") {
      // Never blank: an unattributed row still has to say so out loud.
      actorName = event.actor.kind === "user" ? "(unknown)" : `(${event.actor.kind})`;
    }

    const [written] = await conn
      .insert(auditEvents)
      .values({
        ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
        action,
        actionGroup: group,
        source: sourceFor(event.actor.kind),
        actorKind: event.actor.kind,
        actorUserId: event.actor.id ?? null,
        actorName,
        actorEmail,
        targetType: event.target?.type ?? null,
        targetId: event.target?.id ?? null,
        targetName: event.target?.name ?? null,
        requestId: event.requestId ?? null,
        note: event.note ?? null,
        ip: access?.ip ?? null,
        client: access?.client ?? null,
        sessionId: access?.sessionId ?? null,
      })
      .returning({ seq: auditEvents.seq });

    if (!written || changes.length === 0) return;

    await conn.insert(auditEventChanges).values(
      changes.map((change, i) => ({
        eventSeq: written.seq,
        ord: i,
        field: change.field,
        fromValue: change.from,
        toValue: change.to,
      })),
    );
  }

  return {
    async write(event, tx) {
      if (tx) {
        // Inside the caller's transaction the failure MUST propagate. Swallowing
        // it would not save the caller anything — a failed statement has already
        // aborted their transaction, so their commit fails regardless — and it
        // would turn "the mutation and its record land together" into a silent
        // maybe.
        await insert(tx, event);
        return;
      }

      // Standalone, the row and its changes still have to be atomic, or a
      // reader sees an event whose diff is half written.
      try {
        await db.transaction(async (trx) => {
          await insert(trx, event);
        });
      } catch (err) {
        // No transaction of the caller's to poison, and nothing they can do
        // about it: a sign-in must not 500 because the log is unwell.
        report({ action: event.action, reason: "write-failed", detail: err });
      }
    },
  };
}
