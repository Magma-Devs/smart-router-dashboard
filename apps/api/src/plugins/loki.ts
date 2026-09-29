import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { LokiClient } from "../services/loki-client.js";
import { TransactionsService } from "../services/transactions.js";
import { ErrorRequestsService } from "../services/error-requests.js";
import { config, lokiUrl } from "../config.js";

declare module "fastify" {
  interface FastifyInstance {
    transactions: TransactionsService;
    errorRequests: ErrorRequestsService;
  }
}

/**
 * Decorate the app with the services that read the router's logs from Loki
 * when LOKI_URL is set: the Transactions tab, the Errors tab's request list
 * and the Failed requests card's count.
 * Registered after the Prometheus plugin: they share its values-file service
 * to map upstreams to chains.
 */
export const lokiPlugin = fp(async (app: FastifyInstance) => {
  const url = lokiUrl();
  const loki = url ? new LokiClient(url, config.loki.timeoutMs, app.log) : null;
  const selector = process.env.LOKI_ROUTER_SELECTOR?.trim() || config.loki.routerSelector;
  app.decorate("transactions", new TransactionsService(loki, selector, app.routerConfig));
  app.decorate("errorRequests", new ErrorRequestsService(loki, selector, app.routerConfig));
});
