import type { FastifyBaseLogger } from "fastify";
import type { Database } from "@sr/db";

/**
 * The seam between this task and the audit log.
 *
 * **MAG-2770 owns the audit log** — the table, the viewer, the CSV export and
 * the read API. This task only emits into it, and its ticket says the writer is
 * needed "within days", so the interface is settled here, in code, before either
 * side builds against the other. Slice 1 ships `noopAuditWriter`; 2770 swaps in
 * a real implementation and nothing else has to change.
 *
 * Nothing here persists anything yet. That is deliberate and it is the honest
 * state: the call sites go in as each slice lands, so when the writer arrives it
 * is a one-line substitution rather than an archaeology exercise.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §10.
 */

/**
 * Event names this task emits. MAG-2770 owns the full verb set — this is the
 * subset slices 1–5 produce, spelled exactly as its table spells them.
 *
 * `setup.completed` is **not** in 2770's published table yet: it has no verb for
 * first-admin creation, which is arguably the single most security-relevant row
 * in the whole log. Raised on that ticket; included here so slice 2 has
 * somewhere to send it.
 */
export type AuditAction =
  // Access — carry `access` context.
  | "signin.succeeded"
  | "signin.failed"
  | "signin.blocked"
  | "signout"
  | "session.revoked"
  // Accounts.
  | "password.changed"
  | "password.reset_requested"
  | "password.reset_link_generated"
  | "password.reset_completed"
  // People.
  | "member.invited"
  | "invite.resent"
  | "invite.revoked"
  | "invite.expired"
  | "invite.redeemed"
  | "member.role_changed"
  | "member.removed"
  // Setup.
  | "setup.completed";

/** One changed field. Values are already redacted and stringified by the
 *  caller — a secret or a node URL is `(changed)`, never the value itself. */
export interface AuditChange {
  field: string;
  from: string;
  to: string;
}

/**
 * Request context, on **access events only**.
 *
 * Config and people events don't carry it and shouldn't: *Dana changed the
 * provider set* is complete without an IP — her name is the answer. *Someone
 * failed to sign in as Dana* is close to useless without one, because you can't
 * tell a mistyped password from a run of guesses coming from somewhere else.
 */
export interface AuditAccessContext {
  ip: string | null;
  /** Parsed device string, e.g. "Chrome 141 / macOS". */
  client: string | null;
  /** Ties a run of actions to one sign-in. */
  sessionId: string | null;
}

export interface AuditEvent {
  action: AuditAction;
  /** `system` for anything automatic; `id` is null when the actor is not a
   *  known user (a failed sign-in against an address that doesn't exist). */
  actor: { id: string | null; kind: "user" | "system" };
  /** What was acted on. Carries the name *at the time*, so the row still reads
   *  correctly after a rename or a removal. */
  target?: { type: "member" | "invite" | "session"; id: string; name: string };
  changes?: AuditChange[];
  access?: AuditAccessContext;
  /** Rejection reason, self-approve note, override reason. */
  note?: string;
}

export interface AuditWriter {
  /**
   * Append one event.
   *
   * `tx` is the caller's transaction when there is one, so the audit row and the
   * mutation it records commit or roll back together — a log that can disagree
   * with the thing it describes is worse than no log.
   *
   * Implementations must not throw for reasons the caller can't act on; a
   * failed write is logged, not propagated into a user-facing 500.
   */
  write(event: AuditEvent, tx?: Database): Promise<void>;
}

/**
 * Records nothing, at debug level. The placeholder until MAG-2770 lands.
 *
 * It logs rather than silently discarding so the emission sites are verifiable
 * in dev — `LOG_LEVEL=debug` shows exactly which events fire and with what
 * shape, which is what makes the swap-in low-risk.
 */
export function noopAuditWriter(log: FastifyBaseLogger): AuditWriter {
  return {
    async write(event) {
      log.debug({ audit: event }, "audit event (no writer configured)");
    },
  };
}
