import type { FastifyInstance } from "fastify";
import { RANGE_QUERY_PROPERTIES, readRange, type RangeQuery } from "../services/read-range.js";
import { REQUEST_ID } from "../services/router-log.js";
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

  // One transaction by its request ID - the same row the log shows.
  app.get<{ Params: { guid: string }; Querystring: RangeQuery }>("/api/transactions/:guid", {
    schema: {
      tags: ["Transactions"],
      summary: "One transaction by its request ID, from the router's logs; found without a row = the ID isn't a transaction",
      params: { type: "object" as const, properties: { guid: { type: "string" as const, description: "The request ID - the GUID the router puts in its errors" } } },
      querystring: { type: "object" as const, properties: { ...RANGE_QUERY_PROPERTIES } },
    },
  }, async (request, reply) => {
    const { guid } = request.params;
    if (!REQUEST_ID.test(guid)) {
      sendApiError(reply, 400, "not a request ID: letters, digits, - and _ only, up to 64");
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
