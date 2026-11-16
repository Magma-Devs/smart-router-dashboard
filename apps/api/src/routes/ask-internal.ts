import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  askBudgetMonths,
  askMaintenance,
  askModelSteps,
  askRuns,
  askStaffAccess,
  askToolEvents,
} from "@sr/db";
import { readAskSettings, type AskSettings } from "../config.js";
import { AskFailure } from "../services/ask/errors.js";
import { verifyAskStaff } from "../services/ask/staff.js";

interface Options {
  settings?: AskSettings;
  fetchImpl?: typeof fetch;
}
const querySchema = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

/** These endpoints use live staff OAuth/MCP authorization, independently from
 * dashboard auth. They never accept a customer ID, endpoint, or admin override. */
export async function askInternalRoutes(app: FastifyInstance, opts: Options = {}): Promise<void> {
  app.setChildLoggerFactory((logger, bindings, options) =>
    logger.child(bindings, {
      ...options,
      serializers: {
        ...options.serializers,
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: request.url.split("?")[0],
        }),
      },
    }),
  );
  for (const kind of ["records", "export", "health"] as const)
    app.get(`/api/internal/ask/${kind}`, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const settings = opts.settings ?? readAskSettings();
        if ((process.env.DEPLOYMENT_MODE ?? "onprem") !== "managed" || !app.db)
          throw new AskFailure("ASK_DISABLED", 404);
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ")) throw new AskFailure("ASK_TOOL_DENIED", 403);
        const subject = await verifyAskStaff(settings, header.slice(7), opts.fetchImpl);
        const parsed =
          kind === "health"
            ? z.object({}).strict().safeParse(request.query)
            : querySchema.safeParse(request.query);
        if (!parsed.success) throw new AskFailure("ASK_INVALID_REQUEST", 400);
        await app.db
          .insert(askStaffAccess)
          .values({
            customerId: settings.customerId,
            subject,
            action: kind === "records" ? "read" : kind,
          });
        if (kind === "health") {
          const [maintenance] = await app.db
            .select()
            .from(askMaintenance)
            .where(eq(askMaintenance.customerId, settings.customerId));
          const pools = await app.db
            .select()
            .from(askBudgetMonths)
            .where(eq(askBudgetMonths.customerId, settings.customerId))
            .orderBy(asc(askBudgetMonths.month));
          const [uncertain] = await app.db
            .select({ count: sql<number>`count(*)::integer` })
            .from(askModelSteps)
            .where(
              and(
                eq(askModelSteps.customerId, settings.customerId),
                eq(askModelSteps.state, "uncertain"),
              ),
            );
          return {
            customerId: settings.customerId,
            maintenance: maintenance ?? null,
            uncertainSteps: uncertain?.count ?? 0,
            months: pools.map((p) => ({
              month: p.month,
              limitMicroUsd: p.limitMicroUsd.toString(),
              spentMicroUsd: p.spentMicroUsd.toString(),
              reservedMicroUsd: p.reservedMicroUsd.toString(),
            })),
          };
        }
        const query = querySchema.parse(parsed.data);
        const runs = await app.db
          .select()
          .from(askRuns)
          .where(
            and(
              eq(askRuns.customerId, settings.customerId),
              gt(askRuns.expiresAt, sql`clock_timestamp()`),
              sql`${askRuns.createdAt} > clock_timestamp() - ${settings.retentionDays} * interval '1 day'`,
              query.cursor ? gt(askRuns.id, query.cursor) : undefined,
            ),
          )
          .orderBy(asc(askRuns.id))
          .limit(query.limit + 1);
        const page = runs.slice(0, query.limit);
        const ids = page.map((r) => r.id);
        const steps = ids.length
          ? await app.db
              .select()
              .from(askModelSteps)
              .where(
                and(
                  eq(askModelSteps.customerId, settings.customerId),
                  inArray(askModelSteps.runId, ids),
                ),
              )
              .orderBy(asc(askModelSteps.createdAt), asc(askModelSteps.id))
          : [];
        const tools = ids.length
          ? await app.db
              .select()
              .from(askToolEvents)
              .where(
                and(
                  eq(askToolEvents.customerId, settings.customerId),
                  inArray(askToolEvents.runId, ids),
                ),
              )
              .orderBy(asc(askToolEvents.createdAt), asc(askToolEvents.id))
          : [];
        const records = page.map((run) => ({
          id: run.id,
          customerId: run.customerId,
          personId: run.ownerId,
          chatId: run.chatId,
          question: run.question,
          context: run.context,
          status: run.status,
          createdAt: run.createdAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
          latencyMs: run.completedAt ? run.completedAt.getTime() - run.createdAt.getTime() : null,
          answer: run.answer,
          errorCode: run.errorCode,
          steps: steps
            .filter((s) => s.runId === run.id)
            .map((s) => ({
              id: s.id,
              month: s.month,
              feature: s.feature,
              state: s.state,
              pricing: s.pricing,
              usage: s.usage,
              reservedMicroUsd: s.reservedMicroUsd.toString(),
              chargedMicroUsd: s.chargedMicroUsd?.toString() ?? null,
              providerRequestId: s.providerRequestId,
              providerStatus: s.providerStatus,
              dispatchedAt: s.dispatchedAt?.toISOString() ?? null,
            })),
          tools: tools
            .filter((t) => t.runId === run.id)
            .map((t) => ({
              sourceId: t.sourceId,
              operationId: t.operationId,
              parameters: t.parameters,
              evidence: t.evidence,
              outcome: t.ok,
              latencyMs: t.latencyMs,
              createdAt: t.createdAt.toISOString(),
            })),
        }));
        const nextCursor = runs.length > query.limit ? page.at(-1)!.id : null;
        if (kind === "export")
          return reply
            .header("Content-Disposition", 'attachment; filename="ask-records.ndjson"')
            .type("application/x-ndjson")
            .send(
              [
                ...records.map((record) => JSON.stringify({ kind: "run", ...record })),
                JSON.stringify({ kind: "page", nextCursor }),
              ].join("\n") + "\n",
            );
        return { records, nextCursor };
      } catch (error) {
        if (!(error instanceof AskFailure))
          request.log.error({ code: "ASK_INTERNAL_UNAVAILABLE" }, "Ask internal records failed");
        const failure = error instanceof AskFailure ? error : new AskFailure("ASK_UNAVAILABLE");
        return reply
          .status(failure.statusCode)
          .send({ code: failure.code, message: failure.message, statusCode: failure.statusCode });
      }
    });
}
