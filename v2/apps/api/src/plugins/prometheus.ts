import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { PrometheusClient } from "../services/prometheus-client.js";
import { MetricsService } from "../services/metrics.js";
import { ConfigurationService } from "../services/configuration.js";

declare module "fastify" {
  interface FastifyInstance {
    prom: PrometheusClient;
    metrics: MetricsService;
    routerConfig: ConfigurationService;
  }
}

/** Decorate the app with the Prometheus client + domain services. */
export const prometheusPlugin = fp(async (app: FastifyInstance) => {
  const prom = new PrometheusClient();
  app.decorate("prom", prom);
  app.decorate("metrics", new MetricsService(prom));
  app.decorate("routerConfig", new ConfigurationService());
});
