import type { FastifyInstance } from "fastify";
import { WINDOWS, toMetricWindow, type MetricWindow } from "@sr/shared";
import { sendApiError } from "../plugins/error-handler.js";

interface WindowQuery {
  window?: string;
  spec?: string;
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
  },
};

const tag = (summary: string, withSpec = true) => ({
  schema: {
    tags: ["Metrics"],
    summary,
    querystring: withSpec
      ? windowQuerySchema
      : { type: "object" as const, properties: { window: windowQuerySchema.properties.window } },
  },
});

export async function metricRoutes(app: FastifyInstance) {
  // List of chains (spec labels) currently emitting metrics.
  app.get("/api/metrics/specs", { schema: { tags: ["Metrics"], summary: "Chains currently emitting metrics" } }, async () => ({
    specs: await app.metrics.listSpecs(),
  }));

  // HeroPanel cards (Metrics · Overview tab).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/dashboard-summary", tag("HeroPanel summary (KPIs + prior-window deltas)", false), async (request) => {
    return app.metrics.dashboardSummary(parseWindow(request.query.window));
  });

  // Rich Overview/Dashboard payload (KPIs + deltas + series + per-chain).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/overview", tag("Rich Overview/Dashboard payload (KPIs, deltas, series, per-chain)"), async (request) => {
    return app.metrics.overview(parseWindow(request.query.window), request.query.spec);
  });

  // Dashboard page payload (Overview + Metrics tabs). The chains multiselect
  // filters per-chain series CLIENT-side; `spec` is accepted for symmetry.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/dashboard", tag("Dashboard page payload (KPIs + series; unbacked families null)"), async (request) => {
    return app.metricsDashboard.dashboard(parseWindow(request.query.window), request.query.spec);
  });

  // Per-chain rollup (RouterOverview table).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/chains", tag("Per-chain rollup", false), async (request) => {
    return { chains: await app.metrics.chains(parseWindow(request.query.window)) };
  });

  // Upstream roster (optionally scoped to one spec).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/upstreams", tag("Upstream roster + selection scores"), async (request) => {
    const { spec } = request.query;
    return { upstreams: await app.metrics.upstreams(spec, parseWindow(request.query.window)) };
  });

  // RPS time-series for the Traffic chart.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/rps", tag("RPS time-series"), async (request) => {
    const { spec } = request.query;
    return app.metrics.rpsSeries(spec, parseWindow(request.query.window));
  });

  // Traffic tab: aggregate RPS-now + per-chain rows (rpsNow, requests, share, trend).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/traffic", tag("Traffic tab (aggregate + per-chain rps/share/trend)", false), async (request) => {
    return app.metrics.traffic(parseWindow(request.query.window));
  });

  // Method-level breakdown + read/write/batch class totals.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/methods", tag("Method-level breakdown + class totals"), async (request) => {
    const { spec } = request.query;
    return app.metrics.methods(spec, parseWindow(request.query.window));
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
    return app.metricsDetail.chainSeries(spec, parseWindow(request.query.window));
  });

  // Upstream deep-dive (PMBody).
  app.get<{ Querystring: { window?: string; endpointId?: string } }>("/api/metrics/upstream-detail", {
    schema: {
      tags: ["Metrics"],
      summary: "Upstream deep-dive (stats, series, QoS sub-scores)",
      querystring: {
        type: "object" as const,
        required: ["endpointId"],
        properties: {
          window: windowQuerySchema.properties.window,
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
    return app.metricsDetail.upstreamDetail(endpointId, parseWindow(request.query.window));
  });

  // Errors-breakdown tab (derived totals/hotspots/pivots + family presence).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/errors", tag("Errors breakdown (hotspots + pivots)"), async (request) => {
    const { spec } = request.query;
    return app.metricsDetail.errors(parseWindow(request.query.window), spec);
  });

  // Chains whose every backing endpoint is down (CurrentlyUnavailable strip).
  app.get("/api/metrics/unavailable", { schema: { tags: ["Metrics"], summary: "Chains with every endpoint down" } }, async () => ({
    unavailable: await app.metricsDetail.unavailable(),
  }));

  // Cross-validation panel (absent-until-fired; consistency_* is real).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/cross-validation", tag("Cross-validation panel (emitted:false until the family fires)", false), async (request) => {
    return app.metricsDetail.crossValidation(parseWindow(request.query.window));
  });

  // WebSocket panel (absent until a subscription opens).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/websocket", tag("WebSocket panel (emitted:false until ws_* fires)", false), async (request) => {
    return app.metricsDetail.websocket(parseWindow(request.query.window));
  });

  // Raw instant PromQL passthrough (used by ad-hoc panels). Bounded to GET.
  app.get<{ Querystring: { query?: string } }>("/api/metrics/query", {
    schema: {
      tags: ["Metrics"],
      summary: "Raw instant PromQL passthrough",
      querystring: { type: "object" as const, required: ["query"], properties: { query: { type: "string" as const } } },
    },
  }, async (request, reply) => {
    const expr = request.query.query;
    if (!expr) {
      sendApiError(reply, 400, "query is required");
      return reply;
    }
    return { result: await app.prom.query(expr) };
  });
}
