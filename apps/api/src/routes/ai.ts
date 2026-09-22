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
}
