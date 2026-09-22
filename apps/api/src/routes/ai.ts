/**
 * AI routes (MAG-3702).
 *
 * One route for now, and it makes no model call: whether a model is reachable
 * and, when it is not, WHICH reason applies. Every AI surface built on this
 * should call it before offering a button, so the UI can say "not enabled",
 * "sign-in required" or "no AWS credentials" instead of a dead control.
 *
 * `/api/ai/*` sits under the same auth gate as the rest of `/api/*`, so with
 * `AUTH_MODE=enabled` the caller is already identified. With
 * `AUTH_MODE=disabled` there is no gate — which is exactly why `bedrockGate()`
 * refuses in that mode rather than trusting a gate that was never installed.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { BedrockError, BedrockService, bedrockGate } from "../services/bedrock.js";

export async function aiRoutes(app: FastifyInstance) {
  app.get(
    "/api/ai/health",
    {
      schema: {
        tags: ["AI"],
        summary: "Is a model configured, allowed, and reachable?",
        description:
          "Free — makes no model call. `reason` is `disabled` (BEDROCK_ENABLED unset), " +
          "`auth_required` (enabled but AUTH_MODE=disabled, so it must not be spendable " +
          "anonymously), or `no_credentials` (the chain resolved nothing — with " +
          "BEDROCK_ROLE_ARN set, that includes a role the box is not allowed to assume). " +
          "`roleArn` names the assumed role, or null when the chain's own identity is used. " +
          "There is no credential to leak: the SDK signs with SigV4 per request.",
      },
    },
    async () => {
      // Read the live env, not the boot snapshot — the auth plugin registers
      // against the live value too, so the two cannot disagree.
      const authMode = process.env.AUTH_MODE ?? config.auth.mode;
      const gate = bedrockGate(authMode);

      const base = {
        provider: "bedrock",
        auth: "sigv4" as const,
        model: config.bedrock.model,
        region: config.bedrock.region,
        // Which role the process acts as, so an operator can tell a customer
        // deployment from a developer's own credentials at a glance. An ARN
        // names a role; it is not a secret. `null` = the chain's own identity.
        roleArn: config.bedrock.roleArn ?? null,
      };
      if (!gate.ok) return { ...gate, ...base };

      // Only worth resolving the chain once the cheap checks pass — it can
      // touch IMDS or the SSO cache.
      const hasCredentials = await new BedrockService(
        config.bedrock.region,
        config.bedrock.model,
        app.log,
      ).hasCredentials();

      return hasCredentials
        ? { ok: true, ...base }
        : { ok: false, reason: "no_credentials" as const, ...base };
    },
  );

  app.post(
    "/api/ai/verify",
    {
      schema: {
        tags: ["AI"],
        summary: "Send one tiny prompt to the model and report what came back",
        description:
          "COSTS MONEY — a real model call, ~30 tokens. The deployment check: " +
          "`/api/ai/health` proves credentials resolve, which is not the same as being " +
          "allowed to invoke this model. A role can hold a valid session and still be " +
          "denied InvokeModel, and that only shows up on a real call. Run this once after " +
          "wiring a new server.",
      },
    },
    async (_request, reply) => {
      const authMode = process.env.AUTH_MODE ?? config.auth.mode;
      const gate = bedrockGate(authMode);
      if (!gate.ok) {
        // 503: the dashboard is up, the thing it would call is not reachable
        // from here. Same shape as /health/ready refusing on Prometheus.
        reply.status(503);
        return { ...gate, model: config.bedrock.model, region: config.bedrock.region };
      }

      const startedAt = Date.now();
      try {
        const answer = await new BedrockService(
          config.bedrock.region,
          config.bedrock.model,
          app.log,
        ).complete({
          // Fixed and trivial on purpose: this measures the round trip, not
          // the model, and every run should cost the same.
          messages: [{ role: "user", content: "Reply with exactly: SMART_ROUTER_BEDROCK_OK" }],
          maxTokens: 32,
        });

        return {
          ok: true,
          model: config.bedrock.model,
          region: config.bedrock.region,
          roleArn: config.bedrock.roleArn ?? null,
          answer: answer.text,
          latencyMs: Date.now() - startedAt,
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
        };
      } catch (err) {
        // Hand back AWS's own reason. AccessDeniedException (policy or model
        // access), ThrottlingException (quota) and a network failure need
        // three different fixes, and collapsing them wastes the call.
        reply.status(502);
        return {
          ok: false,
          reason: "model_call_failed",
          awsErrorName: err instanceof BedrockError ? err.awsErrorName : null,
          detail: err instanceof Error ? err.message : String(err),
          model: config.bedrock.model,
          region: config.bedrock.region,
        };
      }
    },
  );
}
