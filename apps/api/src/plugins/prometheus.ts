import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { PrometheusClient } from "../services/prometheus-client.js";
import { MetricsService } from "../services/metrics.js";
import { MetricsDetailService } from "../services/metrics-detail.js";
import { MetricsDashboardService } from "../services/metrics-dashboard.js";
import { ConfigurationService } from "../services/configuration.js";

declare module "fastify" {
  interface FastifyInstance {
    prom: PrometheusClient;
    metrics: MetricsService;
    metricsDetail: MetricsDetailService;
    metricsDashboard: MetricsDashboardService;
    routerConfig: ConfigurationService;
  }
}

/** Decorate the app with the Prometheus client + domain services. */
export const prometheusPlugin = fp(async (app: FastifyInstance) => {
  const prom = new PrometheusClient();
  const routerConfig = new ConfigurationService();
  app.decorate("prom", prom);
  app.decorate("routerConfig", routerConfig);
  // The config service feeds provider role (primary/backup) + backup-share.
  app.decorate("metrics", new MetricsService(prom, routerConfig));
  app.decorate("metricsDetail", new MetricsDetailService(prom, routerConfig));
  app.decorate("metricsDashboard", new MetricsDashboardService(prom));
});
