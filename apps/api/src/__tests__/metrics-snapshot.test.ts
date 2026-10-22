import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WINDOWS, type MetricWindow } from "@sr/shared";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { prometheusPlugin } from "../plugins/prometheus.js";
import { metricRoutes, snapshotTtlMs } from "../routes/metrics.js";

/**
 * MAG-4572: every viewer re-ran its page's whole read set. The metrics routes
 * now answer from one snapshot per route and query, per process.
 */

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

let app: FastifyInstance | null = null;
let sent: string[] = [];

/** An empty store that records every query. */
function stubStore(): void {
  sent = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(input.toString());
    sent.push(url.searchParams.get("query") ?? "");
    const resultType = url.pathname.endsWith("/query_range") ? "matrix" : "vector";
    return Response.json({ status: "success", data: { resultType, result: [] } });
  });
}

/** Store reads made by routes — the recorded-reads probe the first request arms is not one. */
const reads = () => sent.filter((q) => !q.startsWith("time() - ") && !q.startsWith("600 / max(count_over_time(")).length;

/** The metrics routes on the real plugin, with an explicit snapshot TTL. */
async function build(snapshotTtlMs: number): Promise<FastifyInstance> {
  const instance = Fastify();
  app = instance;
  await instance.register(errorHandlerPlugin);
  await instance.register(prometheusPlugin);
  await instance.register(metricRoutes, { snapshotTtlMs });
  await instance.ready();
  return instance;
}

const get = (instance: FastifyInstance, url: string) => instance.inject({ method: "GET", url });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  stubStore();
});

afterEach(async () => {
  await app?.close();
  app = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("snapshotTtlMs", () => {
  const BASE = 15_000;

  it("keeps a window's answer by its window", () => {
    const byWindow = Object.fromEntries(
      (Object.keys(WINDOWS) as MetricWindow[]).map((w) => [w, snapshotTtlMs("window", w, BASE)]),
    );
    expect(byWindow).toEqual({
      "5m": 15_000,
      "15m": 15_000,
      "30m": 15_000,
      "1h": 15_000,
      "3h": 60_000,
      "6h": 60_000,
      "12h": 60_000,
      "1d": 300_000,
      "3d": 300_000,
      "7d": 900_000,
      "14d": 900_000,
      "21d": 900_000,
      "30d": 900_000,
    });
  });

  it("keeps a figure about now a minute at most", () => {
    expect(snapshotTtlMs("live", "30m", BASE)).toBe(15_000);
    for (const w of ["3h", "1d", "7d", "30d"] as const) expect(snapshotTtlMs("live", w, BASE)).toBe(60_000);
  });

  it("keeps a window-less answer the base, the pulse 30 s", () => {
    expect(snapshotTtlMs("instant", null, BASE)).toBe(15_000);
    expect(snapshotTtlMs("pulse", null, BASE)).toBe(30_000);
  });

  it("never goes under the base, and a base of 0 turns it off", () => {
    expect(snapshotTtlMs("live", "7d", 120_000)).toBe(120_000);
    expect(snapshotTtlMs("pulse", null, 120_000)).toBe(120_000);
    expect(snapshotTtlMs("window", "7d", 120_000)).toBe(900_000);
    for (const kind of ["window", "live", "instant", "pulse"] as const) {
      expect(snapshotTtlMs(kind, "7d", 0)).toBe(0);
    }
  });
});

describe("the metrics routes' snapshot (MAG-4572)", () => {
  it("serves one read to every caller of a query until its TTL, whatever the parameter order", async () => {
    const api = await build(15_000);
    const first = await get(api, "/api/metrics/overview?window=30m&spec=ETH1");
    expect(first.statusCode).toBe(200);
    expect(first.headers.age).toBe("0");
    expect(first.headers["access-control-expose-headers"]).toBe("Age");
    const cost = reads();
    expect(cost).toBeGreaterThan(0);

    vi.setSystemTime(T0 + 14_000);
    const again = await get(api, "/api/metrics/overview?spec=ETH1&unread=1&window=30m");
    expect(again.json()).toEqual(first.json());
    expect(again.headers.age).toBe("14");
    expect(reads()).toBe(cost);

    // Another chain is another answer.
    await get(api, "/api/metrics/overview?window=30m&spec=BASE");
    expect(reads()).toBeGreaterThan(cost);
  });

  it("keys a window by its parsed value, so an alias shares the answer", async () => {
    const api = await build(15_000);
    await get(api, "/api/metrics/chains?window=1d");
    const cost = reads();
    expect((await get(api, "/api/metrics/chains?window=24h")).headers.age).toBe("0");
    expect(reads()).toBe(cost);
  });

  it("past its TTL serves the answer while one refresh runs behind it", async () => {
    const api = await build(15_000);
    const url = "/api/metrics/upstreams?window=30m";
    const first = await get(api, url);
    const cost = reads();

    vi.setSystemTime(T0 + 16_000);
    const stale = await get(api, url);
    expect(stale.headers.age).toBe("16");
    expect(stale.json()).toEqual(first.json());
    await vi.waitFor(() => expect(reads()).toBe(2 * cost));

    vi.setSystemTime(T0 + 17_000);
    await vi.waitFor(async () => expect((await get(api, url)).headers.age).toBe("1"));
    expect(reads()).toBe(2 * cost);
  });

  it("a refresh during which the store refuses a read keeps the previous good answer and its Age", async () => {
    let refusing = false;
    let specs = ["ETH1"];
    const specReads = () => sent.filter((q) => q.startsWith("count by (spec)")).length;
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const query = new URL(input.toString()).searchParams.get("query") ?? "";
      sent.push(query);
      if (!query.startsWith("count by (spec)")) {
        return Response.json({ status: "success", data: { resultType: "vector", result: [] } });
      }
      if (refusing) return new Response("too many outstanding requests", { status: 429 });
      const result = specs.map((spec) => ({ metric: { spec }, value: [1, "1"] }));
      return Response.json({ status: "success", data: { resultType: "vector", result } });
    });
    const api = await build(15_000);
    const url = "/api/metrics/specs";
    expect((await get(api, url)).json()).toEqual({ specs: ["ETH1"] });

    refusing = true;
    vi.setSystemTime(T0 + 16_000);
    const stale = await get(api, url);
    expect(stale.json()).toEqual({ specs: ["ETH1"] });
    expect(stale.headers.age).toBe("16");
    await vi.waitFor(() => expect(specReads()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The refused refresh came back empty and is not kept: the good answer
    // stays with its Age running on, and the cool-down starts no read.
    vi.setSystemTime(T0 + 17_000);
    const kept = await get(api, url);
    expect(kept.json()).toEqual({ specs: ["ETH1"] });
    expect(kept.headers.age).toBe("17");
    expect(specReads()).toBe(2);

    // Past the cool-down a clean refresh replaces it.
    refusing = false;
    specs = ["ETH1", "BASE"];
    vi.setSystemTime(T0 + 25_000);
    expect((await get(api, url)).headers.age).toBe("25");
    await vi.waitFor(async () => expect((await get(api, url)).json()).toEqual({ specs: ["BASE", "ETH1"] }));
    expect(specReads()).toBe(3);
  });

  it("keeps a long window longer, and a figure about now a minute at most", async () => {
    const api = await build(15_000);
    await get(api, "/api/metrics/chain-series?spec=ETH1&window=7d");
    const series = reads();
    await get(api, "/api/metrics/upstreams?window=7d");
    const roster = reads() - series;

    vi.setSystemTime(T0 + 14 * 60_000);
    expect((await get(api, "/api/metrics/chain-series?spec=ETH1&window=7d")).headers.age).toBe("840");
    expect(reads()).toBe(series + roster);
    // The roster carries health: past twice its 60 s, the caller waits for a fresh read.
    expect((await get(api, "/api/metrics/upstreams?window=7d")).headers.age).toBe("0");
    expect(reads()).toBe(series + 2 * roster);
  });

  it("covers every route that reads the store", async () => {
    const api = await build(15_000);
    const urls = [
      "/api/metrics/routers",
      "/api/metrics/specs",
      "/api/metrics/dashboard-summary",
      "/api/metrics/pulse",
      "/api/metrics/overview",
      "/api/metrics/dashboard",
      "/api/metrics/routers-rollup",
      "/api/metrics/chains",
      "/api/metrics/upstreams",
      "/api/metrics/block-heights",
      "/api/metrics/rps",
      "/api/metrics/traffic",
      "/api/metrics/methods",
      "/api/metrics/chain-series?spec=ETH1",
      "/api/metrics/upstream-peers?spec=ETH1",
      "/api/metrics/upstream-detail?spec=ETH1&endpointId=eth-lava",
      "/api/metrics/errors",
      "/api/metrics/retries",
      "/api/metrics/unavailable",
      "/api/metrics/cross-validation",
      "/api/metrics/websocket",
    ];
    for (const url of urls) {
      const before = reads();
      const first = await get(api, url);
      expect(first.statusCode, url).toBe(200);
      const cost = reads() - before;
      expect(cost, url).toBeGreaterThan(0);
      const again = await get(api, url);
      expect(again.headers.age, url).toBe("0");
      expect(reads() - before, url).toBe(cost);
    }
  });

  it("never snapshots the raw passthrough or the reads report", async () => {
    const api = await build(15_000);
    await get(api, "/api/metrics/query?query=up");
    const res = await get(api, "/api/metrics/query?query=up");
    expect(res.headers.age).toBeUndefined();
    expect(sent.filter((q) => q === "up")).toHaveLength(2);
    expect((await get(api, "/api/metrics/reads")).headers.age).toBeUndefined();
  });

  it("off, every request reads live and carries no Age", async () => {
    const api = await build(0);
    await get(api, "/api/metrics/chains?window=30m");
    const cost = reads();
    const res = await get(api, "/api/metrics/chains?window=30m");
    expect(res.headers.age).toBeUndefined();
    expect(reads()).toBe(2 * cost);
  });

  it("takes its base from METRICS_SNAPSHOT_TTL_MS", async () => {
    vi.stubEnv("METRICS_SNAPSHOT_TTL_MS", "15000");
    // config is read at import time; the env only reaches a fresh module graph.
    vi.resetModules();
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    await get(app, "/api/metrics/chains?window=30m");
    const cost = reads();
    expect((await get(app, "/api/metrics/chains?window=30m")).headers.age).toBe("0");
    expect(reads()).toBe(cost);
  });

  it("a refresh that throws keeps the last good answer while it is under twice its TTL", async () => {
    let failing = false;
    let runs = 0;
    const metrics = {
      async chains() {
        runs++;
        if (failing) throw new Error("boom");
        return [{ spec: "ETH1", run: runs }];
      },
    };
    const api = Fastify();
    app = api;
    api.decorate("scoped", () => ({ metrics }));
    await api.register(errorHandlerPlugin);
    await api.register(metricRoutes, { snapshotTtlMs: 15_000 });
    const url = "/api/metrics/chains?window=30m";
    expect((await get(api, url)).json()).toEqual({ chains: [{ spec: "ETH1", run: 1 }] });

    failing = true;
    vi.setSystemTime(T0 + 16_000);
    const stale = await get(api, url);
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toEqual({ chains: [{ spec: "ETH1", run: 1 }] });
    await vi.waitFor(() => expect(runs).toBe(2));
    // Not retried on every request.
    vi.setSystemTime(T0 + 17_000);
    expect((await get(api, url)).json()).toEqual({ chains: [{ spec: "ETH1", run: 1 }] });
    expect(runs).toBe(2);

    // Twice its TTL old it is served no more.
    vi.setSystemTime(T0 + 30_000);
    expect((await get(api, url)).statusCode).toBe(500);
    expect(runs).toBe(3);

    failing = false;
    vi.setSystemTime(T0 + 35_000);
    expect((await get(api, url)).json()).toEqual({ chains: [{ spec: "ETH1", run: 4 }] });
  });

  it("is served only past the request gate", async () => {
    const metrics = { chains: async () => [{ spec: "ETH1" }] };
    const api = Fastify();
    app = api;
    api.decorate("scoped", () => ({ metrics }));
    // Stands in for the auth plugin's gate, an onRequest hook.
    api.addHook("onRequest", async (request, reply) => {
      if (request.headers.authorization !== "Bearer ok") return reply.code(401).send({ error: "Unauthorized" });
    });
    await api.register(metricRoutes, { snapshotTtlMs: 15_000 });
    const url = "/api/metrics/chains?window=30m";
    expect((await api.inject({ method: "GET", url, headers: { authorization: "Bearer ok" } })).statusCode).toBe(200);
    const refused = await get(api, url);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({ error: "Unauthorized" });
  });
});
