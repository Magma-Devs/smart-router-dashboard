import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { readMetricsScope } from "../config.js";

/**
 * `?router=` scoping. The router labels its series with the CHAIN, so two
 * routers serving one chain merge; the scope re-splits them on the collector's
 * per-target label. These tests assert on the PromQL that actually leaves the
 * api — the failure mode being silently returning cluster-wide numbers under a
 * per-router view.
 */

let app: FastifyInstance | null = null;
let sent: string[] = [];

/**
 * Records every query and answers with an empty (but valid) result set.
 * `present` names optional families whose presence probe answers 1, so the
 * reads behind them are issued.
 */
function mockPrometheus(routerLabelValues: string[] = [], present: string[] = [], routersInScope = 1): void {
  sent = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = typeof input === "string" ? input : input.toString();

    const query = new URL(url).searchParams.get("query") ?? "";
    sent.push(query);

    // The deployment-scope sanity probe at boot.
    if (/^count\(smartrouter_overall_health\{/.test(query)) {
      const result = routersInScope > 0 ? [{ metric: {}, value: [1, String(routersInScope)] }] : [];
      return Response.json({ status: "success", data: { resultType: "vector", result } });
    }

    // The scope-discovery aggregation is the only one that needs real rows.
    const scopeMatch = /^count by \((\w+)\) \(smartrouter_requests_total/.exec(query);
    const probed = /^count\(\{(?:[^}]*,)?__name__="([^"]+)"\}\)$/.exec(query)?.[1];
    const result = scopeMatch
      ? routerLabelValues.map((v) => ({ metric: { [scopeMatch[1]!]: v }, value: [1, "1"] }))
      : probed && present.includes(probed)
        ? [{ metric: {}, value: [1, "1"] }]
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

describe("readMetricsScope", () => {
  it("is null when neither half is set — no matcher, the whole store", () => {
    expect(readMetricsScope({})).toBeNull();
    expect(readMetricsScope({ METRICS_SCOPE_LABEL: "", METRICS_SCOPE_VALUE: "" })).toBeNull();
  });

  it("returns the pair", () => {
    expect(readMetricsScope({ METRICS_SCOPE_LABEL: "zone", METRICS_SCOPE_VALUE: "eu-west" })).toEqual({
      label: "zone",
      value: "eu-west",
    });
  });

  it("refuses half a pair — a scoped name over an unscoped read is the bug this prevents", () => {
    expect(() => readMetricsScope({ METRICS_SCOPE_LABEL: "zone" })).toThrow(/set together/);
    expect(() => readMetricsScope({ METRICS_SCOPE_VALUE: "eu-west" })).toThrow(/set together/);
  });

  it("refuses a label or value that cannot be a matcher", () => {
    expect(() => readMetricsScope({ METRICS_SCOPE_LABEL: "app.kubernetes.io/zone", METRICS_SCOPE_VALUE: "a" })).toThrow(
      /not a Prometheus label name/,
    );
    expect(() => readMetricsScope({ METRICS_SCOPE_LABEL: "zone", METRICS_SCOPE_VALUE: 'a" or b="c' })).toThrow(
      /cannot be embedded/,
    );
  });
});

describe("METRICS_SCOPE_LABEL / METRICS_SCOPE_VALUE (deployment scope)", () => {
  const saved: Record<string, string | undefined> = {};

  function setScope(label: string | undefined, value: string | undefined): void {
    saved.METRICS_SCOPE_LABEL = process.env.METRICS_SCOPE_LABEL;
    saved.METRICS_SCOPE_VALUE = process.env.METRICS_SCOPE_VALUE;
    if (label === undefined) delete process.env.METRICS_SCOPE_LABEL;
    else process.env.METRICS_SCOPE_LABEL = label;
    if (value === undefined) delete process.env.METRICS_SCOPE_VALUE;
    else process.env.METRICS_SCOPE_VALUE = value;
  }

  afterEach(() => {
    for (const k of ["METRICS_SCOPE_LABEL", "METRICS_SCOPE_VALUE"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const ROUTES = [
    "/api/metrics/overview",
    "/api/metrics/dashboard",
    "/api/metrics/chains",
    "/api/metrics/upstreams",
    "/api/metrics/errors",
    "/api/metrics/specs",
    "/api/metrics/chain-series?spec=ETH1",
  ];

  it.each(ROUTES)("puts the deployment matcher on every metric selector of %s", async (route) => {
    setScope("zone", "eu-west");
    app = await buildApp();

    const res = await app.inject({ method: "GET", url: route });
    expect(res.statusCode).toBe(200);

    const queries = metricQueries();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((q) => !q.includes('zone="eu-west"'))).toEqual([]);
  });

  it("reaches the cache sidecar's families too — the deployment owns the cache", async () => {
    mockPrometheus([], ["cache_total_hits"]);
    setScope("zone", "eu-west");
    app = await buildApp();

    // The hero cards read the cache hit rate once its presence probe answers.
    expect((await app.inject({ method: "GET", url: "/api/metrics/dashboard-summary" })).statusCode).toBe(200);
    const cacheReads = sent.filter((q) => q.includes("cache_total_hits") && !q.includes("__name__"));
    expect(cacheReads.length).toBeGreaterThan(0);
    for (const q of cacheReads) {
      expect(q).not.toMatch(/cache_total_(?:hits|misses)(?!\{zone="eu-west")/);
    }
  });

  it("narrows router discovery, so the filter lists only this deployment's routers", async () => {
    setScope("zone", "eu-west");
    app = await buildApp();

    expect((await app.inject({ method: "GET", url: "/api/metrics/routers" })).statusCode).toBe(200);
    expect(sent).toContain('count by (service) (smartrouter_requests_total{zone="eu-west"})');
  });

  it("stacks the per-request router scope on top", async () => {
    setScope("zone", "eu-west");
    app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/metrics/chains?router=eth-router" });
    expect(res.statusCode).toBe(200);

    // The boot probe runs on the base client (deployment scope only) — it is
    // not a request and carries no router.
    const queries = metricQueries().filter((q) => !q.startsWith("count(smartrouter_overall_health{"));
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((q) => !q.includes('service="eth-router"') || !q.includes('zone="eu-west"'))).toEqual([]);
  });

  it("scopes the raw PromQL passthrough", async () => {
    setScope("zone", "eu-west");
    app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/metrics/query?query=smartrouter_overall_health" });
    expect(res.statusCode).toBe(200);
    expect(sent).toContain('smartrouter_overall_health{zone="eu-west"}');
  });

  it("leaves the readiness probe unscoped", async () => {
    setScope("zone", "eu-west");
    app = await buildApp();

    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
    expect(sent).toContain("vector(1)");
    expect(sent.filter((q) => q.startsWith("vector(1)") && q.includes("zone="))).toEqual([]);
  });

  it("probes the scope once at boot and warns when it selects no router", async () => {
    mockPrometheus([], [], 0);
    setScope("zone", "eu-wesst");
    app = await buildApp();
    const warned: string[] = [];
    app.log.warn = ((...args: unknown[]) => {
      warned.push(String(args[args.length - 1]));
    }) as typeof app.log.warn;

    await app.ready();
    expect(sent).toEqual(['count(smartrouter_overall_health{zone="eu-wesst"})']);
    expect(warned.filter((m) => m.includes("matches no router series"))).toHaveLength(1);
    // Advisory: the pod is still ready.
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
  });

  it("stays quiet at boot when the scope selects routers", async () => {
    mockPrometheus([], [], 3);
    setScope("zone", "eu-west");
    app = await buildApp();
    const warned: string[] = [];
    app.log.warn = ((...args: unknown[]) => {
      warned.push(String(args[args.length - 1]));
    }) as typeof app.log.warn;

    await app.ready();
    expect(warned).toEqual([]);
  });

  it("does not probe at all without a scope", async () => {
    setScope(undefined, undefined);
    app = await buildApp();
    await app.ready();
    expect(sent).toEqual([]);
  });

  it("refuses to boot when the deployment label is the router-scope label", async () => {
    setScope("service", "eth-router");
    await expect(buildApp()).rejects.toThrow(/both "service"/);
  });

  it("sends nothing extra when unset — today's behaviour", async () => {
    setScope(undefined, undefined);
    app = await buildApp();

    expect((await app.inject({ method: "GET", url: "/api/metrics/chains" })).statusCode).toBe(200);
    expect(sent.filter((q) => q.includes("zone="))).toEqual([]);
  });

  it("refuses to boot on half a pair — never a scoped name over an unscoped read", async () => {
    setScope("zone", undefined);
    await expect(buildApp()).rejects.toThrow(/set together/);
  });

  it("refuses to boot on a value that could break out of the matcher", async () => {
    setScope("zone", 'x" or spec="ETH1');
    await expect(buildApp()).rejects.toThrow(/cannot be embedded/);
  });
});
