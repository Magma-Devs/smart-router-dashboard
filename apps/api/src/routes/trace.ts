/**
 * Relay Trace — one relay's log trail, and (on request) Claude's account of it.
 *
 *   GET  /api/trace/:guid           the lines. No model call, no spend.
 *   POST /api/trace/:guid/explain   the explanation. Costs money.
 *
 * They are separate routes because they are separate decisions. Explaining on
 * page load would bill the operator once per reader of a link whose whole
 * purpose is being pasted to whoever is on call, and would leave no way to ask
 * again when an answer is poor. Behind a button, the cost is something a person
 * chooses to spend.
 *
 * Nothing here verifies the model against the lines — the page renders both,
 * and that is the honest mitigation, not a fix.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import {
  isValidGuid,
  type RelayTrace,
  type TraceExplainResult,
  type TraceLogLine,
} from "@sr/shared";
import { config } from "../config.js";
import { LokiClient, LokiUnavailableError } from "../services/loki-client.js";
import { explainAvailable, explainTrace, TraceExplainError } from "../services/trace-explain.js";

const guidParams = {
  type: "object",
  required: ["guid"],
  properties: { guid: { type: "string", minLength: 1, maxLength: 20 } },
} as const;

export async function traceRoutes(app: FastifyInstance) {
  const loki = new LokiClient();

  interface Trail {
    guid: string;
    lines: TraceLogLine[];
    searched: { fromMs: number; toMs: number };
    truncated: boolean;
  }
  type LoadResult =
    | { ok: true; trail: Trail }
    | { ok: false; status: number; body: { error?: string; message: string } };

  /** Shared preamble for both routes: validate, check the store, fetch.
   *  Returns the failure to send rather than sending it, so each handler keeps
   *  its own typed reply. */
  async function loadTrail(guid: string, log: FastifyBaseLogger): Promise<LoadResult> {
    if (!isValidGuid(guid)) {
      return {
        ok: false,
        status: 400,
        body: {
          message:
            "That is not a relay GUID. The router returns one in the Lava-Guid response header — a decimal number of up to 20 digits.",
        },
      };
    }

    if (!loki.configured) {
      // NOT an empty trace: "there is no log store here" would otherwise be
      // indistinguishable from "that relay does not exist".
      return {
        ok: false,
        status: 503,
        body: {
          error: "log_store_not_configured",
          message:
            "No log store is configured for this deployment (LOKI_URL is unset), so relay traces cannot be looked up.",
        },
      };
    }

    try {
      // One past the cap, so a trail sitting exactly on the limit is not
      // reported as truncated.
      const found = await loki.linesForGuid(guid, config.traceAi.maxLines + 1);
      const truncated = found.lines.length > config.traceAi.maxLines;
      return {
        ok: true,
        trail: {
          guid,
          lines: truncated ? found.lines.slice(0, config.traceAi.maxLines) : found.lines,
          searched: { fromMs: found.fromMs, toMs: found.toMs },
          truncated,
        },
      };
    } catch (e) {
      if (e instanceof LokiUnavailableError) {
        log.warn({ err: e, guid }, "loki lookup failed");
        return { ok: false, status: 503, body: { error: "log_store_unavailable", message: e.message } };
      }
      throw e;
    }
  }

  app.get<{ Params: { guid: string } }>(
    "/api/trace/:guid",
    {
      schema: {
        tags: ["Trace"],
        summary: "One relay's log trail (no model call)",
        params: guidParams,
      },
      // Deliberately NO tighter rate limit: this is a plain Loki read and sits
      // under the global RATE_LIMIT_MAX. The tight limit protects a model
      // budget, and belongs on the route that spends one.
    },
    async (request, reply) => {
      const res = await loadTrail(request.params.guid, request.log);
      if (!res.ok) return reply.status(res.status).send(res.body);

      const body: RelayTrace = {
        ...res.trail,
        aiAvailable: explainAvailable(),
        model: explainAvailable() ? config.traceAi.model : null,
      };
      return reply.send(body);
    },
  );

  app.post<{ Params: { guid: string } }>(
    "/api/trace/:guid/explain",
    {
      schema: {
        tags: ["Trace"],
        summary: "Ask Claude to explain this relay",
        params: guidParams,
      },
      // Tighter than the global ceiling: every call here spends model tokens.
      config: { rateLimit: { max: config.traceAi.rateLimitMax, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!explainAvailable()) {
        return reply.status(404).send({
          error: "ai_disabled",
          message: !config.traceAi.enabled
            ? "The AI explanation is turned off on this deployment (TRACE_AI_ENABLED=false)."
            : config.traceAi.provider === null
              ? "No model provider is configured — set ANTHROPIC_API_KEY or GEMINI_API_KEY."
              : `TRACE_AI_PROVIDER is "${config.traceAi.provider}" but its key is not set.`,
        });
      }

      const res = await loadTrail(request.params.guid, request.log);
      if (!res.ok) return reply.status(res.status).send(res.body);
      const trail = res.trail;

      if (trail.lines.length === 0) {
        // 422, not 500: the request was fine, there is simply nothing to read.
        return reply.status(422).send({
          error: "no_lines",
          message: "No log lines carry this GUID in the window searched, so there is nothing to explain.",
        });
      }

      try {
        const explanation = await explainTrace(trail.guid, trail.lines, trail.truncated);
        const body: TraceExplainResult = {
          guid: trail.guid,
          explanation,
          model: config.traceAi.model,
          linesConsidered: trail.lines.length,
        };
        return reply.send(body);
      } catch (e) {
        if (e instanceof TraceExplainError) {
          request.log.warn({ err: e, guid: trail.guid }, "trace explanation failed");
          // 502: our hop to the model failed. The lines are unaffected and the
          // page still has them — this only says the answer is missing.
          return reply.status(502).send({ error: "explain_failed", message: e.message });
        }
        throw e;
      }
    },
  );
}
