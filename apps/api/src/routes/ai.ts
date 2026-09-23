/**
 * AI routes (MAG-3702). Two, with one job each:
 *
 *   GET  /api/ai/health   free, instant — is AI configured and allowed?
 *   POST /api/ai/verify   costs ~30 tokens — does the model actually answer?
 *
 * The split matters. Flags are cheap enough for a monitor to poll; proving the
 * identity can invoke the model needs a real call, because a role can hold a
 * valid session and still be denied `bedrock:InvokeModel`.
 *
 * `/api/ai/*` sits under the same auth gate as the rest of `/api/*`, so with
 * `AUTH_MODE=enabled` the caller is already identified. With
 * `AUTH_MODE=disabled` there is no gate — which is why `bedrockGate()` refuses
 * in that mode rather than trusting a gate that was never installed.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { BedrockError, BedrockService, bedrockGate } from "../services/bedrock.js";
import { StatusAiService } from "../services/status-ai.js";
import { IncidentsService } from "../services/incidents.js";
import { parseWindow } from "./metrics.js";

/** Which model this deployment would call. Nothing here is secret — no credential exists to leak. */
function target() {
  return {
    provider: "bedrock",
    auth: "sigv4",
    model: config.bedrock.model,
    region: config.bedrock.region,
    // An ARN names a role; it is not a secret. `null` = the chain's own identity.
    roleArn: config.bedrock.roleArn ?? null,
  };
}

/** Read the live env, as the auth plugin does, so the two cannot disagree. */
function gate() {
  return bedrockGate(process.env.AUTH_MODE ?? config.auth.mode);
}

export async function aiRoutes(app: FastifyInstance) {
  app.get(
    "/api/ai/health",
    {
      schema: {
        tags: ["AI"],
        summary: "Is a model configured and allowed to be called?",
        description:
          "Free and instant — no model call, and deliberately no credential resolution " +
          "either, which blocks for seconds on IMDS when there are none. `reason` is " +
          "`disabled` (BEDROCK_ENABLED unset) or `auth_required` (enabled but " +
          "AUTH_MODE=disabled, so it must not be spendable anonymously). " +
          "Use POST /api/ai/verify to prove the model actually answers.",
      },
    },
    async () => ({ ...gate(), ...target() }),
  );

  app.post(
    "/api/ai/verify",
    {
      // Tighter than the global limit: this one spends money, and a signed-in
      // caller looping it is the failure auth does not prevent.
      config: { rateLimit: { max: config.bedrock.rateLimitMax, timeWindow: "1 minute" } },
      schema: {
        tags: ["AI"],
        summary: "Send one tiny prompt to the model and report what came back",
        description:
          "COSTS MONEY — a real call, ~30 tokens. The deployment check: credentials " +
          "resolving is not the same as being allowed to invoke this model, and only a " +
          "real call tells them apart. Run it once after wiring a new server.",
      },
    },
    async (_request, reply) => {
      const g = gate();
      if (!g.ok) {
        // Checked BEFORE the call, so a shut gate spends nothing. 503: the
        // dashboard is up, the thing it would call is not reachable from here.
        reply.status(503);
        return { ...g, ...target() };
      }

      const startedAt = Date.now();
      try {
        const answer = await new BedrockService(config.bedrock.model, app.log).complete({
          // Fixed and trivial on purpose: this measures the round trip, not the
          // model, and every run should cost the same.
          messages: [{ role: "user", content: "Reply with exactly: SMART_ROUTER_BEDROCK_OK" }],
          maxTokens: 32,
        });
        return {
          ok: true,
          ...target(),
          answer: answer.text,
          latencyMs: Date.now() - startedAt,
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
        };
      } catch (err) {
        reply.status(502);
        return {
          ok: false,
          reason: "model_call_failed",
          // AWS's own name for it — AccessDenied, Throttling and an unreachable
          // endpoint need three different fixes, and collapsing them wastes the call.
          awsErrorName: err instanceof BedrockError ? err.awsErrorName : null,
          detail: err instanceof Error ? err.message : String(err),
          ...target(),
        };
      }
    },
  );

  app.post<{ Querystring: { window?: string; router?: string } }>(
    "/api/ai/status-analysis",
    {
      config: { rateLimit: { max: config.bedrock.rateLimitMax, timeWindow: "1 minute" } },
      schema: {
        tags: ["AI"],
        summary: "Relate the Status page's findings to each other",
        description:
          "COSTS MONEY. Reads the whole Status report plus 24h of incidents and returns " +
          "correlated themes — the join the page cannot make, since one provider can appear " +
          "as an Issue, an Insight and the blamed party in an Incident with nothing linking " +
          "them. Every theme cites the finding ids it rests on; any that cites nothing real " +
          "is dropped server-side before it renders, and `droppedUncited` counts them.",
      },
    },
    async (request, reply) => {
      const g = gate();
      if (!g.ok) {
        reply.status(503);
        return { ...g, ...target() };
      }

      const scoped = app.scoped(request.query.router);
      // Both reads happen regardless of the model — a brief over a half-read
      // report would be worse than no brief.
      const [report, incidentsReport] = await Promise.all([
        scoped.metricsDetail.status(parseWindow(request.query.window)),
        new IncidentsService(app.prom, app.routerConfig).incidents(24),
      ]);

      const startedAt = Date.now();
      try {
        const svc = new StatusAiService(
          new BedrockService(config.bedrock.model, app.log),
          app.log,
        );
        const analysis = await svc.analyse(report, incidentsReport.incidents);
        return {
          ok: true,
          ...target(),
          ...analysis,
          model: config.bedrock.model,
          latencyMs: Date.now() - startedAt,
          // What it read, so a thin brief is explicable rather than suspicious.
          input: {
            findings: report.findings.length,
            insights: report.insights.length,
            incidents: incidentsReport.incidents.length,
          },
        };
      } catch (err) {
        reply.status(502);
        return {
          ok: false,
          reason: "model_call_failed",
          awsErrorName: err instanceof BedrockError ? err.awsErrorName : null,
          detail: err instanceof Error ? err.message : String(err),
          ...target(),
        };
      }
    },
  );
}
