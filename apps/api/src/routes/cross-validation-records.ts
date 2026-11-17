import type { FastifyInstance, FastifyReply } from "fastify";
import {
  decodeCursor,
  filterFingerprint,
  PROVIDER_OUTCOMES,
  RECORD_STATUSES,
  type CvRecordFilter,
  type CvRecordsQuery,
  type Order,
  type ProviderOutcome,
  type RecordStatus,
  recordMethod,
} from "../services/cross-validation-records.js";
import { sendApiError } from "../plugins/error-handler.js";
import { auditReadRateLimitKey } from "./audit.js";

/**
 * The router's cross-validation records - MAG-2788.
 *
 * Under `/api/audit/` on purpose: it is evidence for the same readers the
 * audit log has, a customer's security and compliance tooling, and an audit
 * token reaches exactly `GET` under that prefix. So the token an admin mints
 * for the audit pull reads this too, and nothing about what a token may do
 * had to change. Every signed-in role reads it, as every role reads the log.
 *
 * The records live in the router's logs (Loki), not in Postgres; see
 * `services/cross-validation-records.ts` for how they are paged.
 */

interface RecordsQuerystring {
  from?: string;
  to?: string;
  provider?: string;
  provider_outcome?: ProviderOutcome;
  chain?: string;
  method?: string;
  status?: RecordStatus;
  reason?: string;
  request_id?: string;
  order?: Order;
  per_page?: number;
  after?: string;
}

/** How far back a read with no `from` starts: the retention the records are meant to have. */
export const DEFAULT_LOOKBACK_MS = 90 * 24 * 3600_000;

export const RECORDS_PAGE_DEFAULT = 100;
export const RECORDS_PAGE_MAX = 1000;

/**
 * Lower than the audit log's 120: a page here is up to twelve calls to a Loki
 * the tenant shares with its own dashboard and alert rules (READS_PER_PAGE),
 * not one indexed query.
 */
const RECORDS_RATE_LIMIT = { max: 30, timeWindow: "1 minute", keyGenerator: auditReadRateLimitKey };

/** Longer than any cursor this endpoint issues, short enough to refuse a pasted blob before decoding it. */
const CURSOR_MAX_LENGTH = 512;

/** A filter value: spliced into a backtick-quoted LogQL string, so never a backtick. */
const VALUE = { type: "string" as const, pattern: "^[^`]{1,128}$" };

function parseDate(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export async function crossValidationRecordRoutes(app: FastifyInstance) {
  app.get<{ Querystring: RecordsQuerystring }>(
    "/api/audit/cross-validation/records",
    {
      config: { rateLimit: RECORDS_RATE_LIMIT },
      schema: {
        tags: ["Audit"],
        summary: "Read the router's cross-validation records, oldest first, resumable",
        description:
          "One record per cross-validated request, agreed or failed, exactly as the router wrote it " +
          "(smart-router MAG-2787), read from the router's logs. Filters combine with AND. " +
          "Feed `cursor` back as `after` to continue; a page can be short or empty while `has_more` is true. " +
          "Oldest-first reads stop a minute short of now, where lines may still be arriving. " +
          "503 when the logs are not configured or cannot be read - never an empty page.",
        querystring: {
          type: "object" as const,
          properties: {
            from: { type: "string" as const, description: "Only records logged at or after this RFC 3339 time (default 90 days ago)" },
            to: { type: "string" as const, description: "Only records logged at or before this RFC 3339 time (default now)" },
            provider: { ...VALUE, description: "Only records that asked this provider - its name as the router's config gives it" },
            provider_outcome: {
              type: "string" as const,
              enum: [...PROVIDER_OUTCOMES],
              description: "How that provider took part (any provider's, without `provider`). `disagreed` = the checks it dissented on",
            },
            chain: { ...VALUE, description: "The record's chainId, e.g. ETH1" },
            method: { ...VALUE, description: "The record's method, e.g. eth_getBlockByNumber, or a REST path with or without its leading slash" },
            status: { type: "string" as const, enum: [...RECORD_STATUSES], description: "success or failed" },
            reason: { ...VALUE, description: "The record's failureReason, e.g. no-agreement" },
            request_id: { ...VALUE, description: "One request: the Lava-Guid the caller got back" },
            order: {
              type: "string" as const,
              enum: ["asc", "desc"],
              description: "asc (default, oldest first and resumable) or desc (newest first)",
            },
            per_page: {
              type: "integer" as const,
              minimum: 1,
              maximum: RECORDS_PAGE_MAX,
              description: `Records per page at most (default ${RECORDS_PAGE_DEFAULT}, max ${RECORDS_PAGE_MAX})`,
            },
            after: {
              type: "string" as const,
              maxLength: CURSOR_MAX_LENGTH,
              description: "Opaque `cursor` from a previous response: the page after it",
            },
          },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const service = app.crossValidationRecords;
      if (!service.configured) {
        return sendApiError(reply, 503, "this dashboard does not read the router's logs (LOKI_URL is not set)");
      }
      const q = request.query;

      const now = Date.now();
      const from = parseDate(q.from);
      if (from === null) return sendApiError(reply, 400, "`from` is not an RFC 3339 timestamp");
      const to = parseDate(q.to);
      if (to === null) return sendApiError(reply, 400, "`to` is not an RFC 3339 timestamp");
      const fromMs = from ?? now - DEFAULT_LOOKBACK_MS;
      const toMs = to ?? now;
      if (fromMs > toMs) return sendApiError(reply, 400, "`from` must not be after `to`");

      const filter: CvRecordFilter = {
        ...(q.provider !== undefined ? { provider: q.provider } : {}),
        ...(q.provider_outcome !== undefined ? { providerOutcome: q.provider_outcome } : {}),
        ...(q.chain !== undefined ? { chain: q.chain } : {}),
        ...(q.method !== undefined ? { method: recordMethod(q.method) } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.reason !== undefined ? { reason: q.reason } : {}),
        ...(q.request_id !== undefined ? { requestId: q.request_id } : {}),
      };
      const order: Order = q.order ?? "asc";
      const query: CvRecordsQuery = {
        filter,
        order,
        fromMs,
        toMs,
        // Clamped rather than refused, as the audit log does.
        perPage: Math.min(Math.max(q.per_page ?? RECORDS_PAGE_DEFAULT, 1), RECORDS_PAGE_MAX),
      };

      if (q.after) {
        const cursor = decodeCursor(q.after);
        if (!cursor) return sendApiError(reply, 400, "`after` is not a cursor from this endpoint");
        if (cursor.order !== order) {
          return sendApiError(reply, 400, "`after` was issued for the other `order` - restart the pull");
        }
        // Answering would skip every record the first filter set left out, and
        // the caller would have no way to tell.
        if (cursor.fingerprint !== filterFingerprint(filter, order)) {
          return sendApiError(reply, 400, "`after` was issued for a different filter set - restart the pull");
        }
        query.after = cursor.position;
      }

      const page = await service.page(query);
      if (!page) return sendApiError(reply, 503, "the router's logs could not be read - try again");
      return page;
    },
  );
}
