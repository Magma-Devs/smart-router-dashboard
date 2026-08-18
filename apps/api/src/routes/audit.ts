import type { FastifyInstance, FastifyReply } from "fastify";
import { AUDIT_GROUPS, isAuditAction, isAuditGroup, type AuditEventsResponse } from "@sr/shared";
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
            from: {
              type: "string" as const,
              description: "Only events at or after this RFC 3339 time",
            },
            to: {
              type: "string" as const,
              description: "Only events at or before this RFC 3339 time",
            },
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

      const from = parseDate(q.from);
      if (from === null) return sendApiError(reply, 400, "`from` is not an RFC 3339 timestamp");
      const to = parseDate(q.to);
      if (to === null) return sendApiError(reply, 400, "`to` is not an RFC 3339 timestamp");

      if (q.order !== undefined && q.order !== "asc" && q.order !== "desc") {
        return sendApiError(reply, 400, "`order` must be asc or desc");
      }
      const order = q.order ?? "asc";

      // A misspelled verb or group is refused rather than answered with an
      // empty page. Silently returning nothing for `signin.failure` reads
      // exactly like "this never happened", which is the wrong answer to give
      // anyone reading an audit log.
      const actions = asList(q.action);
      const unknownAction = actions?.find((a) => !isAuditAction(a));
      if (unknownAction) {
        return sendApiError(
          reply,
          400,
          `unknown action "${unknownAction}" — see GET /docs for the event list`,
        );
      }
      const groups = asList(q.group);
      const unknownGroup = groups?.find((g) => !isAuditGroup(g));
      if (unknownGroup) {
        return sendApiError(
          reply,
          400,
          `unknown group "${unknownGroup}" — one of ${AUDIT_GROUPS.join(", ")}`,
        );
      }

      // Same reasoning: an address that isn't one, or an id that isn't a UUID,
      // would otherwise match nothing and look like an innocent person.
      let actor: AuditQuery["actor"];
      if (q.actor) {
        if (UUID.test(q.actor)) actor = { userId: q.actor };
        else if (q.actor.includes("@")) actor = { email: q.actor };
        else
          return sendApiError(reply, 400, "`actor` must be a user id (UUID) or an email address");
      }

      const query: AuditQuery = {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(actor ? { actor } : {}),
        ...(actions ? { actions } : {}),
        ...(groups ? { groups } : {}),
        ...(q.target_type ? { targetType: q.target_type } : {}),
        ...(q.target_id ? { targetId: q.target_id } : {}),
        order,
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
}
