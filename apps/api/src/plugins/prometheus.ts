import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { PrometheusClient } from "../services/prometheus-client.js";
import { MetricsService } from "../services/metrics.js";
import { MetricsDetailService } from "../services/metrics-detail.js";
import { MetricsDashboardService } from "../services/metrics-dashboard.js";
import { ConfigurationService } from "../services/configuration.js";
import { ROUTER_METRICS } from "@sr/shared";
import { config, readMetricsScope } from "../config.js";

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
  // The deployment scope rides on the ONE client everything derives from —
  // `withScope` copies below inherit it, so the router scope stacks on top and
  // the scope-discovery query lists only this deployment's routers. A bad
  // pair throws here and the boot fails with the reason.
  const baseScope = readMetricsScope();
  if (baseScope && baseScope.label === config.prometheus.routerScopeLabel) {
    // Two matchers on one label: the same value is redundant, different
    // values are an empty result. Neither is what anyone configured.
    throw new Error(
      `METRICS_SCOPE_LABEL and ROUTER_SCOPE_LABEL are both "${baseScope.label}" — the deployment scope and the per-router scope must select on different labels`,
    );
  }
  const prom = new PrometheusClient(undefined, undefined, null, undefined, { baseScope, logger: app.log });
  if (baseScope) {
    app.log.info({ scope: baseScope }, `metrics scope: every query carries ${baseScope.label}="${baseScope.value}"`);
    // A value that matches nothing is every panel empty with no error
    // anywhere — the failure the customer described, one typo away. The
    // health gauge is exported by every running router, traffic or not, so
    // a zero here means the scope selects no router. Advisory: a zone still
    // provisioning is also zero, and readiness must not hinge on it.
    app.addHook("onReady", async () => {
      const routers = await prom.scalar(`count(${ROUTER_METRICS.overallHealth})`);
      if (!routers) {
        app.log.warn(
          { scope: baseScope, probe: ROUTER_METRICS.overallHealth },
          `metrics scope ${baseScope.label}="${baseScope.value}" matches no router series — check METRICS_SCOPE_VALUE; every panel stays empty until a router in this scope reports`,
        );
      }
    });
  }
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
