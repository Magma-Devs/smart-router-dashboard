/**
 * The dashboard's usage events (MAG-5373).
 *
 *  - `GET /api/usage/config` → `{ enabled }`: whether the web should send any.
 *  - `POST /api/usage` → `{ visit, events: [{ name, at, seq, props }] }`, at
 *    most 50 a batch. 202 with how many were kept; 204 and nothing sent while
 *    usage data is off. The answer doesn't wait for Mixpanel.
 *
 * Both auth modes: with accounts on, the global gate has already required a
 * session; with them off anyone who reaches the api may send, so the body is
 * checked against a closed catalog (`cleanUsageProps`) and the route has its
 * own per-caller limit. See `services/usage.ts` and docs/USAGE-DATA.md.
 */
import type { FastifyInstance } from "fastify";
import { USAGE_BATCH_MAX } from "@sr/shared";
import type { UsageSettings } from "../config.js";
import { sendToMixpanel, toMixpanel, type IncomingUsageEvent } from "../services/usage.js";

export interface UsageRoutesOptions {
  settings: UsageSettings;
  /** Injected by tests; the global `fetch` otherwise. */
  fetchImpl?: typeof fetch;
}

const WARN_INTERVAL_MS = 60_000;

export async function usageRoutes(app: FastifyInstance, opts: UsageRoutesOptions) {
  const { settings } = opts;
  let warnedAt = 0;
  if (settings.problem) app.log.warn({ problem: settings.problem }, "usage data is off");

  app.get("/api/usage/config", { schema: { tags: ["usage"], summary: "Whether the dashboard sends usage data" } }, async () => ({
    enabled: settings.enabled,
  }));

  app.post<{ Body: { visit: string; events: IncomingUsageEvent[] } }>(
    "/api/usage",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      bodyLimit: 64 * 1024,
      schema: {
        tags: ["usage"],
        summary: "Usage events of one visit, forwarded to the analytics store",
        body: {
          type: "object",
          required: ["visit", "events"],
          additionalProperties: false,
          properties: {
            visit: { type: "string", pattern: "^[a-z0-9-]{8,64}$" },
            events: {
              type: "array",
              maxItems: USAGE_BATCH_MAX,
              items: {
                type: "object",
                required: ["name", "at", "seq"],
                additionalProperties: false,
                properties: {
                  name: { type: "string", maxLength: 40 },
                  at: { type: "number" },
                  seq: { type: "integer", minimum: 0, maximum: 1_000_000 },
                  props: { type: "object", maxProperties: 12 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!settings.enabled) return reply.code(204).send();
      const events = toMixpanel(request.body.visit, request.body.events, settings);
      void sendToMixpanel(events, settings, opts.fetchImpl).then((r) => {
        if (r.ok || Date.now() - warnedAt < WARN_INTERVAL_MS) return;
        warnedAt = Date.now();
        app.log.warn({ status: r.status, detail: r.detail }, "usage data: Mixpanel refused a batch");
      });
      return reply.code(202).send({ accepted: events.length });
    },
  );
}
