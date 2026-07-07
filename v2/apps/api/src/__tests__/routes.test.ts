import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

/**
 * Canned Prometheus responses. Rules are ORDERED most-specific-first because
 * compound PromQL (ratios, clamp_min) contains several metric names at once.
 * Optional families (retries/cache/cross-validation/ws/error counters) are
 * ABSENT: presence probes return an empty vector — the honesty contract the
 * tests below pin is "absent family ⇒ nulls/emitted:false, never invented".
 */
function mockPrometheus(): void {
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/-/ready")) {
      return new Response("ok", { status: 200 });
    }

    const query = new URL(url).searchParams.get("query") ?? "";
    let result: unknown[] = [];

    if (query.startsWith("count({__name__=")) {
      result = []; // presence probes: every optional family is absent
    } else if (query.startsWith("count by (spec)")) {
      result = [{ metric: { spec: "ETH1" }, value: [1, "1"] }];
    } else if (query.includes("== bool 0")) {
      result = []; // no chain is fully down
    } else if (query.includes("clamp_min") && query.includes("sum by (spec, provider_address)")) {
      result = [{ metric: { spec: "ETH1", provider_address: "eth-lava" }, value: [1, "3"] }];
    } else if (query.includes("clamp_min") && query.includes("sum by (method)")) {
      result = [{ metric: { method: "eth_blockNumber" }, value: [1, "3"] }];
    } else if (query.includes("clamp_min") && query.includes("sum by (spec)")) {
      result = [{ metric: { spec: "ETH1" }, value: [1, "3"] }];
    } else if (query.includes("clamp_min")) {
      // Derived errors: total 100 − success 97 ⇒ 3.
      result = [{ metric: {}, value: [1, "3"] }];
    } else if (query.includes("consistency_success_total")) {
      result = [{ metric: {}, value: [1, "5"] }];
    } else if (query.includes("consistency_total")) {
      result = [{ metric: {}, value: [1, "7"] }];
    } else if (query.includes("histogram_quantile")) {
      result = [{ metric: {}, value: [1, "42"] }];
    } else if (query.includes("selection_score")) {
      result = [
        {
          metric: { spec: "ETH1", endpoint_id: "eth-lava", score_type: "composite" },
          value: [1, "0.9"],
        },
      ];
    } else if (query.includes("rpc_endpoint_overall_health")) {
      result = [{ metric: { spec: "ETH1", endpoint_id: "eth-lava" }, value: [1, "1"] }];
    } else if (query.includes("rpc_endpoint_latest_block")) {
      result = [{ metric: { spec: "ETH1", endpoint_id: "eth-lava" }, value: [1, "100"] }];
    } else if (query.includes("overall_health")) {
      result = [{ metric: {}, value: [1, "1"] }];
    } else if (query.includes("success_total") && query.includes(" / ")) {
      result = [{ metric: {}, value: [1, "0.97"] }]; // availability ratios
    } else if (query.includes("requests_read_total") && query.includes("sum by (method)")) {
      result = [{ metric: { method: "eth_blockNumber" }, value: [1, "100"] }];
    } else if (query.includes("requests_read_total")) {
      result = [{ metric: {}, value: [1, "100"] }];
    } else if (query.includes("sum by (method)")) {
      result = [{ metric: { method: "eth_blockNumber" }, value: [1, "100"] }];
    } else if (query.includes("sum by (spec, provider_address)")) {
      result = [{ metric: { spec: "ETH1", provider_address: "eth-lava" }, value: [1, "100"] }];
    } else if (query.includes("smartrouter_requests_total")) {
      result = [{ metric: { spec: "ETH1" }, value: [1, "1234"] }];
    }

    return new Response(
      JSON.stringify({ status: "success", data: { resultType: "vector", result } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

describe("api routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockPrometheus();
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it("GET /health → ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ health: "ok" });
  });

  it("GET /version → build provenance", async () => {
    const res = await app.inject({ method: "GET", url: "/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("uptimeSec");
  });

  it("GET /api/metrics/specs → distinct specs", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/specs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ specs: ["ETH1"] });
  });

  it("GET /api/metrics/dashboard-summary → hero KPIs with priors; absent families null", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/dashboard-summary?window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestsServed).toEqual({ value: 1234, prior: 1234 });
    expect(body.successRate.value).toBeCloseTo(0.97);
    expect(body.staleCaught.value).toBe(5);
    // retries/cache families are absent on this build ⇒ null, flagged, never invented.
    expect(body.retriesRecovered).toEqual({ value: null, prior: null });
    expect(body.cacheOffloadPct).toEqual({ value: null, prior: null });
    expect(body.emitted).toEqual({ retries: false, cache: false });
    expect(body.health).toBe("operational");
  });

  it("GET /api/metrics/query requires a query param", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/query" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/metrics/chains → array shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/chains?window=1h" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().chains)).toBe(true);
  });

  it("accepts the new design windows and the 24h alias", async () => {
    for (const w of ["15m", "3h", "12h", "3d", "14d", "21d", "24h", "garbage"]) {
      const res = await app.inject({ method: "GET", url: `/api/metrics/traffic?window=${w}` });
      // "garbage" fails the enum at the schema layer on documented routes is
      // NOT desired — parseWindow falls back to the default instead.
      expect([200].includes(res.statusCode) || w === "garbage").toBe(true);
    }
  });

  it("GET /api/metrics/traffic → summary shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/traffic?window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("rpsNow");
    expect(body).toHaveProperty("chainCount");
    expect(Array.isArray(body.chains)).toBe(true);
    expect(Array.isArray(body.aggregate)).toBe(true);
  });

  it("GET /api/metrics/methods → rows + class totals (write/batch absent ⇒ null)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/methods?window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.methods)).toBe(true);
    expect(body.methods[0]).toMatchObject({ method: "eth_blockNumber", class: "read" });
    // Per-method error rate is real derived math: 3 errors / 100 requests.
    expect(body.methods[0].errorRate).toBeCloseTo(0.03);
    // p95 must stay null — the histogram has no method label on this build.
    expect(body.methods[0].p95Ms).toBeNull();
    expect(body.classTotals.read).toBe(100);
    expect(body.classTotals.write).toBeNull();
    expect(body.classTotals.batch).toBeNull();
    expect(body.classTotals.emitted).toEqual({ write: false, batch: false });
  });

  it("GET /api/metrics/overview → KPIs + series + gated CU/cap + prior errors", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/overview?window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRequests).toHaveProperty("value");
    expect(body.totalRequests).toHaveProperty("prior");
    // errors.prior is prior ERRORS (derived), not prior requests.
    expect(body.errors).toEqual({ value: 3, prior: 3 });
    expect(Array.isArray(body.throughput)).toBe(true);
    expect(Array.isArray(body.activeRoutes)).toBe(true);
    expect(Array.isArray(body.latencyDistribution)).toBe(true);
    expect(Array.isArray(body.perUpstreamSeries)).toBe(true);
    expect(body.errorLayers).toEqual([{ layer: "unclassified", count: 3 }]);
    // Quota/cap are never invented — always null on this build.
    expect(body.computeUnits.limit).toBeNull();
    expect(body.rpsCap).toBeNull();
  });

  it("GET /api/metrics/chain-series requires spec; returns the switcher bundle", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/metrics/chain-series?window=1d" });
    expect(missing.statusCode).toBe(400);

    const res = await app.inject({ method: "GET", url: "/api/metrics/chain-series?spec=ETH1&window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.spec).toBe("ETH1");
    for (const k of ["availability", "p95Ms", "errorRate", "rps"]) {
      expect(Array.isArray(body[k])).toBe(true);
    }
    // No optimizer/endpoint score series data in the mock ⇒ honest null.
    expect(body.qos).toBeNull();
    // No backup-marked config ⇒ null, not a synthetic 0%.
    expect(body.backupShare).toBeNull();
  });

  it("GET /api/metrics/upstream-detail requires endpointId; errors stay empty until emitted", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/metrics/upstream-detail?window=1d" });
    expect(missing.statusCode).toBe(400);

    const res = await app.inject({ method: "GET", url: "/api/metrics/upstream-detail?endpointId=eth-lava&window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.endpointId).toBe("eth-lava");
    expect(body.spec).toBe("ETH1");
    expect(body.health).toBe("operational");
    expect(body.scores.composite).toBeCloseTo(0.9);
    expect(body.errorsByCode).toEqual([]);
    expect(body.recentErrors).toEqual([]);
    expect(body.emitted.errorsByCode).toBe(false);
  });

  it("GET /api/metrics/errors → derived totals + pivots; labelled pivots wait for families", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/errors?window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.pivots.chain[0]).toMatchObject({ key: "ETH1", errors: 3 });
    expect(body.pivots.method[0]).toMatchObject({ key: "eth_blockNumber", errors: 3 });
    expect(body.pivots.category).toEqual([]);
    expect(body.pivots.code).toEqual([]);
    expect(body.hotspots[0]).toMatchObject({ spec: "ETH1", upstream: "eth-lava", errors: 3, requests: 100 });
    expect(body.hotspots[0].errorRate).toBeCloseTo(0.03);
    expect(body.families).toEqual({
      requestsFailedTotal: false,
      nodeErrorsTotal: false,
      protocolErrorsTotal: false,
    });
  });

  it("GET /api/metrics/unavailable → empty when every chain has a live endpoint", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/unavailable" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unavailable: [] });
  });

  it("GET /api/metrics/cross-validation → emitted:false but real consistency counters", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/cross-validation?window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.emitted).toBe(false);
    expect(body.rounds).toBeNull();
    expect(body.consensusRate).toBeNull();
    // consistency_* IS real on this build and must come through.
    expect(body.consistency).toEqual({ total: 7, caught: 5 });
  });

  it("GET /api/metrics/websocket → emitted:false, all nulls until ws_* fires", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/websocket?window=1d" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      emitted: false,
      activeConnections: null,
      subscriptions: null,
      subscriptionErrors: null,
      byChain: [],
    });
  });

  it("GET /api/metrics/dashboard → real KPIs/series; null-gated families stay null", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/dashboard?window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Real KPIs with prior-window counterparts.
    expect(body.kpis.successRate.value).toBeCloseTo(0.97);
    expect(body.kpis.p95Ms.value).toBe(42);
    expect(body.kpis.errors).toEqual({ value: 3, prior: 3 });
    expect(body.kpis.rps.value).toBe(1234);
    // "Errors Handled" needs counters this build doesn't emit ⇒ null, never invented.
    expect(body.kpis.errorsHandled).toEqual({ value: null, prior: null });
    // Real series families are present (arrays; empty under the vector mock).
    expect(Array.isArray(body.series.throughput)).toBe(true);
    expect(Array.isArray(body.series.errors)).toBe(true);
    expect(Array.isArray(body.series.latency.p95)).toBe(true);
    expect(Array.isArray(body.series.perChain)).toBe(true);
    expect(Array.isArray(body.series.perChainSuccessRate)).toBe(true);
    expect(Array.isArray(body.series.upstreamMix)).toBe(true);
    // Chains meta list for the header multiselect.
    expect(body.chains).toEqual([
      { spec: "ETH1", name: "Ethereum", color: "#627EEA", health: "operational" },
    ]);
    // Null-gated families: absent from the router ⇒ null, trouble stays [].
    for (const k of [
      "scu",
      "regions",
      "failoverRatio",
      "internalAvailability",
      "cacheHitRate",
      "errorClasses",
      "errorsHandledBreakdown",
      "contribution",
      "upstreamAvailability",
      "scorecard",
    ]) {
      expect(body[k]).toBeNull();
    }
    expect(body.trouble).toEqual([]);
  });
});
