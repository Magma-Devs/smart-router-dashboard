import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { RECORDED, recordedReadsPolicy, setRecordedReads } from "@sr/shared";
import { buildApp } from "../app.js";
import { MetricsService } from "../services/metrics.js";
import type { PrometheusClient, PromVectorSample } from "../services/prometheus-client.js";

/** A store that answers the freshness probe with a given age and everything else empty. */
function mockStore(ageSec: number | null | "error"): string[] {
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
    expect(recordedReadsPolicy()).toEqual({ from: "3h", available: false });
    const res = await app.inject({ method: "GET", url: "/api/metrics/specs" });
    expect(res.statusCode).toBe(200);
    expect(recordedReadsPolicy()).toEqual({ from: "3h", available: true });
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
      expect(recordedReadsPolicy()).toEqual({ from: "3h", available: false });
      await app.close();
      app = null;
      vi.unstubAllGlobals();
    }
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

  it("the hero summary, the routers table and the overview read recorded series at 6h and raw at 1h", async () => {
    setRecordedReads({ from: "3h", available: true });
    for (const [window, recorded] of [["6h", true], ["1h", false]] as const) {
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
    expect(queries.some((q) => q.includes(":rate2m"))).toBe(false);
  });
});
