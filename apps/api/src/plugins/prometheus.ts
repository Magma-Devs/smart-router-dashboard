import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { PrometheusClient } from "../services/prometheus-client.js";
import { MetricsService } from "../services/metrics.js";
import { MetricsDetailService } from "../services/metrics-detail.js";
import { MetricsDashboardService } from "../services/metrics-dashboard.js";
import { ConfigurationService } from "../services/configuration.js";
import { RECORDED, RECORDED_CHART_FLOOR, ROUTER_METRICS, recordedReadsPolicy, recordedWindows, scrapeIntervalMatches, setRecordedReads, type RecordedReadsState } from "@sr/shared";
import { ROUTER_SCOPE_CANDIDATES, config, readMetricsScope } from "../config.js";

/** Services bound to one router scope (or to the whole cluster when unset). */
export interface ScopedServices {
  metrics: MetricsService;
  metricsDetail: MetricsDetailService;
  metricsDashboard: MetricsDashboardService;
}

/** What the last freshness probe saw. */
interface RecordedReadsProbe {
  at: string | null;
  ageSec: number | null;
  historySec: number | null;
  /** Sample spacing of the densest raw router series, seconds; null when the store has none. */
  scrapeSec: number | null;
  /** The newest recorded sample is under the stale limit. */
  fresh: boolean;
  /** The spacing is the 15 s the rules' window is sized to (or unknown, with no router series). */
  scrapeOk: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    prom: PrometheusClient;
    /** The recorded-reads policy as the api applies it now — for `/api/metrics/reads`. */
    recordedReads: () => RecordedReadsState;
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
    /**
     * The target label the per-router scope selects on: `ROUTER_SCOPE_LABEL`
     * when set, else the first of `ROUTER_SCOPE_CANDIDATES` the store reports
     * values for. Resolved when a request first needs it, never at boot, and
     * remembered once found — so nobody has to tell the api which collector
     * scrapes it. Until something reports, it answers the first candidate and
     * asks again next time.
     */
    routerScopeLabel: () => Promise<string>;
  }
}

/** Decorate the app with the Prometheus client + domain services. */
export const prometheusPlugin = fp(async (app: FastifyInstance) => {
  // The deployment scope rides on the ONE client everything derives from —
  // `withScope` copies below inherit it, so the router scope stacks on top and
  // the scope-discovery query lists only this deployment's routers. A bad
  // pair throws here and the boot fails with the reason.
  const baseScope = readMetricsScope();
  const configured = config.prometheus.routerScopeLabel;
  // Two matchers on one label: the same value is redundant, different values
  // are an empty result. Neither is what anyone configured. With the router
  // label left to resolve itself, every candidate is off limits.
  const clash = configured
    ? baseScope?.label === configured
    : ROUTER_SCOPE_CANDIDATES.some((label) => label === baseScope?.label);
  if (baseScope && clash) {
    const how = configured ? "" : ` (ROUTER_SCOPE_LABEL is unset and resolves to ${ROUTER_SCOPE_CANDIDATES.join(" or ")})`;
    throw new Error(
      `METRICS_SCOPE_LABEL and ROUTER_SCOPE_LABEL are both "${baseScope.label}"${how} — the deployment scope and the per-router scope must select on different labels`,
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
  // Recorded reads: windows of `recordedFrom` and up read the store's
  // recorded series (promql/recorded.ts) — but only while those are fresh.
  // The series exist where the fleet store's ruler evaluates the rules, and
  // from then on; a store without them, or a ruler that stopped, must not
  // leave the long windows empty. One cheap read a minute asks how old the
  // newest recorded sample is; past `recordedStaleMs` (or absent) every
  // builder reads raw again. Transitions are logged once, not every probe.
  // Armed by the first metrics request, never at boot — readiness must not
  // hinge on the store — and that request waits for the one answer, so the
  // first page a tenant opens already reads the way the policy says.
  const recorded = config.prometheus.recorded;
  let probeTimer: NodeJS.Timeout | null = null;
  let armed = false;
  let lastProbe: RecordedReadsProbe = { at: null, ageSec: null, historySec: null, scrapeSec: null, fresh: false, scrapeOk: true };
  const probe = async (): Promise<void> => {
    const from = recorded.from;
    if (!from) return;
    // Three cheap reads: how old the newest recorded sample is, how far
    // back the oldest one within the widest window reaches, and how far
    // apart the raw router samples are — the rules' 2m15s window counts
    // exactly for a 15-second scrape and is phase-biased for any other. A
    // store that cannot answer the first is a store without fresh series.
    const [ageSec, historySec, scrapeSec] = await Promise.all([
      prom.scalar(`time() - max(timestamp(${RECORDED.requests}))`).catch(() => null),
      prom.scalar(`time() - min(min_over_time(timestamp(${RECORDED.requests})[${recorded.historyLookback}:1h]))`).catch(() => null),
      prom.scalar(`600 / max(count_over_time(${ROUTER_METRICS.requestsTotal}[10m]))`).catch(() => null),
    ]);
    const fresh = ageSec !== null && Number.isFinite(ageSec) && ageSec * 1000 <= recorded.staleMs;
    // No router series at all is not a wrong interval — there is nothing to be wrong about yet.
    const scrapeOk = scrapeSec === null || !Number.isFinite(scrapeSec) || scrapeIntervalMatches(scrapeSec);
    const available = fresh && scrapeOk;
    const history = available && historySec !== null && Number.isFinite(historySec) ? Math.max(0, Math.floor(historySec)) : null;
    const was = recordedReadsPolicy();
    setRecordedReads({ from, available, historySeconds: history });
    lastProbe = { at: new Date().toISOString(), ageSec, historySec: history, scrapeSec, fresh, scrapeOk };
    if (available && !was.available) {
      app.log.info({ ageSec, historySec: history, scrapeSec, from }, `recorded series are fresh — windows of ${from} and up read them where the history covers the window`);
    } else if (!available && was.available) {
      if (fresh && !scrapeOk) {
        app.log.warn({ scrapeSec, expected: 15 }, "the store does not scrape the routers every 15 s — the recorded series would be phase-biased, every window reads raw");
      } else {
        app.log.warn({ ageSec, series: RECORDED.requests }, "recorded series missing or stale — every window reads raw until they are fresh again");
      }
    }
  };
  app.decorate("recordedReads", (): RecordedReadsState => {
    const pol = recordedReadsPolicy();
    const reason: RecordedReadsState["reason"] =
      pol.from === null ? "off"
        : !armed ? "unprobed"
        : lastProbe.ageSec === null ? "absent"
        : !lastProbe.fresh ? "stale"
        : !lastProbe.scrapeOk ? "scrape"
        : "fresh";
    const windows = recordedWindows();
    return { from: pol.from, chartFloor: RECORDED_CHART_FLOOR, available: pol.available, reason, ageSec: lastProbe.ageSec, historySec: pol.historySeconds, scrapeSec: lastProbe.scrapeSec, probedAt: lastProbe.at, windows };
  });
  const armRecordedReads = async (): Promise<void> => {
    if (armed || !recorded.from) return;
    armed = true;
    await probe();
    probeTimer = setInterval(() => void probe(), recorded.probeMs);
    probeTimer.unref();
  };
  if (recorded.from) {
    setRecordedReads({ from: recorded.from, available: false });
    app.log.info(
      { from: recorded.from, staleMs: recorded.staleMs, probeMs: recorded.probeMs },
      `recorded reads: windows of ${recorded.from} and up read the recorded series while they are fresh`,
    );
  } else {
    setRecordedReads({ from: null, available: false });
  }
  app.addHook("preHandler", async (request) => {
    if (!armed && request.url.startsWith("/api/metrics")) await armRecordedReads();
  });
  app.addHook("onClose", async () => {
    if (probeTimer) clearInterval(probeTimer);
    setRecordedReads({ from: null, available: false });
  });
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

  // Which target label tells routers apart. Set: taken as is. Unset: the
  // first candidate the store reports values for, asked when a request first
  // needs it — never at boot, readiness must not hinge on the store — and
  // remembered once found. Until then every use asks again, so a store that
  // was still empty at the first request is picked up by a later one.
  let resolved: string | null = configured || null;
  const routerScopeLabel = async (): Promise<string> => {
    if (resolved) return resolved;
    for (const label of ROUTER_SCOPE_CANDIDATES) {
      if ((await metrics.listRouterScopes(label)).length > 0) {
        resolved = label;
        app.log.info({ label }, `router scope: the store tells routers apart on the "${label}" label`);
        return label;
      }
    }
    return ROUTER_SCOPE_CANDIDATES[0];
  };
  app.decorate("routerScopeLabel", routerScopeLabel);
  // `scoped()` is synchronous and every metrics route calls it: settle the
  // label before a `?router=` request reaches it.
  app.addHook("preHandler", async (request) => {
    const router = (request.query as { router?: unknown } | undefined)?.router;
    if (typeof router === "string" && router !== "" && !resolved) await routerScopeLabel();
  });

  const unscoped: ScopedServices = { metrics, metricsDetail, metricsDashboard };
  app.decorate("scoped", (router?: string): ScopedServices => {
    if (!router) return unscoped;
    const scopedProm = prom.withScope({ label: resolved ?? ROUTER_SCOPE_CANDIDATES[0], value: router });
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
