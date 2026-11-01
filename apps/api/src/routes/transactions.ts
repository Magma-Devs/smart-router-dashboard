import type { FastifyInstance } from "fastify";
import { toMetricWindow } from "@sr/shared";
import { RANGE_QUERY_PROPERTIES, readRange, type RangeQuery } from "../services/read-range.js";
import { LOOKUP_ID } from "../services/router-log.js";
import { sendApiError } from "../plugins/error-handler.js";

interface TransactionsQuery extends RangeQuery {
  spec?: string;
  routerId?: string;
}

export async function transactionRoutes(app: FastifyInstance) {
  // Transactions tab - rebuilt from the router's logs (Loki), not Prometheus.
  app.get<{ Querystring: TransactionsQuery }>("/api/transactions", {
    schema: {
      tags: ["Transactions"],
      summary: "Transactions sent through the router, from its logs (Loki); available:false without LOKI_URL",
      querystring: {
        type: "object" as const,
        properties: {
          ...RANGE_QUERY_PROPERTIES,
          spec: { type: "string" as const, description: "Chain spec label, e.g. ETH1 (optional)" },
          routerId: {
            type: "string" as const,
            description: "Only transactions sent to upstreams this config router declares - an id from GET /api/config/routers (optional)",
          },
        },
      },
    },
  }, async (request, reply) => {
    const { spec, routerId, before } = request.query;
    const range = readRange(request.query);
    if ("error" in range) {
      sendApiError(reply, 400, range.error);
      return reply;
    }
    return app.transactions.report(range, spec, routerId, before);
  });

  // The tab's chart: transactions over the window, a bar per stretch of the
  // clock, split by result. Recorded counts first, the logs where there are none.
  app.get<{ Querystring: { window?: string; spec?: string; routerId?: string } }>("/api/transactions/over-time", {
    schema: {
      tags: ["Transactions"],
      summary:
        "Transactions over the window, a bar per stretch of the clock, split by result: the store's recorded counts (smartrouter_transactions:count1m), the newest minutes and a store without the fleet's ruler from the router's logs; kept 30 s",
      querystring: {
        type: "object" as const,
        properties: {
          window: RANGE_QUERY_PROPERTIES.window,
          // Spliced into the PromQL and the LogQL: a plain token or a 400 (see LABEL_TOKEN).
          spec: { type: "string" as const, pattern: "^[A-Za-z0-9_-]{1,64}$", description: "Chain spec label, e.g. ETH1 (optional)" },
          routerId: {
            type: "string" as const,
            description: "Only this config router's transactions - an id from GET /api/config/routers (optional). `shared-chain` when its lines can't be told from another router's on its chain",
          },
        },
      },
    },
  }, async (request) =>
    app.transactionsOverTime.overTime(toMetricWindow(request.query.window), request.query.spec, request.query.routerId));

  // One transaction by its request ID - the same row the log shows.
  app.get<{ Params: { guid: string }; Querystring: RangeQuery }>("/api/transactions/:guid", {
    schema: {
      tags: ["Transactions"],
      summary: "One transaction by its request ID, hash or the caller's request ID, from the router's logs; found without a row = it isn't a transaction; matches = how many requests carry the value",
      params: { type: "object" as const, properties: { guid: { type: "string" as const, description: "The request ID (the GUID the router puts in its errors), the transaction hash, or the caller's X-Request-Id" } } },
      querystring: { type: "object" as const, properties: { ...RANGE_QUERY_PROPERTIES } },
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
    return app.transactions.lookup(guid, range);
  });
}
