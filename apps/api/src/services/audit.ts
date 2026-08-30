import type { FastifyBaseLogger } from "fastify";
import { createAuditWriter, type AuditEventInput, type Database } from "@sr/db";
import type { AuditActionOf } from "@sr/shared";

/**
 * The seam between this task and the audit log.
 *
 * **MAG-2770 owns the audit log** — the tables, the writer, the viewer, the CSV
 * export and the read API. This task only emits into it. The interface below was
 * agreed in code before either side built against the other, which is why the
 * swap from the placeholder to the real writer touched this file and nothing
 * else: every call site across slices 1–5 was already emitting.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §10.
 */

/**
 * Event names this task emits — the four groups it owns, resolved from
 * MAG-2770's catalog rather than hand-maintained here.
 *
 * The consequence is worth stating: adding an event to one of those groups in
 * the catalog silently widens what these call sites are allowed to emit. That
 * is the right trade — one definition, no drift — but it makes a group
 * assignment over there a real decision rather than bookkeeping.
 */
export type AuditAction = AuditActionOf<"access" | "accounts" | "people" | "setup">;

/**
 * The event shape is **MAG-2770's**, narrowed to the verbs this task emits.
 *
 * It was a local duplicate until the writer landed, which is exactly how it
 * drifted: their `actor` gained a `label` (for a sign-in attempt against an
 * address with no account) and mine hadn't, so the field that names the target
 * of a lockout wouldn't typecheck. One definition, no drift.
 */
export type AuditEvent = Omit<AuditEventInput, "action"> & { action: AuditAction };

export type { AuditActor, AuditChange } from "@sr/db";

export interface AuditWriter {
  /**
   * Append one event.
   *
   * `tx` is the caller's transaction when there is one, so the audit row and the
   * mutation it records commit or roll back together — a log that can disagree
   * with the thing it describes is worse than no log.
   *
   * **Failure behaviour depends on `tx`, and the asymmetry is deliberate:**
   *
   *  - **Standalone** (no `tx`) — swallow and report out of band. A sign-in must
   *    not 500 because the log is unwell.
   *  - **Inside a transaction** — propagate. Swallowing buys nothing there: the
   *    failed insert has already aborted the caller's transaction, so their
   *    commit fails either way, and catching it would turn "the row and the
   *    mutation land together" into a silent maybe.
   */
  write(event: AuditEvent, tx?: Database): Promise<void>;
}

/**
 * The real writer, backed by MAG-2770's `audit_events` tables.
 *
 * `onViolation` is wired to the log rather than swallowed: it fires when a
 * caller sends a verb the catalog doesn't know, or access context on an event
 * the catalog says can't carry it. Both are bugs in *this* codebase, and both
 * are invisible without somewhere to report them — the row still lands, which
 * is the right call (losing the record of something happening is worse than
 * recording it imperfectly), so nothing else would ever surface them.
 */
export function auditWriter(db: Database, log: FastifyBaseLogger): AuditWriter {
  return createAuditWriter(db, {
    onViolation: (v) => log.error({ audit: v }, "audit event violated the catalog"),
  });
}

/**
 * Records nothing, at debug level. Used only where there is no database to
 * write to — which in practice means nowhere, since every emission site sits
 * behind AUTH_MODE=enabled. Kept so a route can construct a writer before the
 * lazy connection settles without branching at every call site.
 */
export function noopAuditWriter(log: FastifyBaseLogger): AuditWriter {
  return {
    async write(event) {
      log.debug({ audit: event }, "audit event (no database yet)");
    },
  };
}

/**
 * A writer resolved per write rather than at registration.
 *
 * The db plugin connects lazily, so `app.db` is null for a window after boot
 * and routes register before it settles. Binding a writer at registration time
 * would capture that null and silently discard events for the life of the
 * process; binding per write costs a closure and is always correct.
 */
export function lazyAuditWriter(app: { db: Database | null; log: FastifyBaseLogger }): AuditWriter {
  return {
    write(event, tx) {
      const writer = app.db ? auditWriter(app.db, app.log) : noopAuditWriter(app.log);
      return writer.write(event, tx);
    },
  };
}
