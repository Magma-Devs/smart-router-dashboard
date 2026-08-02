import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { PrometheusClient } from "../services/prometheus-client.js";
import { MetricsService } from "../services/metrics.js";
import { MetricsDetailService } from "../services/metrics-detail.js";
import { MetricsDashboardService } from "../services/metrics-dashboard.js";
import { ConfigurationService } from "../services/configuration.js";
import { config } from "../config.js";

/** Services bound to one router scope (or to the whole cluster when unset). */
export interface ScopedServices {
  metrics: MetricsService;
  metricsDetail: MetricsDetailService;
  metricsDashboard: MetricsDashboardService;
}

declare module "fastify" {
  interface FastifyInstance {
    prom: PrometheusClient;
    metrics: MetricsService;
    metricsDetail: MetricsDetailService;
    metricsDashboard: MetricsDashboardService;
    routerConfig: ConfigurationService;
    /**
     * Services restricted to the router named by `?router=` — the value of
     * the `ROUTER_SCOPE_LABEL` target label. Returns the unscoped services
     * for an absent or malformed value, so a bad query param reads
     * cluster-wide rather than silently returning a different slice.
     */
    scoped: (router?: string) => ScopedServices;
  }
}

/** Decorate the app with the Prometheus client + domain services. */
export const prometheusPlugin = fp(async (app: FastifyInstance) => {
  const prom = new PrometheusClient();
  const routerConfig = new ConfigurationService();
  app.decorate("prom", prom);
  app.decorate("routerConfig", routerConfig);
  // The config service feeds provider role (primary/backup) + backup-share.
  const metrics = new MetricsService(prom, routerConfig);
  const metricsDetail = new MetricsDetailService(prom, routerConfig);
  const metricsDashboard = new MetricsDashboardService(prom);
  app.decorate("metrics", metrics);
  app.decorate("metricsDetail", metricsDetail);
  app.decorate("metricsDashboard", metricsDashboard);

  const unscoped: ScopedServices = { metrics, metricsDetail, metricsDashboard };
  app.decorate("scoped", (router?: string): ScopedServices => {
    if (!router) return unscoped;
    const scopedProm = prom.withScope({ label: config.prometheus.routerScopeLabel, value: router });
    // withScope returns `this` when the scope is unusable — no point building
    // a second set of services around the same client.
    if (scopedProm === prom) return unscoped;
    return {
      metrics: new MetricsService(scopedProm, routerConfig),
      metricsDetail: new MetricsDetailService(scopedProm, routerConfig),
      metricsDashboard: new MetricsDashboardService(scopedProm),
    };
  });
});
