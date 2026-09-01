/**
 * `GET /api/trace/:guid` — one relay's log trail, and Claude's account of it.
 *
 * The lines and the explanation come back together because the page shows
 * both: the answer on top, the evidence under it. Nothing here verifies the
 * model against the lines — showing them is the mitigation, and an honest one
 * only because they are on the same screen as the claim.
 */
import type { FastifyInstance } from "fastify";
import { isValidGuid, type RelayTrace, type TraceExplainSkip } from "@sr/shared";
import { config } from "../config.js";
import { LokiClient, LokiUnavailableError } from "../services/loki-client.js";
import { explainTrace, TraceExplainError } from "../services/trace-explain.js";

export async function traceRoutes(app: FastifyInstance) {
  const loki = new LokiClient();

  app.get<{ Params: { guid: string } }>(
    "/api/trace/:guid",
    {
      schema: {
        tags: ["Trace"],
        summary: "One relay's log trail, explained",
        params: {
          type: "object",
          required: ["guid"],
          properties: { guid: { type: "string", minLength: 1, maxLength: 20 } },
        },
      },
      // The tighter limit exists to protect a MODEL BUDGET, so it applies only
      // when there is one to protect. With the AI off this route is a plain
      // Loki read and belongs under the global RATE_LIMIT_MAX like everything
      // else — the limit is also per-IP, so behind an ingress every dashboard
      // user shares one bucket and two engineers debugging together would lock
      // each other out of a route that costs nothing.
      ...(config.traceAi.enabled
        ? { config: { rateLimit: { max: config.traceAi.rateLimitMax, timeWindow: "1 minute" } } }
        : {}),
    },
    async (request, reply) => {
      const { guid } = request.params;

      if (!isValidGuid(guid)) {
        return reply.status(400).send({
          message:
            "That is not a relay GUID. The router returns one in the Lava-Guid response header — a decimal number of up to 20 digits.",
        });
      }

      if (!loki.configured) {
        // NOT an empty trace: "there is no log store here" would otherwise be
        // indistinguishable from "that relay does not exist".
        return reply.status(503).send({
          error: "log_store_not_configured",
          message:
            "No log store is configured for this deployment (LOKI_URL is unset), so relay traces cannot be looked up.",
        });
      }

      let found: Awaited<ReturnType<LokiClient["linesForGuid"]>>;
      try {
        // Fetch one past the cap so a trail sitting exactly on the limit is
        // not reported as truncated.
        found = await loki.linesForGuid(guid, config.traceAi.maxLines + 1);
      } catch (e) {
        if (e instanceof LokiUnavailableError) {
          request.log.warn({ err: e, guid }, "loki lookup failed");
          return reply.status(503).send({ error: "log_store_unavailable", message: e.message });
        }
        throw e;
      }

      const truncated = found.lines.length > config.traceAi.maxLines;
      const lines = truncated ? found.lines.slice(0, config.traceAi.maxLines) : found.lines;

      const trace: RelayTrace = {
        guid,
        lines,
        searched: { fromMs: found.fromMs, toMs: found.toMs },
        truncated,
        explanation: null,
        explainSkipped: null,
        explainError: null,
        model: null,
      };

      const skip: TraceExplainSkip | null =
        lines.length === 0 ? "no_lines" : !config.traceAi.enabled ? "disabled" : null;

      if (skip !== null) {
        trace.explainSkipped = skip;
        return reply.send(trace);
      }

      try {
        trace.explanation = await explainTrace(guid, lines, truncated);
        trace.model = config.traceAi.model;
      } catch (e) {
        // A failed explanation does not fail the request — the lines are the
        // part we are sure of, and they are worth showing on their own.
        if (e instanceof TraceExplainError) {
          request.log.warn({ err: e, guid }, "trace explanation failed");
          trace.explainSkipped = "failed";
          trace.explainError = e.message;
        } else {
          throw e;
        }
      }

      return reply.send(trace);
    },
  );
}
