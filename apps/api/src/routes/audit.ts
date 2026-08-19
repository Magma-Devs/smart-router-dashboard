import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  AUDIT_GROUPS,
  escapeCsvField,
  isAuditAction,
  isAuditGroup,
  type AuditEventRecord,
  type AuditEventsResponse,
} from "@sr/shared";
import {
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  checkAuditCursor,
  decodeAuditCursor,
  encodeAuditCursor,
  listAuditEvents,
  type AuditQuery,
  type Database,
} from "@sr/db";
import { sendApiError } from "../plugins/error-handler.js";

/**
 * The audit log's read surface — MAG-2770.
 *
 * One endpoint serves both readers. The dashboard's viewer asks for
 * `order=desc`; a customer's security tooling takes the default and pulls
 * oldest-first on a schedule. Deliberately the same query: a screen that could
 * disagree with what a security team pulls is worse than no screen.
 *
 * **No role gate.** The ticket says the log is visible to every role including
 * read-only, so the only requirement is a live session — which the global gate
 * in `plugins/auth.ts` already gives us. Reading the record of what happened is
 * not a privilege; being able to change things is.
 *
 * Shaped against the two references the ticket names as normative: 1Password's
 * envelope (`items` / `cursor` / `has_more`), on GitHub's GET-with-query-params
 * form. See `docs/AUDIT.md`.
 */

interface AuditEventsQuery {
  from?: string;
  to?: string;
  actor?: string;
  action?: string | string[];
  group?: string | string[];
  target_type?: string;
  target_id?: string;
  order?: string;
  per_page?: number;
  after?: string;
}

/** The filters both read surfaces accept. Named so the export cannot drift
 *  from the feed in what it will answer. */
const AUDIT_FILTER_PROPS = {
  from: { type: "string" as const, description: "Only events at or after this RFC 3339 time" },
  to: { type: "string" as const, description: "Only events at or before this RFC 3339 time" },
  actor: {
    type: "string" as const,
    description: "Restrict to one person — their user id (UUID) or their email address",
  },
  action: {
    type: "array" as const,
    items: { type: "string" as const },
    description: "Event name, repeatable (e.g. action=signin.failed)",
  },
  group: {
    type: "array" as const,
    items: { type: "string" as const, enum: [...AUDIT_GROUPS] },
    description: "Event group, repeatable",
  },
  target_type: { type: "string" as const, description: "Object kind, e.g. endpoint" },
  target_id: { type: "string" as const, description: "Object id, e.g. ep_8143" },
  order: {
    type: "string" as const,
    enum: ["asc", "desc"],
    description: "asc (default, oldest first and resumable) or desc (newest first)",
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fastify hands a repeated param back as an array and a single one as a
 *  string. Normalising here keeps every caller from having to care. */
function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value]).filter((v) => v !== "");
  return list.length ? list : undefined;
}

function parseDate(raw: string | undefined): Date | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The filter half of the query string, shared by the JSON feed and the CSV
 * export so the file someone downloads can never mean something different from
 * the screen they were looking at.
 *
 * Returns `null` having already answered, which is why every caller returns
 * `reply` straight after.
 */
function parseAuditQuery(
  q: AuditEventsQuery,
  reply: FastifyReply,
): (AuditQuery & { order: "asc" | "desc" }) | null {
  const from = parseDate(q.from);
  if (from === null) {
    sendApiError(reply, 400, "`from` is not an RFC 3339 timestamp");
    return null;
  }
  const to = parseDate(q.to);
  if (to === null) {
    sendApiError(reply, 400, "`to` is not an RFC 3339 timestamp");
    return null;
  }

  if (q.order !== undefined && q.order !== "asc" && q.order !== "desc") {
    sendApiError(reply, 400, "`order` must be asc or desc");
    return null;
  }
  const order = q.order ?? "asc";

  // A misspelled verb or group is refused rather than answered with an empty
  // page. Silently returning nothing for `signin.failure` reads exactly like
  // "this never happened", which is the wrong answer to give anyone reading an
  // audit log — and worse in a downloaded file, which outlives the query that
  // produced it.
  const actions = asList(q.action);
  const unknownAction = actions?.find((a) => !isAuditAction(a));
  if (unknownAction) {
    sendApiError(
      reply,
      400,
      `unknown action "${unknownAction}" — see GET /docs for the event list`,
    );
    return null;
  }
  const groups = asList(q.group);
  const unknownGroup = groups?.find((g) => !isAuditGroup(g));
  if (unknownGroup) {
    sendApiError(reply, 400, `unknown group "${unknownGroup}" — one of ${AUDIT_GROUPS.join(", ")}`);
    return null;
  }

  // Same reasoning: an address that isn't one, or an id that isn't a UUID,
  // would otherwise match nothing and look like an innocent person.
  let actor: AuditQuery["actor"];
  if (q.actor) {
    if (UUID.test(q.actor)) actor = { userId: q.actor };
    else if (q.actor.includes("@")) actor = { email: q.actor };
    else {
      sendApiError(reply, 400, "`actor` must be a user id (UUID) or an email address");
      return null;
    }
  }

  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(actor ? { actor } : {}),
    ...(actions ? { actions } : {}),
    ...(groups ? { groups } : {}),
    ...(q.target_type ? { targetType: q.target_type } : {}),
    ...(q.target_id ? { targetId: q.target_id } : {}),
    order,
  };
}

/**
 * The export's columns — flat on purpose.
 *
 * MAG-2770: "one line per changed field, so a change touching three fields
 * becomes three lines sharing the same event id. Events with nothing to diff
 * get one line with the field columns empty. Flat beats nested — the person
 * opening this file wants to filter and sort it, not parse it."
 */
const CSV_COLUMNS = [
  "event_id",
  "time",
  "actor_name",
  "actor_email",
  "source",
  "action",
  "group",
  "target_type",
  "target_id",
  "target_name",
  "request",
  "note",
  "field",
  "from",
  "to",
] as const;

/** RFC 4180 line ending, matching `toCsv` in `@sr/shared`. Excel on Windows
 *  collapses every row into one cell without it. */
const CRLF = "\r\n";

function csvLine(values: readonly (string | null)[]): string {
  return values.map(escapeCsvField).join(",") + CRLF;
}

/** Seconds, not milliseconds: this column gets sorted and eyeballed, and
 *  `.000` in every cell is noise. Still RFC 3339, so it also sorts correctly as
 *  plain text. */
function csvTime(iso: string): string {
  return `${iso.slice(0, 19)}Z`;
}

function csvRowsFor(event: AuditEventRecord): string {
  const base: (string | null)[] = [
    event.id,
    csvTime(event.time),
    event.actor.name,
    event.actor.email,
    event.source,
    event.action,
    event.group,
    event.target?.type ?? null,
    event.target?.id ?? null,
    event.target?.name ?? null,
    event.request,
    event.note,
  ];
  if (event.changes.length === 0) return csvLine([...base, null, null, null]);
  return event.changes.map((c) => csvLine([...base, c.field, c.from, c.to])).join("");
}

/** Rows per round-trip while streaming. Bounded memory: one page is held at a
 *  time, never the whole export. */
const EXPORT_PAGE = 500;

/**
 * Runaway guard, not a row limit.
 *
 * The cursor terminates on its own, so reaching this means a bug in the loop
 * rather than a large log. It throws rather than stopping quietly: a truncated
 * file that looks complete is the worst possible artifact to hand an auditor,
 * and a failed download is at least visibly a failure.
 */
const EXPORT_MAX_PAGES = 20_000;

export async function auditRoutes(app: FastifyInstance) {
  /** The db plugin connects lazily; 503 (not 500) while it settles. */
  function dbOr503(reply: FastifyReply): Database | null {
    if (!app.db) {
      void reply.code(503).send({
        statusCode: 503,
        error: "Service Unavailable",
        message: "audit database not ready",
      });
      return null;
    }
    return app.db;
  }

  app.get<{ Querystring: AuditEventsQuery }>(
    "/api/audit/events",
    {
      schema: {
        tags: ["Audit"],
        summary: "Read the audit log, oldest first, resumable",
        description:
          "Every recorded event, filterable by time, person, verb, group and object. " +
          "Ordered oldest-first by default so a scheduled puller can keep its position and resume; " +
          "pass order=desc for a newest-first view. Feed `cursor` back as `after` to continue.",
        querystring: {
          type: "object" as const,
          properties: {
            ...AUDIT_FILTER_PROPS,
            per_page: {
              type: "integer" as const,
              minimum: 1,
              maximum: AUDIT_PAGE_MAX,
              description: `Rows per page (default ${AUDIT_PAGE_DEFAULT}, max ${AUDIT_PAGE_MAX})`,
            },
            after: {
              type: "string" as const,
              description: "Opaque cursor from a previous response",
            },
          },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;
      const q = request.query;

      const parsed = parseAuditQuery(q, reply);
      if (!parsed) return reply;
      const query: AuditQuery = {
        ...parsed,
        // Clamped rather than refused, matching GitHub: a caller asking for
        // more than we serve wants as much as possible, not an error.
        limit: Math.min(Math.max(q.per_page ?? AUDIT_PAGE_DEFAULT, 1), AUDIT_PAGE_MAX),
      };

      if (q.after) {
        const cursor = decodeAuditCursor(q.after);
        if (!cursor) return sendApiError(reply, 400, "`after` is not a cursor from this endpoint");
        const rejection = checkAuditCursor(cursor, query);
        if (rejection === "order-changed") {
          return sendApiError(
            reply,
            400,
            "`after` was issued for the other `order` — restart the pull",
          );
        }
        if (rejection === "filters-changed") {
          // Answering this would skip every row the first filter excluded, and
          // the caller would have no way to tell.
          return sendApiError(
            reply,
            400,
            "`after` was issued for a different filter set — restart the pull",
          );
        }
        query.cursor = cursor;
      }

      const page = await listAuditEvents(db, query);
      const body: AuditEventsResponse = {
        items: page.items,
        cursor: page.cursor ? encodeAuditCursor(page.cursor) : null,
        has_more: page.hasMore,
      };
      return body;
    },
  );

  /**
   * The same query, as a file.
   *
   * Streamed rather than built in memory: the JSON feed is paginated because a
   * caller asks for one page at a time, but an export is by definition "all of
   * it", and an audit log is the one table that only ever grows. Paging
   * internally keeps a single page in memory however long the history is.
   *
   * No `per_page` or `after` — those describe a position, and this endpoint has
   * no position to describe. Every other filter is shared with the feed, parsed
   * by the same function, so the file cannot disagree with the screen.
   */
  app.get<{ Querystring: AuditEventsQuery }>(
    "/api/audit/export.csv",
    {
      schema: {
        tags: ["Audit"],
        summary: "Download the audit log as CSV",
        description:
          "The same events as GET /api/audit/events, flattened to one row per changed field " +
          "(events with nothing to diff get one row with the field columns empty). " +
          "Values are already redacted; no secret or node URL appears. Streamed, so the whole " +
          "matching history is returned rather than a page.",
        querystring: {
          type: "object" as const,
          properties: { ...AUDIT_FILTER_PROPS },
        },
      },
    },
    async (request, reply) => {
      const db = dbOr503(reply);
      if (!db) return reply;

      const query = parseAuditQuery(request.query, reply);
      if (!query) return reply;

      const stamp = new Date().toISOString().slice(0, 10);
      void reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="audit-log-${stamp}.csv"`)
        // The file is a snapshot of a growing table; a cached copy would be
        // wrong the moment anything else happens.
        .header("Cache-Control", "no-store");

      async function* rows(): AsyncGenerator<string> {
        // UTF-8 BOM. Excel ignores the charset in Content-Type when opening a
        // downloaded .csv and assumes the local codepage, which mangles any
        // non-ASCII name — and a mangled name in an audit record is worse than
        // in most files. Costs scripted consumers a `utf-8-sig` read.
        yield "\uFEFF" + CSV_COLUMNS.map(escapeCsvField).join(",") + CRLF;

        let cursor = undefined as Awaited<ReturnType<typeof listAuditEvents>>["cursor"] | undefined;
        for (let page = 0; ; page++) {
          if (page >= EXPORT_MAX_PAGES) {
            throw new Error(
              "audit export exceeded its page guard — refusing to serve a partial file",
            );
          }
          const result = await listAuditEvents(db!, {
            ...query,
            limit: EXPORT_PAGE,
            ...(cursor ? { cursor } : {}),
          });
          for (const event of result.items) yield csvRowsFor(event);
          if (!result.hasMore || !result.cursor) return;
          cursor = result.cursor;
        }
      }

      return reply.send(Readable.from(rows(), { objectMode: false }));
    },
  );
}
