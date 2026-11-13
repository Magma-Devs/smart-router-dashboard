import type { FastifyInstance } from "fastify";
import { toMetricWindow } from "@sr/shared";
import { RANGE_QUERY_PROPERTIES, readRange, type RangeQuery } from "../services/read-range.js";
import { LOOKUP_ID } from "../services/error-requests.js";
import { PARAMS, upstreamParamCheck } from "../services/query-params.js";
import { sendApiError } from "../plugins/error-handler.js";

interface ErrorRequestsQuery extends RangeQuery {
  spec?: string;
  routerId?: string;
  upstream?: string;
}

export async function errorRequestRoutes(app: FastifyInstance) {
  // The Errors tab's request list - every request that hit an error, from the
  // router's logs (Loki). Its count cards are GET /api/metrics/retries and
  // GET /api/metrics/errors.
  app.get<{ Querystring: ErrorRequestsQuery }>("/api/error-requests", {
    // A name the values file lists, or a plain token: refused before any read.
    preValidation: upstreamParamCheck("upstream", () => app.routerConfig),
    schema: {
      tags: ["Errors"],
      summary:
        "Requests that hit an error, from the router's logs (Loki): each try's upstream, error and retryability, who answered, why the router stopped; available:false without LOKI_URL",
      querystring: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          ...RANGE_QUERY_PROPERTIES,
          spec: { ...PARAMS.spec, description: "Chain spec label, e.g. ETH1 (optional)" },
          routerId: {
            ...PARAMS.routerId,
            description: "Only requests that tried an upstream this config router declares - an id from GET /api/config/routers (optional)",
          },
          upstream: {
            ...PARAMS.upstream,
            description: "Only requests whose try at this upstream failed - what its errors-over-time bars count: a node the values file lists, or a plain token (optional)",
          },
        },
      },
    },
  }, async (request, reply) => {
    const { spec, routerId, before, upstream } = request.query;
    const range = readRange(request.query);
    if ("error" in range) {
      sendApiError(reply, 400, range.error);
      return reply;
    }
    return app.errorRequests.report(range, spec, routerId, before, upstream);
  });

  // How many requests the router gave up on - the Metrics page's "Failed
  // requests" card. From the logs: no metric counts it (see failedCount).
  app.get<{ Querystring: { window?: string; spec?: string; routerId?: string } }>("/api/error-requests/count", {
    schema: {
      tags: ["Errors"],
      summary:
        "Client requests the router could not serve (nothing, or nothing usable, came back from the upstreams, so the router returned its own error) in the window, from the router's logs; kept 30 s; available:false with a reason when the logs can't be read or a router can't be told apart",
      querystring: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          window: RANGE_QUERY_PROPERTIES.window,
          spec: { ...PARAMS.spec, description: "Chain spec label, e.g. ETH1 (optional)" },
          routerId: {
            ...PARAMS.routerId,
            description: "Only this config router's requests - an id from GET /api/config/routers (optional). `shared-chain` when other routers serve its chain",
          },
        },
      },
    },
  }, async (request) =>
    app.errorRequests.failedCount(toMetricWindow(request.query.window), request.query.spec, request.query.routerId));

  // One request by its ID - every try and what came of it, from the router's
  // logs. The same row the list shows, for any request, failed or not.
  app.get<{ Params: { guid: string }; Querystring: RangeQuery }>("/api/requests/:guid", {
    schema: {
      tags: ["Errors"],
      summary: "One request by its ID (the router's GUID), its transaction hash or the caller's request ID, from its logs: every try, what each upstream answered, what the app got; matches = how many requests carry the value",
      params: { type: "object" as const, additionalProperties: false, properties: { guid: PARAMS.lookupId } },
      querystring: { type: "object" as const, additionalProperties: false, properties: { ...RANGE_QUERY_PROPERTIES } },
    },
  }, async (request, reply) => {
    const { guid } = request.params;
    if (!LOOKUP_ID.test(guid)) {
      sendApiError(reply, 400, "not a request ID, transaction hash or caller's request ID: letters, digits and _ - . : + = @ only, up to 128");
      return reply;
    }
    const range = readRange(request.query);
    if ("error" in range) {
      sendApiError(reply, 400, range.error);
      return reply;
    }
    return app.errorRequests.lookup(guid, range);
  });
}
