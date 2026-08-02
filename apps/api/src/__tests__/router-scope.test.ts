import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

/**
 * `?router=` scoping. The router labels its series with the CHAIN, so two
 * routers serving one chain merge; the scope re-splits them on the collector's
 * per-target label. These tests assert on the PromQL that actually leaves the
 * api — the failure mode being silently returning cluster-wide numbers under a
 * per-router view.
 */

let app: FastifyInstance | null = null;
let sent: string[] = [];

/** Records every query and answers with an empty (but valid) result set. */
function mockPrometheus(routerLabelValues: string[] = []): void {
  sent = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/-/ready")) return new Response("ok", { status: 200 });

    const query = new URL(url).searchParams.get("query") ?? "";
    sent.push(query);

    // The scope-discovery aggregation is the only one that needs real rows.
    const scopeMatch = /^count by \((\w+)\) \(smartrouter_requests_total/.exec(query);
    const result = scopeMatch
      ? routerLabelValues.map((v) => ({ metric: { [scopeMatch[1]!]: v }, value: [1, "1"] }))
      : [];

    return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => mockPrometheus());

afterEach(async () => {
  await app?.close();
  app = null;
  vi.unstubAllGlobals();
});

/** Queries carrying at least one metric selector (the ones a scope must reach). */
function metricQueries(): string[] {
  return sent.filter((q) => /smartrouter_|rpc_endpoint_|rpc_optimizer_/.test(q));
}

describe("GET /api/metrics/routers", () => {
  it("lists the distinct values of the scope label, with the label itself", async () => {
    mockPrometheus(["hyperliquidstaging-router", "hyperliquidproduction-router"]);
    app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/metrics/routers" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      label: "service",
      routers: ["hyperliquidproduction-router", "hyperliquidstaging-router"], // sorted
    });
  });

  it("returns [] when the collector attaches no such label — 'can't split', not 'no routers'", async () => {
    mockPrometheus([]);
    app = await buildApp();

    expect(await app.inject({ method: "GET", url: "/api/metrics/routers" }).then((r) => r.json())).toEqual({
      label: "service",
      routers: [],
    });
  });
});

describe("?router= scoping", () => {
  const SCOPED_ROUTES = [
    "/api/metrics/overview",
    "/api/metrics/dashboard",
    "/api/metrics/dashboard-summary",
    "/api/metrics/chains",
    "/api/metrics/upstreams",
    "/api/metrics/traffic",
    "/api/metrics/methods",
    "/api/metrics/errors",
    "/api/metrics/cross-validation",
    "/api/metrics/websocket",
    "/api/metrics/unavailable",
    "/api/metrics/specs",
    "/api/metrics/chain-series?spec=ETH1",
    "/api/metrics/upstream-detail?endpointId=eth-lava",
  ];

  it.each(SCOPED_ROUTES)("scopes every metric selector on %s", async (route) => {
    app = await buildApp();
    const sep = route.includes("?") ? "&" : "?";

    const res = await app.inject({ method: "GET", url: `${route}${sep}router=eth-router` });
    expect(res.statusCode).toBe(200);

    const queries = metricQueries();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((q) => !q.includes('service="eth-router"'))).toEqual([]);
  });

  it.each(SCOPED_ROUTES)("stays cluster-wide on %s without the param", async (route) => {
    app = await buildApp();

    const res = await app.inject({ method: "GET", url: route });
    expect(res.statusCode).toBe(200);
    expect(sent.filter((q) => q.includes("service="))).toEqual([]);
  });

  it("ignores a value that could break out of the label matcher", async () => {
    app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/api/metrics/overview?router=${encodeURIComponent('x" or spec="ETH1')}`,
    });
    // Reads cluster-wide rather than becoming a different query — and the
    // injection attempt reaches Prometheus nowhere.
    expect(res.statusCode).toBe(200);
    expect(sent.filter((q) => q.includes("service="))).toEqual([]);
    expect(sent.filter((q) => q.includes('or spec="ETH1'))).toEqual([]);
  });

  it("scopes the raw PromQL passthrough too", async () => {
    app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/metrics/query?query=smartrouter_overall_health&router=eth-router",
    });
    expect(res.statusCode).toBe(200);
    expect(sent).toContain('smartrouter_overall_health{service="eth-router"}');
  });

  it("leaves the presence probes' quoted metric names intact", async () => {
    app = await buildApp();

    await app.inject({ method: "GET", url: "/api/metrics/errors?router=eth-router" });
    // `sent` holds post-injection queries, so match on the __name__ selector
    // rather than the shape the builder emitted.
    const probes = sent.filter((q) => q.includes("__name__="));
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(probe).toMatch(/^count\(\{service="eth-router",__name__=/);
    }
  });
});

describe("ROUTER_SCOPE_LABEL", () => {
  it("selects on the configured label instead of `service`", async () => {
    // config.ts parses env at import time, so the override needs a fresh
    // module graph.
    const saved = process.env.ROUTER_SCOPE_LABEL;
    process.env.ROUTER_SCOPE_LABEL = "job";
    vi.resetModules();
    try {
      const { buildApp: freshBuildApp } = await import("../app.js");
      app = await freshBuildApp();

      const res = await app.inject({ method: "GET", url: "/api/metrics/chains?router=eth-router" });
      expect(res.statusCode).toBe(200);

      const queries = metricQueries();
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.filter((q) => !q.includes('job="eth-router"'))).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.ROUTER_SCOPE_LABEL;
      else process.env.ROUTER_SCOPE_LABEL = saved;
      vi.resetModules();
    }
  });
});
