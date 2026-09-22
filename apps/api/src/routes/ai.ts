/**
 * AI routes (MAG-3702).
 *
 * Only one route for now, and it costs nothing: whether a model is reachable
 * and, when it is not, WHICH of the reasons applies. Every AI surface built on
 * top of this should call it before offering a button, so the UI can say "no
 * key configured" or "sign-in required" instead of a dead control.
 *
 * `/api/ai/*` sits under the same auth gate as the rest of `/api/*`, so with
 * `AUTH_MODE=enabled` a caller is already identified by the time they get
 * here. With `AUTH_MODE=disabled` there is no gate — which is exactly why
 * `bedrockAvailability()` refuses in that mode rather than trusting the gate
 * to exist.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { bedrockAvailability } from "../services/bedrock.js";

export async function aiRoutes(app: FastifyInstance) {
  app.get(
    "/api/ai/health",
    {
      schema: {
        tags: ["AI"],
        summary: "Is a model configured and allowed to be called?",
        description:
          "Free — makes no model call. `reason` is `not_configured` (no key) or " +
          "`auth_required` (a key is present but AUTH_MODE=disabled, so it must not be spendable anonymously).",
      },
    },
    async () => {
      // Read the live env, not the boot snapshot — the auth plugin registers
      // against the live value too, so the two cannot disagree.
      const authMode = process.env.AUTH_MODE ?? config.auth.mode;
      const availability = bedrockAvailability(authMode);
      return {
        ...availability,
        // Safe to publish: which model and region, never the credential.
        provider: "bedrock",
        model: config.bedrock.model,
        region: config.bedrock.region,
      };
    },
  );
}
