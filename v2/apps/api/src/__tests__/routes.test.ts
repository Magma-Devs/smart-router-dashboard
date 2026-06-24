import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

/** Canned Prometheus responses keyed by a substring of the PromQL `query`. */
function mockPrometheus(): void {
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/-/ready")) {
      return new Response("ok", { status: 200 });
    }

    const query = new URL(url).searchParams.get("query") ?? "";
    let result: unknown[] = [];

    if (query.startsWith("count by (spec)")) {
      result = [{ metric: { spec: "ETH1" }, value: [1, "1"] }];
    } else if (query.includes("smartrouter_requests_total")) {
      result = [{ metric: { spec: "ETH1" }, value: [1, "1234"] }];
    } else if (query.includes("overall_health")) {
      result = [{ metric: {}, value: [1, "1"] }];
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

  it("GET /api/metrics/dashboard-summary → never invents, real fields present", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/dashboard-summary?window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestsServed).toBe(1234);
    expect(body).toHaveProperty("successRate");
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

  it("GET /api/metrics/traffic → summary shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/traffic?window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("rpsNow");
    expect(body).toHaveProperty("chainCount");
    expect(Array.isArray(body.chains)).toBe(true);
    expect(Array.isArray(body.aggregate)).toBe(true);
  });

  it("GET /api/metrics/methods → methods array (empty ok)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/methods?window=1d" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().methods)).toBe(true);
  });

  it("GET /api/metrics/overview → KPIs + series + gated CU/cap", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/overview?window=1d" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRequests).toHaveProperty("value");
    expect(body.totalRequests).toHaveProperty("prior");
    expect(Array.isArray(body.throughput)).toBe(true);
    expect(Array.isArray(body.activeRoutes)).toBe(true);
    // Quota/cap are never invented — always null on this build.
    expect(body.computeUnits.limit).toBeNull();
    expect(body.rpsCap).toBeNull();
  });
});
