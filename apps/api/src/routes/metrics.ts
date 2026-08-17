import type { FastifyInstance } from "fastify";
import { WINDOWS, toMetricWindow, type MetricWindow } from "@sr/shared";
import { sendApiError } from "../plugins/error-handler.js";
import { config } from "../config.js";

interface WindowQuery {
  window?: string;
  spec?: string;
  /** Collector target-label scope — narrows the PromQL (see `promql/scope.ts`). */
  router?: string;
  /** Config router id — filters rows by the mounted values file, not the query. */
  routerId?: string;
}

function parseWindow(raw: string | undefined): MetricWindow {
  // Exact key → wire alias (24h ⇒ 1d) → default. Garbage falls back.
  return toMetricWindow(raw);
}

/** Shared OpenAPI querystring for window+spec routes. */
const windowQuerySchema = {
  type: "object" as const,
  properties: {
    window: {
      type: "string" as const,
      enum: [...Object.keys(WINDOWS), "24h"],
      description: "Time window (default 1d; 24h is an alias of 1d)",
    },
    spec: { type: "string" as const, description: "Chain spec label, e.g. ETH1 (optional)" },
    router: {
      type: "string" as const,
      description:
        "Restrict to ONE router deployment — a value of the ROUTER_SCOPE_LABEL target label, as listed by GET /api/metrics/routers (optional; omit for cluster-wide)",
    },
    routerId: {
      type: "string" as const,
      description:
        "Restrict to the upstreams ONE config router declares — an id from GET /api/config/routers. A different axis from `router`: this filters rows against the mounted values file, it does not narrow the PromQL. Read by /api/metrics/upstreams (optional)",
    },
  },
};

/** The window+router subset, for routes that don't take a spec. */
const windowRouterSchema = {
  type: "object" as const,
  properties: {
    window: windowQuerySchema.properties.window,
    router: windowQuerySchema.properties.router,
  },
};

const tag = (summary: string, withSpec = true) => ({
  schema: {
    tags: ["Metrics"],
    summary,
    querystring: withSpec ? windowQuerySchema : windowRouterSchema,
  },
});

export async function metricRoutes(app: FastifyInstance) {
  // Routers this Prometheus can tell apart — the distinct values of the
  // ROUTER_SCOPE_LABEL target label. Empty when the collector attaches no such
  // label (a single static scrape target, say), which is how the UI knows not
  // to offer the filter rather than offering one that does nothing.
  app.get("/api/metrics/routers", {
    schema: { tags: ["Metrics"], summary: "Router deployments the metrics can be scoped to" },
  }, async () => ({
    label: config.prometheus.routerScopeLabel,
    routers: await app.metrics.listRouterScopes(config.prometheus.routerScopeLabel),
  }));

  // List of chains (spec labels) currently emitting metrics.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/specs", {
    schema: {
      tags: ["Metrics"],
      summary: "Chains currently emitting metrics",
      querystring: { type: "object" as const, properties: { router: windowQuerySchema.properties.router } },
    },
  }, async (request) => ({
    specs: await app.scoped(request.query.router).metrics.listSpecs(),
  }));

  // HeroPanel cards (Metrics · Overview tab).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/dashboard-summary", tag("HeroPanel summary (KPIs + prior-window deltas)", false), async (request) => {
    return app.scoped(request.query.router).metrics.dashboardSummary(parseWindow(request.query.window), request.query.spec);
  });

  // Rich Overview/Dashboard payload (KPIs + deltas + series + per-chain).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/overview", tag("Rich Overview/Dashboard payload (KPIs, deltas, series, per-chain)"), async (request) => {
    return app.scoped(request.query.router).metrics.overview(parseWindow(request.query.window), request.query.spec);
  });

  // Dashboard page payload (Overview + Metrics tabs). The chains multiselect
  // filters per-chain series CLIENT-side; `spec` is accepted for symmetry.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/dashboard", tag("Dashboard page payload (KPIs + series; unbacked families null)"), async (request) => {
    return app.scoped(request.query.router).metricsDashboard.dashboard(parseWindow(request.query.window), request.query.spec);
  });

  // Per-chain rollup (RouterOverview table).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/chains", tag("Per-chain rollup", false), async (request) => {
    return { chains: await app.scoped(request.query.router).metrics.chains(parseWindow(request.query.window)) };
  });

  // Upstream roster (optionally scoped to one spec and/or one config router).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/upstreams", tag("Upstream roster + selection scores"), async (request) => {
    const { spec, routerId } = request.query;
    return {
      upstreams: await app
        .scoped(request.query.router)
        .metrics.upstreams(spec, parseWindow(request.query.window), routerId),
    };
  });

  // Latest block per router + per upstream (instant gauges — no window).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/block-heights", {
    schema: {
      tags: ["Metrics"],
      summary: "Latest block per router deployment and per upstream, with lag in seconds",
      querystring: {
        type: "object" as const,
        properties: {
          spec: windowQuerySchema.properties.spec,
          router: windowQuerySchema.properties.router,
          routerId: windowQuerySchema.properties.routerId,
        },
      },
    },
  }, async (request) => {
    return app
      .scoped(request.query.router)
      .metrics.blockTips(
        config.prometheus.routerScopeLabel,
        request.query.spec,
        request.query.routerId,
      );
  });

  // RPS time-series for the Traffic chart.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/rps", tag("RPS time-series"), async (request) => {
    const { spec } = request.query;
    return app.scoped(request.query.router).metrics.rpsSeries(spec, parseWindow(request.query.window));
  });

  // Traffic tab: aggregate RPS-now + per-chain rows (rpsNow, requests, share, trend).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/traffic", tag("Traffic tab (aggregate + per-chain rps/share/trend)", false), async (request) => {
    return app.scoped(request.query.router).metrics.traffic(parseWindow(request.query.window));
  });

  // Method-level breakdown + read/write/batch class totals.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/methods", tag("Method-level breakdown (client-scoped requests, real per-method p95) + class totals"), async (request) => {
    const { spec } = request.query;
    return app.scoped(request.query.router).metrics.methods(spec, parseWindow(request.query.window));
  });

  // ChainDetail expandable-row series bundle (metric switcher).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/chain-series", {
    schema: {
      tags: ["Metrics"],
      summary: "ChainDetail time-series bundle (availability/p95/errors/rps/qos)",
      querystring: { ...windowQuerySchema, required: ["spec"] },
    },
  }, async (request, reply) => {
    const { spec } = request.query;
    if (!spec) {
      sendApiError(reply, 400, "spec is required");
      return reply;
    }
    return app.scoped(request.query.router).metricsDetail.chainSeries(spec, parseWindow(request.query.window));
  });

  // Upstream deep-dive (PMBody).
  app.get<{ Querystring: { window?: string; endpointId?: string; router?: string } }>("/api/metrics/upstream-detail", {
    schema: {
      tags: ["Metrics"],
      summary: "Upstream deep-dive (stats, series, QoS sub-scores)",
      querystring: {
        type: "object" as const,
        required: ["endpointId"],
        properties: {
          window: windowQuerySchema.properties.window,
          router: windowQuerySchema.properties.router,
          endpointId: { type: "string" as const, description: "Backing endpoint id (= upstream name)" },
        },
      },
    },
  }, async (request, reply) => {
    const { endpointId } = request.query;
    if (!endpointId) {
      sendApiError(reply, 400, "endpointId is required");
      return reply;
    }
    return app.scoped(request.query.router).metricsDetail.upstreamDetail(endpointId, parseWindow(request.query.window));
  });

  // Errors-breakdown tab (derived totals/hotspots/pivots + family presence).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/errors", tag("Errors breakdown (hotspots + pivots)"), async (request) => {
    const { spec, routerId } = request.query;
    return app
      .scoped(request.query.router)
      .metricsDetail.errors(parseWindow(request.query.window), spec, routerId);
  });

  // Chains whose every backing endpoint is down (CurrentlyUnavailable strip).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/unavailable", {
    schema: {
      tags: ["Metrics"],
      summary: "Chains with every endpoint down",
      querystring: { type: "object" as const, properties: { router: windowQuerySchema.properties.router } },
    },
  }, async (request) => ({
    unavailable: await app.scoped(request.query.router).metricsDetail.unavailable(),
  }));

  // Cross-validation panel (absent-until-fired; consistency_* is real).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/cross-validation", tag("Cross-validation panel (rounds/consensus/reasons; emitted:false until the family fires)", false), async (request) => {
    return app.scoped(request.query.router).metricsDetail.crossValidation(parseWindow(request.query.window));
  });

  // WebSocket panel (absent until a subscription opens).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/websocket", tag("WebSocket panel (lifetime totals since router start; emitted:false until ws_* fires)", false), async (request) => {
    return app.scoped(request.query.router).metricsDetail.websocket(parseWindow(request.query.window));
  });

  // Raw instant PromQL passthrough (used by ad-hoc panels). Bounded to GET.
  app.get<{ Querystring: { query?: string; router?: string } }>("/api/metrics/query", {
    schema: {
      tags: ["Metrics"],
      summary: "Raw instant PromQL passthrough",
      querystring: {
        type: "object" as const,
        required: ["query"],
        properties: {
          query: { type: "string" as const },
          router: windowQuerySchema.properties.router,
        },
      },
    },
  }, async (request, reply) => {
    const expr = request.query.query;
    if (!expr) {
      sendApiError(reply, 400, "query is required");
      return reply;
    }
    // `router` scopes the passthrough too — the caller asked for one router's
    // numbers, and the injection understands arbitrary PromQL.
    const prom = request.query.router
      ? app.prom.withScope({ label: config.prometheus.routerScopeLabel, value: request.query.router })
      : app.prom;
    return { result: await prom.query(expr) };
  });
}
