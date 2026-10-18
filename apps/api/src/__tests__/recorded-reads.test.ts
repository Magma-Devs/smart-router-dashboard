import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { RECORDED, recordedReadsPolicy, setRecordedReads } from "@sr/shared";
import { buildApp } from "../app.js";
import { MetricsService } from "../services/metrics.js";
import type { PrometheusClient, PromVectorSample } from "../services/prometheus-client.js";

/** A store that answers the freshness probe with a given age and everything else empty. */
function mockStore(ageSec: number | null | "error", historySec = 2_592_000, scrapeSec: number | null = 15): string[] {
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = typeof input === "string" ? input : input.toString();
    const query = new URL(url).searchParams.get("query") ?? "";
    sent.push(query);
    if (query.startsWith("time() - max(timestamp(")) {
      if (ageSec === "error") return new Response("boom", { status: 500 });
      const result = ageSec === null ? [] : [{ metric: {}, value: [1, String(ageSec)] }];
      return Response.json({ status: "success", data: { resultType: "vector", result } });
    }
    if (query.startsWith("time() - min(min_over_time(timestamp(")) {
      // The oldest recorded sample: thirty days back when the series exist at all.
      const result = ageSec === null || ageSec === "error" ? [] : [{ metric: {}, value: [1, String(historySec)] }];
      return Response.json({ status: "success", data: { resultType: "vector", result } });
    }
    if (query.startsWith("600 / max(count_over_time(")) {
      // The raw sample spacing: 15 s on the fleet, whatever the test says otherwise.
      const result = scrapeSec === null ? [] : [{ metric: {}, value: [1, String(scrapeSec)] }];
      return Response.json({ status: "success", data: { resultType: "vector", result } });
    }
    return Response.json({ status: "success", data: { resultType: "vector", result: [] } });
  });
  return sent;
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  await app?.close();
  app = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setRecordedReads({ from: null, available: false });
});

describe("the freshness probe", () => {
  const PROBE = "time() - max(timestamp(";

  it("is armed by the first metrics request, never at boot, and that request sees the answer", async () => {
    const sent = mockStore(40);
    app = await buildApp();
    await app.ready();
    expect(sent.filter((q) => q.startsWith(PROBE))).toHaveLength(0);
    expect(recordedReadsPolicy()).toEqual({ from: "3h", available: false, historySeconds: null });
    const res = await app.inject({ method: "GET", url: "/api/metrics/specs" });
    expect(res.statusCode).toBe(200);
    expect(recordedReadsPolicy()).toEqual({ from: "3h", available: true, historySeconds: 2_592_000 });
    // One probe, and the request's own read came after it.
    const probeAt = sent.findIndex((q) => q.startsWith(PROBE));
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(sent.filter((q) => q.startsWith(PROBE))).toHaveLength(1);
    expect(sent.findIndex((q) => q.startsWith("count by (spec)"))).toBeGreaterThan(probeAt);
  });

  it("keeps them off when the sample is stale, absent, or the store fails", async () => {
    for (const age of [900, null, "error"] as const) {
      const sent = mockStore(age);
      app = await buildApp();
      await app.inject({ method: "GET", url: "/api/metrics/specs" });
      expect(sent.filter((q) => q.startsWith(PROBE))).toHaveLength(1);
      expect(recordedReadsPolicy()).toEqual({ from: "3h", available: false, historySeconds: null });
      await app.close();
      app = null;
      vi.unstubAllGlobals();
    }
  });

  it("reports the reads state for the dashboard's notice", async () => {
    // No recorded series at all: raw everywhere, reason absent, every window raw.
    mockStore(null);
    app = await buildApp();
    let res = await app.inject({ method: "GET", url: "/api/metrics/reads" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ from: "3h", chartFloor: "12h", available: false, reason: "absent", ageSec: null, historySec: null });
    expect(res.json().windows.recorded).toEqual([]);
    await app.close();
    vi.unstubAllGlobals();
    // Fresh with six hours of history: 3h and 6h read recorded, a day does not.
    mockStore(30, 6 * 3600);
    app = await buildApp();
    res = await app.inject({ method: "GET", url: "/api/metrics/reads" });
    expect(res.json()).toMatchObject({ available: true, reason: "fresh", ageSec: 30, historySec: 21600, scrapeSec: 15 });
    expect(res.json().windows.recorded).toEqual(["3h", "6h"]);
    expect(res.json().windows.raw).toContain("1d");
    await app.close();
    vi.unstubAllGlobals();
    // Stale: the series exist, the newest sample is old.
    mockStore(900);
    app = await buildApp();
    res = await app.inject({ method: "GET", url: "/api/metrics/reads" });
    expect(res.json()).toMatchObject({ available: false, reason: "stale", ageSec: 900 });
    await app.close();
    vi.unstubAllGlobals();
    // Fresh and deep, but the store scrapes the routers every 30 s: the 2m15s
    // window would be phase-biased there, so every window reads raw.
    mockStore(30, 2_592_000, 30);
    app = await buildApp();
    res = await app.inject({ method: "GET", url: "/api/metrics/reads" });
    expect(res.json()).toMatchObject({ available: false, reason: "scrape", ageSec: 30, scrapeSec: 30 });
    expect(res.json().windows.recorded).toEqual([]);
    expect(recordedReadsPolicy()).toEqual({ from: "3h", available: false, historySeconds: null });
    await app.close();
    vi.unstubAllGlobals();
    // A store with no router series yet cannot be on the wrong interval.
    mockStore(30, 6 * 3600, null);
    app = await buildApp();
    res = await app.inject({ method: "GET", url: "/api/metrics/reads" });
    expect(res.json()).toMatchObject({ available: true, reason: "fresh", scrapeSec: null });
  });

  it("is not armed when METRICS_RECORDED_FROM is never", async () => {
    vi.stubEnv("METRICS_RECORDED_FROM", "never");
    // config is read at import time; the env only reaches a fresh module graph.
    vi.resetModules();
    const { buildApp: build } = await import("../app.js");
    const { recordedReadsPolicy: policy } = await import("@sr/shared");
    const sent = mockStore(5);
    app = await build();
    await app.inject({ method: "GET", url: "/api/metrics/specs" });
    expect(policy().from).toBeNull();
    expect(sent.some((q) => q.startsWith(PROBE))).toBe(false);
    const res = await app.inject({ method: "GET", url: "/api/metrics/reads" });
    expect(res.json()).toMatchObject({ from: null, reason: "off", available: false });
  });
});

describe("services under the policy", () => {
  function capturing() {
    const queries: string[] = [];
    const prom = {
      async query(expr: string): Promise<PromVectorSample[]> {
        queries.push(expr);
        if (expr.startsWith("count by (spec)")) return [{ metric: { spec: "ETH1" }, value: [1, "1"] }];
        return [];
      },
      async scalar(expr: string) {
        queries.push(expr);
        return null;
      },
      async queryRange(expr: string) {
        queries.push(expr);
        return [];
      },
      async ping() {
        return true;
      },
    } as unknown as PrometheusClient;
    return { prom, queries };
  }
  // The raw family on its own, not inside a recorded name.
  const RAW_HISTOGRAM = /(?<![:a-z_])smartrouter_end_to_end_latency_milliseconds_bucket(?![:a-z_])/;

  it("the hero summary, the routers table and the overview read recorded series at 1d and raw at 1h", async () => {
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    // A day: the KPIs, the grouped per-chain reads and the chart series (the
    // chart floor is 12h) all read recorded series.
    for (const [window, recorded] of [["1d", true], ["1h", false]] as const) {
      const { prom, queries } = capturing();
      const svc = new MetricsService(prom);
      await svc.dashboardSummary(window);
      await svc.chains(window);
      await svc.overview(window);
      const histogramReads = queries.filter((q) => q.includes("latency_milliseconds_bucket"));
      expect(histogramReads.length).toBeGreaterThan(0);
      for (const q of histogramReads) {
        if (recorded) {
          expect(q).toContain(RECORDED.latencyBucket);
          expect(q).not.toMatch(RAW_HISTOGRAM);
        } else {
          expect(q).toMatch(RAW_HISTOGRAM);
        }
      }
    }
  });

  it("falls back to raw at 6h while the series are stale", async () => {
    setRecordedReads({ from: "3h", available: false });
    const { prom, queries } = capturing();
    await new MetricsService(prom).dashboardSummary("6h");
    expect(queries.some((q) => q.includes(":rate2m15s"))).toBe(false);
  });
});
