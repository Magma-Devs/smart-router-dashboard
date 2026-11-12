import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { LokiClient } from "../services/loki-client.js";
import { TransactionsService } from "../services/transactions.js";
import { ErrorRequestsService } from "../services/error-requests.js";
import { TransactionsOverTimeService } from "../services/transactions-over-time.js";
import { ErrorGroupsService } from "../services/error-groups.js";
import { config, lokiUrl } from "../config.js";

declare module "fastify" {
  interface FastifyInstance {
    transactions: TransactionsService;
    transactionsOverTime: TransactionsOverTimeService;
    errorRequests: ErrorRequestsService;
    errorGroups: ErrorGroupsService;
  }
}

/**
 * Decorate the app with the services that read the router's logs from Loki
 * when LOKI_URL is set: the Transactions tab and its chart, the Errors tab's
 * request list and the Failed requests card's count, and the Errors tab's
 * groups, which read only the counts the ruler records of those lines.
 * Registered after the Prometheus plugin: they share its values-file service
 * to map upstreams to chains, and the chart reads the store's recorded counts
 * first.
 */
export const lokiPlugin = fp(async (app: FastifyInstance) => {
  const url = lokiUrl();
  const live = (name: string) => process.env[name]?.trim() || undefined;
  const auth = {
    username: live("LOKI_USERNAME") ?? config.loki.username,
    password: live("LOKI_PASSWORD") ?? config.loki.password,
    orgId: live("LOKI_ORG_ID") ?? config.loki.orgId,
  };
  const loki = url ? new LokiClient(url, config.loki.timeoutMs, app.log, auth) : null;
  const selector = process.env.LOKI_ROUTER_SELECTOR?.trim() || config.loki.routerSelector;
  app.decorate("transactions", new TransactionsService(loki, selector, app.routerConfig));
  app.decorate("transactionsOverTime", new TransactionsOverTimeService(app.prom, loki, selector, app.routerConfig));
  // The Failed requests card reads the counts the fleet Loki's ruler records
  // into the metrics store when they are there (RECORDED_OUTCOMES).
  app.decorate("errorRequests", new ErrorRequestsService(loki, selector, app.routerConfig, undefined, app.prom));
  // The Errors tab's groups over the whole window: the recorded counts only
  // (smartrouter_request_errors:count1m); without them the web groups the list.
  app.decorate("errorGroups", new ErrorGroupsService(app.prom, app.routerConfig));
});
