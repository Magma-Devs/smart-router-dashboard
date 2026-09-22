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
import { BedrockService, bedrockGate } from "../services/bedrock.js";

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
          "anonymously), or `no_credentials` (the AWS credential chain resolved nothing). " +
          "Reports the model and region; there is no credential to leak, since the SDK " +
          "signs with SigV4 from the ambient identity.",
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
}
