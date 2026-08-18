import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { AuditChangeRecord, AuditEventRecord } from "@sr/shared";
import type { Database } from "./client.js";
import { auditEventChanges, auditEvents } from "./schema-audit.js";

/**
 * Reading the audit log — MAG-2770.
 *
 * The viewer and the customer-facing pull API are the same query with a
 * different sort direction, so they live together: one place decides what a
 * filter means, and the screen cannot drift from what a security team pulls.
 *
 * The hard requirement is the pull side. From the ticket, not negotiable:
 * oldest first, a cursor that resumes **without gaps and without duplicates**,
 * and event ids that are stable forever. Everything below exists for the middle
 * one — the other two are a default and a stored uuid.
 */

/** How a caller names the person, when they name one. */
export interface AuditActorFilter {
  userId?: string;
  /** Matched case-insensitively against the snapshotted address. */
  email?: string;
}

export interface AuditQuery {
  from?: Date;
  to?: Date;
  actor?: AuditActorFilter;
  actions?: readonly string[];
  groups?: readonly string[];
  targetType?: string;
  targetId?: string;
  /** `asc` is the pull default — see `listAuditEvents`. */
  order?: "asc" | "desc";
  /** Rows per page. Not part of the cursor fingerprint: changing page size
   *  mid-pull is legitimate and must not invalidate a position. */
  limit?: number;
  cursor?: AuditCursor;
  /**
   * **Test seam. Production never sets this.**
   *
   * Pins the settled-transaction horizon instead of asking the database for it.
   * The property that matters here — a row whose transaction commits late is
   * delivered late rather than never — is by definition about two transactions
   * overlapping, and the in-process Postgres the tests run on has a single
   * connection. Pinning the horizon reproduces the exact interleaving on one
   * connection, deterministically. Without it this would be tested by arranging
   * real concurrency, which is a slower and flakier way to assert the same
   * predicate.
   */
  horizonOverride?: string;
}

/**
 * A decoded cursor.
 *
 * `horizon` is the snapshot boundary the previous read used. It is what makes
 * the resume gap-free, and it is why the cursor is opaque on the wire: a
 * caller inventing one would break the guarantee silently.
 */
export interface AuditCursor {
  seq: number;
  /** `xid8` as text — 64-bit and unsigned, so never a JS number. */
  horizon: string;
  order: "asc" | "desc";
  /** Identifies the filter set. A resume under different filters is refused
   *  rather than silently answered from the wrong position. */
  fingerprint: string;
}

/** Re-exported so a caller reading the log gets every type it returns from one
 *  import. Defined in `@sr/shared` because the web renders these too, and a
 *  local copy is precisely how a field goes missing on one side. */
export type { AuditChangeRecord, AuditEventRecord } from "@sr/shared";

export interface AuditPage {
  items: AuditEventRecord[];
  cursor: AuditCursor | null;
  hasMore: boolean;
}

export const AUDIT_PAGE_DEFAULT = 100;
export const AUDIT_PAGE_MAX = 1000;

/* ── Cursor codec ─────────────────────────────────────────────────────────── */

/**
 * Everything that changes what a position *means*.
 *
 * `limit` is deliberately absent — a puller catching up may legitimately raise
 * its page size and must not be told to start over. Everything else is in:
 * resuming a `spec=ETH1` position against an unfiltered feed would silently
 * skip every row the first filter excluded.
 */
export function auditFilterFingerprint(query: AuditQuery): string {
  const canonical = JSON.stringify({
    from: query.from?.toISOString() ?? null,
    to: query.to?.toISOString() ?? null,
    actorUserId: query.actor?.userId ?? null,
    actorEmail: query.actor?.email?.toLowerCase() ?? null,
    actions: [...(query.actions ?? [])].sort(),
    groups: [...(query.groups ?? [])].sort(),
    targetType: query.targetType ?? null,
    targetId: query.targetId ?? null,
    order: query.order ?? "asc",
  });
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 16);
}

/** Opaque on the wire, like GitHub's and 1Password's. */
export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** `null` for anything that isn't one of ours — the caller answers 400. */
export function decodeAuditCursor(raw: string): AuditCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as Record<string, unknown>;
    if (typeof c.seq !== "number" || !Number.isSafeInteger(c.seq) || c.seq < 0) return null;
    if (typeof c.horizon !== "string" || !/^\d{1,20}$/.test(c.horizon)) return null;
    if (c.order !== "asc" && c.order !== "desc") return null;
    if (typeof c.fingerprint !== "string" || c.fingerprint.length === 0) return null;
    return { seq: c.seq, horizon: c.horizon, order: c.order, fingerprint: c.fingerprint };
  } catch {
    return null;
  }
}

export type AuditCursorRejection = "malformed" | "filters-changed" | "order-changed";

/** Why a supplied cursor can't be used here, or `null` when it can. */
export function checkAuditCursor(
  cursor: AuditCursor,
  query: AuditQuery,
): AuditCursorRejection | null {
  if (cursor.order !== (query.order ?? "asc")) return "order-changed";
  if (cursor.fingerprint !== auditFilterFingerprint(query)) return "filters-changed";
  return null;
}

/* ── The read ─────────────────────────────────────────────────────────────── */

function filterConditions(query: AuditQuery): SQL[] {
  const where: SQL[] = [];
  if (query.from) where.push(gte(auditEvents.occurredAt, query.from));
  if (query.to) where.push(lte(auditEvents.occurredAt, query.to));
  if (query.actor?.userId) where.push(eq(auditEvents.actorUserId, query.actor.userId));
  if (query.actor?.email) {
    where.push(sql`lower(${auditEvents.actorEmail}) = lower(${query.actor.email})`);
  }
  if (query.actions?.length) where.push(inArray(auditEvents.action, [...query.actions]));
  if (query.groups?.length) where.push(inArray(auditEvents.actionGroup, [...query.groups]));
  if (query.targetType) where.push(eq(auditEvents.targetType, query.targetType));
  if (query.targetId) where.push(eq(auditEvents.targetId, query.targetId));
  return where;
}

/**
 * The oldest transaction still open. Anything written by a transaction below
 * this is settled: committed or rolled back, and never going to appear later.
 *
 * Read before the rows rather than inside the same statement on purpose — a
 * horizon computed slightly early is conservative (it withholds rows that have
 * since settled, and the next read picks them up), whereas one computed late
 * could let a row through before its predecessors.
 */
async function readHorizon(db: Database): Promise<string> {
  const result: unknown = await db.execute(
    sql`select pg_snapshot_xmin(pg_current_snapshot())::text as horizon`,
  );
  // The two drivers disagree on the shape of a raw result: postgres-js returns
  // the rows as an array, pglite (and node-postgres) wrap them in `{ rows }`.
  // `Database` is deliberately driver-agnostic so the same code runs under both,
  // which makes this the one place that has to know.
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) ?? [];
  const horizon = (rows[0] as { horizon?: string } | undefined)?.horizon;
  if (typeof horizon !== "string" || !/^\d+$/.test(horizon)) {
    // Fail loudly. Defaulting to 0 would withhold every row and hand the caller
    // an empty page forever — a feed that has silently stopped looks exactly
    // like a feed with nothing to report, which is the failure this whole
    // module exists to avoid.
    throw new Error("audit read: could not determine the transaction horizon");
  }
  return horizon;
}

/**
 * One page of the audit log.
 *
 * **`asc` is the resumable direction and the default.** Newest-first ordering
 * looks natural on a screen and makes resumable pulling impossible, so the
 * default is the one that is safe for a caller who skipped the documentation;
 * the viewer asks for `desc` explicitly, because the viewer is the caller with
 * the unusual need.
 *
 * The gap-free property, stated precisely. A row is served only once its
 * transaction is below the horizon. The cursor carries the horizon that was
 * used, and the next read also picks up anything that was *withheld* last time
 * — `xact_id >= cursor.horizon` — even where its `seq` now sits behind the
 * cursor. So a row whose transaction committed late is delivered late rather
 * than never, and a row already delivered fails both clauses and is not
 * delivered twice.
 *
 * The consequence, which is the honest cost: across pages the sequence is not
 * strictly monotonic — a straggler can arrive after higher-seq rows. Within a
 * page it always is. No ordering can do better without either dropping the
 * straggler or blocking the feed behind it, and for an audit log delivering
 * late beats not delivering.
 *
 * `desc` skips all of this. It is the screen, it re-polls, and a viewer that
 * lagged five seconds behind its own database would be a bug rather than a
 * guarantee.
 */
export async function listAuditEvents(db: Database, query: AuditQuery = {}): Promise<AuditPage> {
  const order = query.order ?? "asc";
  const limit = Math.min(Math.max(query.limit ?? AUDIT_PAGE_DEFAULT, 1), AUDIT_PAGE_MAX);
  const where = filterConditions(query);
  const cursor = query.cursor;

  let horizon: string | null = null;
  if (order === "asc") {
    horizon = query.horizonOverride ?? (await readHorizon(db));
    where.push(sql`${auditEvents.xactId} < ${horizon}::xid8`);
    if (cursor) {
      // Either new ground, or a row this cursor's own read was too early to see.
      where.push(
        or(gt(auditEvents.seq, cursor.seq), sql`${auditEvents.xactId} >= ${cursor.horizon}::xid8`)!,
      );
    }
  } else if (cursor) {
    where.push(lt(auditEvents.seq, cursor.seq));
  }

  // One extra row answers `hasMore` without a second count query.
  const rows = await db
    .select()
    .from(auditEvents)
    .where(where.length ? and(...where) : undefined)
    .orderBy(order === "asc" ? asc(auditEvents.seq) : desc(auditEvents.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const changes = await loadChanges(
    db,
    page.map((r) => r.seq),
  );

  const items = page.map((row) => toRecord(row, changes.get(row.seq) ?? []));

  let next: AuditCursor | null = null;
  if (page.length > 0) {
    const seqs = page.map((r) => r.seq);
    next = {
      // Monotonic on purpose: a late straggler must not drag the position
      // backwards and re-deliver everything after it.
      seq:
        order === "asc"
          ? Math.max(cursor?.seq ?? 0, ...seqs)
          : Math.min(cursor?.seq ?? Number.MAX_SAFE_INTEGER, ...seqs),
      horizon: horizon ?? cursor?.horizon ?? "0",
      order,
      fingerprint: auditFilterFingerprint(query),
    };
  }

  return { items, cursor: next, hasMore };
}

async function loadChanges(
  db: Database,
  seqs: number[],
): Promise<Map<number, AuditChangeRecord[]>> {
  const byEvent = new Map<number, AuditChangeRecord[]>();
  if (seqs.length === 0) return byEvent;

  const rows = await db
    .select()
    .from(auditEventChanges)
    .where(inArray(auditEventChanges.eventSeq, seqs))
    .orderBy(asc(auditEventChanges.eventSeq), asc(auditEventChanges.ord));

  for (const row of rows) {
    const list = byEvent.get(row.eventSeq) ?? [];
    list.push({ field: row.field, from: row.fromValue, to: row.toValue });
    byEvent.set(row.eventSeq, list);
  }
  return byEvent;
}

type Row = typeof auditEvents.$inferSelect;

function toRecord(row: Row, changes: AuditChangeRecord[]): AuditEventRecord {
  const record: AuditEventRecord = {
    id: row.id,
    time: row.occurredAt.toISOString(),
    action: row.action,
    group: row.actionGroup,
    source: row.source,
    actor: {
      type: row.actorKind,
      id: row.actorUserId,
      name: row.actorName,
      email: row.actorEmail,
    },
    target: row.targetId
      ? { type: row.targetType ?? "", id: row.targetId, name: row.targetName }
      : null,
    request: row.requestId,
    note: row.note,
    changes,
  };
  // Present only where the row actually carries it — an all-null `context` on
  // a config event would imply the fields were merely unset rather than
  // structurally absent.
  if (row.ip !== null || row.client !== null || row.sessionId !== null) {
    record.context = { ip: row.ip, client: row.client, session: row.sessionId };
  }
  return record;
}
