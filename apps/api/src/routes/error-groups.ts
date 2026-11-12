import type { FastifyInstance } from "fastify";
import { toMetricWindow } from "@sr/shared";
import { RANGE_QUERY_PROPERTIES } from "../services/read-range.js";
import { ERROR_GROUPS_LIMIT } from "../services/error-groups.js";

export async function errorGroupRoutes(app: FastifyInstance) {
  // The Errors tab's grouped view over the whole page window, from the counts
  // the fleet's ruler records of the router's lines. Opening a group lists its
  // requests through GET /api/error-requests with the group's minutes and provider.
  app.get<{ Querystring: { window?: string; spec?: string; routerId?: string } }>("/api/error-groups", {
    schema: {
      tags: ["Errors"],
      summary:
        `The ways requests failed over the window, from the store's recorded counts (smartrouter_request_errors:count1m): per chain, error class (the outcome while unclassified), failing provider and whether the client got it - count, minutes, a count per bar; at most ${ERROR_GROUPS_LIMIT} groups, the rest in omitted; reached = the requests whose error reached the client; available:false with a reason when the counts can't answer (no-series: the web groups the list instead); kept 30 s`,
      querystring: {
        type: "object" as const,
        properties: {
          window: RANGE_QUERY_PROPERTIES.window,
          // Spliced into the PromQL: a plain token or a 400 (see LABEL_TOKEN).
          spec: { type: "string" as const, pattern: "^[A-Za-z0-9_-]{1,64}$", description: "Chain spec label, e.g. ETH1 (optional)" },
          routerId: {
            type: "string" as const,
            description: "Only this config router's requests - an id from GET /api/config/routers (optional). `shared-chain` when its counts can't be told from another router's on its chain",
          },
        },
      },
    },
  }, async (request) =>
    app.errorGroups.groups(toMetricWindow(request.query.window), request.query.spec, request.query.routerId));
}
