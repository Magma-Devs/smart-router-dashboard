import type { FastifyInstance } from "fastify";
import { DEFAULT_WINDOW, isMetricWindow, type MetricWindow } from "@sr/shared";
import { sendApiError } from "../plugins/error-handler.js";

interface WindowQuery {
  window?: string;
  spec?: string;
}

function parseWindow(raw: string | undefined): MetricWindow {
  return raw && isMetricWindow(raw) ? raw : DEFAULT_WINDOW;
}

export async function metricRoutes(app: FastifyInstance) {
  // List of chains (spec labels) currently emitting metrics.
  app.get("/api/metrics/specs", async () => ({ specs: await app.metrics.listSpecs() }));

  // Overview hero cards.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/dashboard-summary", async (request) => {
    return app.metrics.dashboardSummary(parseWindow(request.query.window));
  });

  // Rich Overview/Dashboard payload (KPIs + deltas + series + per-chain).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/overview", async (request) => {
    return app.metrics.overview(parseWindow(request.query.window));
  });

  // Per-chain rollup (Overview "Routers" table).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/chains", async (request) => {
    return { chains: await app.metrics.chains(parseWindow(request.query.window)) };
  });

  // Provider roster (optionally scoped to one spec).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/providers", async (request) => {
    const { spec } = request.query;
    return { providers: await app.metrics.providers(spec, parseWindow(request.query.window)) };
  });

  // RPS time-series for the Traffic chart.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/rps", async (request) => {
    const { spec } = request.query;
    return app.metrics.rpsSeries(spec, parseWindow(request.query.window));
  });

  // Traffic tab: aggregate RPS-now + per-chain rows (rpsNow, requests, share, trend).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/traffic", async (request) => {
    return app.metrics.traffic(parseWindow(request.query.window));
  });

  // Method-level breakdown (empty when the router emits no `method` label).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/methods", async (request) => {
    const { spec } = request.query;
    return { methods: await app.metrics.methods(spec, parseWindow(request.query.window)) };
  });

  // Raw instant PromQL passthrough (used by ad-hoc panels). Bounded to GET.
  app.get<{ Querystring: { query?: string } }>("/api/metrics/query", async (request, reply) => {
    const expr = request.query.query;
    if (!expr) {
      sendApiError(reply, 400, "query is required");
      return reply;
    }
    return { result: await app.prom.query(expr) };
  });
}
