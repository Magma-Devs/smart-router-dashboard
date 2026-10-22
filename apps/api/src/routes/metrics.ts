import type { FastifyInstance, FastifyReply } from "fastify";
import { DEFAULT_WINDOW, WINDOWS, toMetricWindow, type MetricWindow } from "@sr/shared";
import { sendApiError } from "../plugins/error-handler.js";
import { config } from "../config.js";
import { SnapshotStore } from "../services/snapshot.js";

/**
 * What an answer carries, which sets how long its snapshot is kept:
 *  - `window`  figures over the window only;
 *  - `live`    figures about now as well (health, a latest block, in-flight, a
 *              current rate), or the Errors tab, which is read during an incident;
 *  - `instant` no window;
 *  - `pulse`   the topbar's, polled every 30 s.
 */
export type SnapshotKind = "window" | "live" | "instant" | "pulse";

/**
 * How long a window's answer is kept, ms; 0 is the base (`METRICS_SNAPSHOT_TTL_MS`).
 * At most one chart point of the window (`chartSampling`), so a chart is never
 * more than a point behind; from 3h the window reads recorded series, which
 * move once a minute.
 */
export const SNAPSHOT_WINDOW_TTL_MS: Record<MetricWindow, number> = {
  "5m": 0,
  "15m": 0,
  "30m": 0,
  "1h": 0,
  "3h": 60_000,
  "6h": 60_000,
  "12h": 60_000,
  "1d": 300_000,
  "3d": 300_000,
  "7d": 900_000,
  "14d": 900_000,
  "21d": 900_000,
  "30d": 900_000,
};

/** Figures about now are kept no longer than this. */
export const SNAPSHOT_LIVE_MAX_MS = 60_000;

/** The topbar polls the pulse every 30 s. */
export const SNAPSHOT_PULSE_MS = 30_000;

/** One answer's TTL: never under the base; 0 when the base is (the snapshot is off). */
export function snapshotTtlMs(kind: SnapshotKind, window: MetricWindow | null, baseMs: number): number {
  if (!(baseMs > 0)) return 0;
  const byWindow = window === null || kind === "instant" ? 0 : SNAPSHOT_WINDOW_TTL_MS[window];
  const ttl =
    kind === "pulse" ? SNAPSHOT_PULSE_MS : kind === "live" ? Math.min(byWindow, SNAPSHOT_LIVE_MAX_MS) : byWindow;
  return Math.max(baseMs, ttl);
}

export interface MetricRoutesOptions {
  /** The base snapshot TTL; `METRICS_SNAPSHOT_TTL_MS` when unset. */
  snapshotTtlMs?: number;
}

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
      description: `Time window (default ${DEFAULT_WINDOW}; 24h is an alias of 1d)`,
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
        "Restrict to the upstreams ONE config router declares — an id from GET /api/config/routers. A different axis from `router`: this filters rows against the mounted values file, it does not narrow the PromQL. Read by /api/metrics/upstreams and overview health counts (optional)",
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

export async function metricRoutes(app: FastifyInstance, opts: MetricRoutesOptions = {}) {
  // Every route below that reads the store answers from one snapshot per route
  // and query, shared by every caller of this process. Nothing here varies by
  // caller: no route reads the session, and the auth gate is an onRequest hook.
  const baseTtlMs = opts.snapshotTtlMs ?? config.prometheus.snapshotTtlMs;
  const snapshots = new SnapshotStore({ logger: app.log });
  // A refresh in flight finishes before close does, so none outlives the app.
  app.addHook("onClose", () => snapshots.idle());

  /**
   * The answer from the snapshot, keyed on the route and the parameters it
   * reads as parsed, with `Age` saying how old it is. Off, `read` runs.
   */
  async function snapshot<T>(
    reply: FastifyReply,
    kind: SnapshotKind,
    window: MetricWindow | null,
    key: unknown[],
    read: () => Promise<T>,
  ): Promise<T> {
    const ttlMs = snapshotTtlMs(kind, window, baseTtlMs);
    if (ttlMs <= 0) return read();
    const { value, at } = await snapshots.get(JSON.stringify(key), ttlMs, read);
    reply.header("age", String(Math.max(0, Math.floor((Date.now() - at) / 1000))));
    // Not CORS-safelisted: the browser reads it only when it is exposed.
    const exposed = String(reply.getHeader("access-control-expose-headers") ?? "");
    if (!/(^|,)\s*age\s*(,|$)/i.test(exposed)) {
      reply.header("access-control-expose-headers", exposed ? `${exposed}, Age` : "Age");
    }
    return value;
  }
  /** `scoped()` reads an empty router as none. */
  const scopeKey = (router: string | undefined) => router || null;

  // Routers this Prometheus can tell apart — the distinct values of the
  // ROUTER_SCOPE_LABEL target label. Empty when the collector attaches no such
  // label (a single static scrape target, say), which is how the UI knows not
  // to offer the filter rather than offering one that does nothing.
  app.get("/api/metrics/routers", {
    schema: { tags: ["Metrics"], summary: "Router deployments the metrics can be scoped to" },
  }, async (_request, reply) =>
    snapshot(reply, "instant", null, ["routers"], async () => {
      const label = await app.routerScopeLabel();
      return { label, routers: await app.metrics.listRouterScopes(label) };
    }));

  // List of chains (spec labels) currently emitting metrics.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/specs", {
    schema: {
      tags: ["Metrics"],
      summary: "Chains currently emitting metrics",
      querystring: { type: "object" as const, properties: { router: windowQuerySchema.properties.router } },
    },
  }, async (request, reply) => {
    const { router } = request.query;
    return snapshot(reply, "instant", null, ["specs", scopeKey(router)], async () => ({
      specs: await app.scoped(router).metrics.listSpecs(),
    }));
  });

  // HeroPanel cards (Metrics · Overview tab).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/dashboard-summary", tag("HeroPanel summary (KPIs + prior-window deltas)", false), async (request, reply) => {
    const { spec, router } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "live", window, ["dashboard-summary", window, spec ?? null, scopeKey(router)], () =>
      app.scoped(router).metrics.dashboardSummary(window, spec));
  });

  // How long windows are being read right now — recorded series (the store's
  // recording rules) or raw — and why. For operators: whether the store has
  // the rules, whether they are behind, and which windows they cover. Process
  // state, not a store read, so never snapshotted.
  app.get("/api/metrics/reads", {
    schema: {
      tags: ["Metrics"],
      summary: "How the api reads long windows now: the store's recorded series or the raw families, and why",
    },
  }, async () => app.recordedReads());

  // The topbar's health badge + live RPS, on every page: six reads, no
  // window. Takes the same two router axes as the overview it replaces there.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/pulse", {
    schema: {
      tags: ["Metrics"],
      summary: "Topbar pulse: router health, upstream health counts, current RPS",
      querystring: {
        type: "object" as const,
        properties: {
          spec: windowQuerySchema.properties.spec,
          router: windowQuerySchema.properties.router,
          routerId: windowQuerySchema.properties.routerId,
        },
      },
    },
  }, async (request, reply) => {
    const { spec, router, routerId } = request.query;
    return snapshot(reply, "pulse", null, ["pulse", spec ?? null, scopeKey(router), routerId ?? null], () =>
      app.scoped(router).metrics.pulse(spec, routerId));
  });

  // Rich Overview/Dashboard payload (KPIs + deltas + series + per-chain).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/overview", tag("Rich Overview/Dashboard payload (KPIs, deltas, series, per-chain)"), async (request, reply) => {
    const { spec, router, routerId } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "live", window, ["overview", window, spec ?? null, scopeKey(router), routerId ?? null], () =>
      app.scoped(router).metrics.overview(window, spec, routerId));
  });

  // Dashboard page payload (Overview + Metrics tabs). The chains multiselect
  // filters per-chain series CLIENT-side; `spec` is accepted for symmetry.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/dashboard", tag("Dashboard page payload (KPIs + series; unbacked families null)"), async (request, reply) => {
    const { spec, router } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "live", window, ["dashboard", window, spec ?? null, scopeKey(router)], () =>
      app.scoped(router).metricsDashboard.dashboard(window, spec));
  });

  // Per-ROUTER rollup (the Routers table). One row per config router — see the
  // service comment for what can and cannot be attributed to one.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/routers-rollup", tag("Per-router rollup (one row per config router)", false), async (request, reply) => {
    const { router } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "live", window, ["routers-rollup", window, scopeKey(router)], async () => ({
      routers: await app.scoped(router).metrics.routers(window, await app.routerScopeLabel()),
    }));
  });

  // Per-chain rollup.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/chains", tag("Per-chain rollup", false), async (request, reply) => {
    const { router } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "live", window, ["chains", window, scopeKey(router)], async () => ({
      chains: await app.scoped(router).metrics.chains(window),
    }));
  });

  // Upstream roster (optionally scoped to one spec and/or one config router).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/upstreams", tag("Upstream roster + selection scores"), async (request, reply) => {
    const { spec, router, routerId } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "live", window, ["upstreams", window, spec ?? null, scopeKey(router), routerId ?? null], async () => ({
      upstreams: await app.scoped(router).metrics.upstreams(spec, window, routerId),
    }));
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
  }, async (request, reply) => {
    const { spec, router, routerId } = request.query;
    return snapshot(reply, "instant", null, ["block-heights", spec ?? null, scopeKey(router), routerId ?? null], async () =>
      app.scoped(router).metrics.blockTips(await app.routerScopeLabel(), spec, routerId));
  });

  // RPS time-series for the Traffic chart.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/rps", tag("RPS time-series"), async (request, reply) => {
    const { spec, router } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "window", window, ["rps", window, spec ?? null, scopeKey(router)], () =>
      app.scoped(router).metrics.rpsSeries(spec, window));
  });

  // Aggregate RPS-now + per-chain rows (rpsNow, requests, share, trend). No web
  // consumer since the Traffic tab went; kept as a documented read surface.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/traffic", tag("Aggregate + per-chain rps/share/trend", false), async (request, reply) => {
    const { router } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "window", window, ["traffic", window, scopeKey(router)], () =>
      app.scoped(router).metrics.traffic(window));
  });

  // Method-level breakdown + read/write/batch class totals.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/methods", tag("Method-level breakdown (client-scoped requests, real per-method p95) + class totals"), async (request, reply) => {
    const { spec, router } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "window", window, ["methods", window, spec ?? null, scopeKey(router)], () =>
      app.scoped(router).metrics.methods(spec, window));
  });

  // ChainDetail expandable-row series bundle (metric switcher).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/chain-series", {
    schema: {
      tags: ["Metrics"],
      summary: "ChainDetail time-series bundle (availability/p95/errors/rps/qos)",
      querystring: { ...windowQuerySchema, required: ["spec"] },
    },
  }, async (request, reply) => {
    const { spec, router } = request.query;
    if (!spec) {
      sendApiError(reply, 400, "spec is required");
      return reply;
    }
    const window = parseWindow(request.query.window);
    return snapshot(reply, "window", window, ["chain-series", window, spec, scopeKey(router)], () =>
      app.scoped(router).metricsDetail.chainSeries(spec, window));
  });

  // Every upstream of one chain side by side - the deep-dive's volume, latency
  // and latest-block charts read the selected upstream against these.
  app.get<{ Querystring: { window?: string; spec?: string; router?: string } }>("/api/metrics/upstream-peers", {
    schema: {
      tags: ["Metrics"],
      summary: "Every upstream of one chain: p95 latency, requests per second and latest block over the window, one series per upstream",
      querystring: {
        type: "object" as const,
        required: ["spec"],
        properties: {
          window: windowQuerySchema.properties.window,
          router: windowQuerySchema.properties.router,
          spec: { type: "string" as const, description: "Chain spec label, e.g. ETH1" },
        },
      },
    },
  }, async (request, reply) => {
    const { spec, router } = request.query;
    if (!spec) {
      sendApiError(reply, 400, "spec is required");
      return reply;
    }
    const window = parseWindow(request.query.window);
    return snapshot(reply, "window", window, ["upstream-peers", window, spec, scopeKey(router)], () =>
      app.scoped(router).metricsDetail.upstreamPeers(spec, window));
  });

  // Upstream deep-dive (PMBody). An upstream is a name ON A CHAIN — vendors
  // reuse one node name across every chain they serve — so `spec` is required.
  app.get<{ Querystring: { window?: string; endpointId?: string; spec?: string; router?: string } }>("/api/metrics/upstream-detail", {
    schema: {
      tags: ["Metrics"],
      summary: "Upstream deep-dive (stats, series, QoS sub-scores)",
      querystring: {
        type: "object" as const,
        required: ["endpointId", "spec"],
        properties: {
          window: windowQuerySchema.properties.window,
          router: windowQuerySchema.properties.router,
          endpointId: { type: "string" as const, description: "Backing endpoint id (= upstream name)" },
          spec: { type: "string" as const, description: "Chain the upstream serves (Lava spec index)" },
        },
      },
    },
  }, async (request, reply) => {
    const { endpointId, spec, router } = request.query;
    if (!endpointId || !spec) {
      sendApiError(reply, 400, "endpointId and spec are required");
      return reply;
    }
    const window = parseWindow(request.query.window);
    return snapshot(reply, "live", window, ["upstream-detail", window, spec, endpointId, scopeKey(router)], () =>
      app.scoped(router).metricsDetail.upstreamDetail({ spec, endpointId }, window));
  });

  // Errors-breakdown tab (derived totals/hotspots/pivots + family presence).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/errors", tag("Errors tab: failed tries, hotspots + pivots"), async (request, reply) => {
    const { spec, router, routerId } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "live", window, ["errors", window, spec ?? null, scopeKey(router), routerId ?? null], () =>
      app.scoped(router).metricsDetail.errors(window, spec, routerId));
  });

  // The Errors tab's retry cards (retried / recovered / failed). Its request
  // list is GET /api/error-requests, from the router's logs.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/retries", tag("Errors tab retry cards (retried, recovered, failed, rates)"), async (request, reply) => {
    const { spec, router } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "live", window, ["retries", window, spec ?? null, scopeKey(router)], () =>
      app.scoped(router).metricsDetail.retries(window, spec));
  });

  // Chains whose every backing endpoint is down (CurrentlyUnavailable strip).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/unavailable", {
    schema: {
      tags: ["Metrics"],
      summary: "Chains with every endpoint down",
      querystring: { type: "object" as const, properties: { router: windowQuerySchema.properties.router } },
    },
  }, async (request, reply) => {
    const { router } = request.query;
    return snapshot(reply, "instant", null, ["unavailable", scopeKey(router)], async () => ({
      unavailable: await app.scoped(router).metricsDetail.unavailable(),
    }));
  });

  // Cross-validation panel (absent-until-fired; consistency_* is real).
  app.get<{ Querystring: WindowQuery }>("/api/metrics/cross-validation", tag("Cross-validation panel (rounds/consensus/reasons; emitted:false until the family fires)", false), async (request, reply) => {
    const { router } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "window", window, ["cross-validation", window, scopeKey(router)], () =>
      app.scoped(router).metricsDetail.crossValidation(window));
  });

  // WebSocket panel (absent until a subscription opens). Lifetime totals and
  // the live connection gauge, whatever the window.
  app.get<{ Querystring: WindowQuery }>("/api/metrics/websocket", tag("WebSocket panel (lifetime totals since router start; emitted:false until ws_* fires)", false), async (request, reply) => {
    const { router } = request.query;
    const window = parseWindow(request.query.window);
    return snapshot(reply, "live", window, ["websocket", window, scopeKey(router)], () =>
      app.scoped(router).metricsDetail.websocket(window));
  });

  // Raw instant PromQL passthrough (used by ad-hoc panels). Never snapshotted:
  // the query is the caller's. Bounded to GET.
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
      ? app.prom.withScope({ label: await app.routerScopeLabel(), value: request.query.router })
      : app.prom;
    return { result: await prom.query(expr) };
  });
}
