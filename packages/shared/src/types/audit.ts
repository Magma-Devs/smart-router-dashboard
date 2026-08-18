/**
 * The audit log on the wire — MAG-2770.
 *
 * Shared because three consumers have to agree on it: the api that serves it,
 * the web that renders it, and a customer's own tooling that pulls it on a
 * schedule. The last one is why the field names read the way they do —
 * `time`, `actor`, `action`, `target`, `request`, `note` are the ticket's own
 * vocabulary rather than the column names underneath, and they are a published
 * interface that cannot be renamed for internal convenience later.
 */

/** One changed field. Already redacted — a secret or a node URL reads as
 *  `(changed)` or `(changed, ends a91f)`, never as the value. */
export interface AuditChangeRecord {
  field: string;
  from: string;
  to: string;
}

/** Who acted. `name` and `email` are what they were called **at the time**. */
export interface AuditActorRecord {
  /** `user` · `system` · `host`. */
  type: string;
  /** Null for system and host actors, and for an attempt against an address
   *  with no account — in which case `name` carries the address that was typed. */
  id: string | null;
  name: string;
  email: string | null;
}

/** What was acted on, named as it was at the time. */
export interface AuditTargetRecord {
  type: string;
  id: string;
  name: string | null;
}

/** Where a person was acting from. Access events only. */
export interface AuditContextRecord {
  ip: string | null;
  /** Parsed device string, e.g. "Chrome 141 / macOS". */
  client: string | null;
  session: string | null;
}

export interface AuditEventRecord {
  /**
   * Stable forever. Re-pulling a range returns the same ids, which is what
   * lets a customer's system drop duplicates on its side.
   */
  id: string;
  /** RFC 3339, UTC. */
  time: string;
  action: string;
  group: string;
  /** `dashboard` · `system` · `host`. */
  source: string;
  actor: AuditActorRecord;
  target: AuditTargetRecord | null;
  /** The approval request this came from; null when the change skipped
   *  approval. A change that skipped it reads exactly like one that didn't,
   *  minus this reference. */
  request: string | null;
  note: string | null;
  changes: AuditChangeRecord[];
  /**
   * **Absent** on events that don't carry it, rather than present-and-null.
   * A config event has no IP as a matter of shape, not as a missing value.
   */
  context?: AuditContextRecord;
}

/**
 * One page.
 *
 * The envelope follows 1Password's Events API — `items` / `cursor` /
 * `has_more` — because a scheduled puller can persist `cursor` across restarts
 * and needs no header parsing to know whether to keep going. `cursor` is
 * opaque: it encodes a position *and* the filter set it belongs to, so
 * resuming under different filters is refused rather than silently answered
 * from the wrong place.
 */
export interface AuditEventsResponse {
  items: AuditEventRecord[];
  /** Feed this back as `after`. Null only when the page was empty. */
  cursor: string | null;
  has_more: boolean;
}
