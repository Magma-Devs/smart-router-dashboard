import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { bucketGrid, type MetricWindow, type RouterTopology } from "@sr/shared";
import { buildApp } from "../app.js";
import { ERROR_GROUPS_LIMIT, ErrorGroupsService, RECORDED_ERRORS } from "../services/error-groups.js";
import type { PrometheusClient, PromMatrixSample, PromVectorSample } from "../services/prometheus-client.js";
import type { ConfigurationService } from "../services/configuration.js";

/* The clock: 430 s into a 10-minute bar. A 1 h window is seven bars of 10
   minutes on the clock (bucketGrid): the first ends at START, the sixth at
   T0, the seventh is still filling. The recorded counts are read up to two
   minutes ago, rounded down to the minute (LAG_FROM): every bar up to T0
   from one range read, a point per bar, each bar's samples read 30 s after
   it ends; the running bar up to LAG_FROM from one instant read. */
const T0 = 1_760_000_400; // a multiple of 600
const NOW = T0 + 430;
const START = T0 - 5 * 600;
const LAG_FROM = T0 + 300;
const BY = "chain, error_class, outcome, failing_provider, reached_client";

const node = (name: string) => ({ name, endpoints: [{ interface: "jsonrpc" }] });
const ROUTERS = [
  { id: "eth-prod", spec: "ETH1", nodes: [node("node-a"), node("node-b")] },
  { id: "eth-canary", spec: "ETH1", nodes: [node("node-c")] },
  { id: "Sui", spec: "SUI", nodes: [node("sui-a")] },
] as unknown as RouterTopology[];
const cfg = { getRouters: () => ROUTERS } as unknown as ConfigurationService;

/** A store answering the range read with `matrix`, the running bar with
 *  `vector`, and the family check with `family` samples (0: none recorded);
 *  null = no answer. Every read is noted in `calls`. */
function promOf(matrix: PromMatrixSample[] | null, vector: PromVectorSample[] | null, calls: string[], family: number | null = 3) {
  return {
    async queryRangeOrNull(expr: string, start: number, end: number, step: string) {
      calls.push(`range ${expr} ${start} ${end} ${step}`);
      return matrix;
    },
    async queryAtOrNull(expr: string, time: number) {
      calls.push(`at ${expr} ${time}`);
      if (expr.startsWith("count(present_over_time(")) return family === null ? null : family ? [{ metric: {}, value: [time, String(family)] }] : [];
      return vector;
    },
  } as unknown as PrometheusClient;
}

const m = (metric: Record<string, string>, values: [number, string][]): PromMatrixSample => ({ metric, values });
const v = (metric: Record<string, string>, n: string): PromVectorSample => ({ metric, value: [LAG_FROM + 30, n] });
/** A count's labels as the rule writes them: the class empty until the router names one. */
const err = (labels: Record<string, string>) => ({ chain: "eth1", error_class: "", outcome: "no_answer", failing_provider: "node-a", reached_client: "true", ...labels });
const bars = (fill: Record<number, number>) => Array.from({ length: 7 }, (_, i) => fill[i] ?? 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => vi.useRealTimers());

describe("error groups from the store's recorded counts", () => {
  const MATRIX = [
    // Each bar's samples read 30 s after it ends: the first bar, and the one ending at T0.
    m(err({}), [[START + 30, "3"], [T0 + 30, "2"]]),
    m(err({ outcome: "node_error", failing_provider: "node-b" }), [[START + 600 + 30, "7"]]),
    m(err({ outcome: "ok", failing_provider: "node-a", reached_client: "false" }), [[T0 - 600 + 30, "4"]]),
  ];
  const VECTOR = [v(err({}), "1")];

  it("reads the window in one range read, a point per bar, then the bar still filling up to two minutes ago", async () => {
    const calls: string[] = [];
    const r = await new ErrorGroupsService(promOf(MATRIX, VECTOR, calls), cfg).groups("1h", "ETH1");
    expect(calls).toEqual([
      `range sum by (${BY}) (sum_over_time(${RECORDED_ERRORS}{chain="eth1"}[600s])) ${START + 30} ${T0 + 30} 600s`,
      `at sum by (${BY}) (sum_over_time(${RECORDED_ERRORS}{chain="eth1"}[300s])) ${LAG_FROM + 30}`,
    ]);
    expect(r).toMatchObject({ available: true, source: "recorded", asOf: NOW, grid: { start: START, end: T0 + 600, stepSec: 600 }, partialFrom: LAG_FROM - 60 });
    // Each count in the bar its lines end in; the running bar's from the instant read.
    expect(r.groups.map((g) => [g.failingProvider, g.outcome, g.reachedClient, g.count, g.buckets])).toEqual([
      ["node-b", "node_error", true, 7, bars({ 1: 7 })],
      ["node-a", "no_answer", true, 6, bars({ 0: 3, 5: 2, 6: 1 })],
      ["node-a", "ok", false, 4, bars({ 4: 4 })],
    ]);
    expect(r.total).toBe(17);
    expect(r.reached).toEqual({ count: 13, buckets: bars({ 0: 3, 1: 7, 5: 2, 6: 1 }) });
  });

  it("each group says where its requests are: from a minute before its first bar - never before the window - to the end of its last, now for the running one", async () => {
    const calls: string[] = [];
    const r = await new ErrorGroupsService(promOf(MATRIX, VECTOR, calls), cfg).groups("1h", "ETH1");
    const at = (provider: string, outcome: string) => r.groups.find((g) => g.failingProvider === provider && g.outcome === outcome)!;
    // The first bar starts before the window does: the window's start, then.
    expect(at("node-a", "no_answer")).toMatchObject({ from: NOW - 3600, to: NOW });
    expect(at("node-b", "node_error")).toMatchObject({ from: START - 60, to: START + 600 });
    expect(at("node-a", "ok")).toMatchObject({ from: T0 - 1200 - 60, to: T0 - 600 });
  });

  it("a group is its chain, class, failing provider and whether the client got it; unclassified, its outcome stands in for the class", async () => {
    const calls: string[] = [];
    const matrix = [
      m(err({ outcome: "no_answer" }), [[T0 + 30, "2"]]),
      m(err({ outcome: "rejected_before_dispatch" }), [[T0 + 30, "1"]]),
      // A class merges the outcomes it ended in.
      m(err({ error_class: "rate_limit", outcome: "no_answer", failing_provider: "node-b" }), [[T0 + 30, "2"]]),
      m(err({ error_class: "rate_limit", outcome: "node_error", failing_provider: "node-b" }), [[T0 + 30, "3"]]),
      m(err({ error_class: "timeout", outcome: "no_answer", failing_provider: "node-b" }), [[T0 + 30, "1"]]),
      // No try failed: no provider. No chain named: no spec.
      m(err({ outcome: "router_error", failing_provider: "" }), [[T0 + 30, "1"]]),
      m(err({ chain: "", outcome: "router_error", failing_provider: "" }), [[T0 + 30, "1"]]),
    ];
    const r = await new ErrorGroupsService(promOf(matrix, [], calls), cfg).groups("1h");
    expect(calls[0]).toContain(`(sum_over_time(${RECORDED_ERRORS}[600s]))`); // no chain asked for
    // The most requests first; a tie in the same minutes by key.
    expect(r.groups.map((g) => [g.spec, g.errorClass, g.outcome, g.failingProvider, g.count])).toEqual([
      ["ETH1", "rate_limit", null, "node-b", 5],
      ["ETH1", null, "no_answer", "node-a", 2],
      ["ETH1", "timeout", "no_answer", "node-b", 1],
      ["ETH1", null, "rejected_before_dispatch", "node-a", 1],
      ["ETH1", null, "router_error", null, 1],
      [null, null, "router_error", null, 1],
    ]);
    expect(new Set(r.groups.map((g) => g.key)).size).toBe(r.groups.length);
  });

  it("a chain's spec is the values file's, else the label upper-cased", async () => {
    const calls: string[] = [];
    const r = await new ErrorGroupsService(promOf([m(err({ chain: "sui" }), [[T0 + 30, "1"]]), m(err({ chain: "base" }), [[T0 + 30, "1"]])], [], calls), cfg).groups("1h");
    expect(r.groups.map((g) => g.spec).sort()).toEqual(["BASE", "SUI"]);
  });

  it(`lists ${ERROR_GROUPS_LIMIT} groups at most, the most requests first, and counts the rest in omitted, total and reached`, async () => {
    const calls: string[] = [];
    const many = Array.from({ length: ERROR_GROUPS_LIMIT + 10 }, (_, i) =>
      m(err({ failing_provider: `node-${i}`, reached_client: i % 2 ? "true" : "false" }), [[T0 + 30, String(i + 1)]]));
    const r = await new ErrorGroupsService(promOf(many, [], calls), cfg).groups("1h");
    expect(r.limit).toBe(ERROR_GROUPS_LIMIT);
    expect(r.groups).toHaveLength(ERROR_GROUPS_LIMIT);
    expect(r.groups[0]).toMatchObject({ failingProvider: `node-${ERROR_GROUPS_LIMIT + 9}`, count: ERROR_GROUPS_LIMIT + 10 });
    expect(r.omitted).toEqual({ groups: 10, count: 55 }); // 1 + 2 + … + 10
    expect(r.total).toBe(((ERROR_GROUPS_LIMIT + 10) * (ERROR_GROUPS_LIMIT + 11)) / 2);
    expect(r.reached.count).toBe(many.filter((_, i) => i % 2).reduce((n, _, k) => n + 2 * (k + 1), 0));
  });

  it("is kept for 30 seconds: every open page shares one read", async () => {
    const calls: string[] = [];
    const svc = new ErrorGroupsService(promOf(MATRIX, VECTOR, calls), cfg);
    await Promise.all([svc.groups("1h", "ETH1"), svc.groups("1h", "ETH1")]);
    await svc.groups("1h", "ETH1");
    expect(calls).toHaveLength(2);
    vi.setSystemTime((NOW + 31) * 1000);
    await svc.groups("1h", "ETH1");
    expect(calls).toHaveLength(4);
  });
});

/* The cost doesn't grow with the window: one range read with a point per bar
   (the bucket count, never the minute count), and one instant read over less
   than a bar. */
describe("error groups at a day, a week and a month", () => {
  const cases: [MetricWindow, number, number][] = [["1d", 1800, 48], ["7d", 21_600, 28], ["30d", 86_400, 30]];
  for (const [window, stepSec, maxBars] of cases) {
    it(`${window}: one range read, a point per ${stepSec / 60}-minute bar`, async () => {
      const calls: string[] = [];
      const { grid } = bucketGrid(window, NOW);
      const r = await new ErrorGroupsService(promOf([m(err({}), [[grid.start + 30, "5"]])], [v(err({}), "1")], calls), cfg).groups(window);
      const ranges = calls.filter((c) => c.startsWith("range "));
      expect(ranges).toHaveLength(1);
      const [, start, end, step] = /\[(\d+)s\]\)\) (\d+) (\d+) (\w+)$/.exec(ranges[0]!)!.slice(1).map((x, i) => (i < 3 ? Number(x) : x)) as [number, number, number, string];
      expect(ranges[0]).toContain(`[${stepSec}s]`);
      expect(step).toBe(`${stepSec}s`);
      // A point per whole bar, 30 s after each bar's end.
      expect((start - 30 - grid.start) % stepSec).toBe(0);
      expect((end - start) / stepSec + 1).toBeLessThanOrEqual(maxBars);
      // The bar still filling: one instant read over less than a bar.
      const instants = calls.filter((c) => c.startsWith("at "));
      expect(instants).toHaveLength(1);
      expect(Number(/\[(\d+)s\]/.exec(instants[0]!)![1])).toBeLessThan(stepSec);
      expect(r.groups[0]!.buckets).toHaveLength((grid.end - grid.start) / stepSec + 1);
      expect(r.groups[0]!.buckets[0]).toBe(5);
    });
  }
});

describe("error groups where the counts can't answer", () => {
  it("no series in the window and none of the family in the last day: no-series, so the web groups the list", async () => {
    const calls: string[] = [];
    const r = await new ErrorGroupsService(promOf([], [], calls, 0), cfg).groups("1h", "ETH1");
    expect(r).toMatchObject({ available: false, reason: "no-series", groups: [], source: null });
    expect(calls.at(-1)).toBe(`at count(present_over_time(${RECORDED_ERRORS}[86400s])) ${NOW}`);
  });

  it("the family recorded elsewhere: none failed on this scope - zero groups, not 'no series'", async () => {
    const calls: string[] = [];
    const r = await new ErrorGroupsService(promOf([], [], calls, 4), cfg).groups("1h", "ETH1");
    expect(r).toMatchObject({ available: true, source: "recorded", groups: [], total: 0, reached: { count: 0, buckets: bars({}) } });
  });

  it("a store that doesn't answer is 'unreachable' - never zero", async () => {
    const calls: string[] = [];
    expect(await new ErrorGroupsService(promOf(null, [], calls), cfg).groups("1h")).toMatchObject({ available: false, reason: "unreachable" });
    expect(await new ErrorGroupsService(promOf([], null, calls), cfg).groups("1h")).toMatchObject({ available: false, reason: "unreachable" });
    expect(await new ErrorGroupsService(promOf([], [], calls, null), cfg).groups("1h")).toMatchObject({ available: false, reason: "unreachable" });
  });

  it("the family check is kept five minutes, and looks back over the window - a day at least", async () => {
    const calls: string[] = [];
    const svc = new ErrorGroupsService(promOf([], [], calls, 0), cfg);
    const checks = () => calls.filter((c) => c.includes("present_over_time"));
    await svc.groups("1h");
    vi.setSystemTime((NOW + 40) * 1000); // past the report's own 30 s
    await svc.groups("1h");
    expect(checks()).toHaveLength(1);
    vi.setSystemTime((NOW + 301) * 1000);
    await svc.groups("1h");
    expect(checks()).toHaveLength(2);
    // Five minutes look back a day too - the check just made - and a month over the month.
    await svc.groups("5m");
    await svc.groups("30d");
    expect(checks().map((q) => /\[(\d+)s\]/.exec(q)?.[1])).toEqual(["86400", "86400", "2592000"]);
  });

  it("counts in the window: no family check", async () => {
    const calls: string[] = [];
    await new ErrorGroupsService(promOf([m(err({}), [[T0 + 30, "1"]])], [], calls), cfg).groups("1h");
    expect(calls.some((c) => c.includes("present_over_time"))).toBe(false);
  });
});

describe("error groups for a router", () => {
  const SIBLINGS = [
    m(err({ cluster: "demo", service_name: "demo-eth-prod" }), [[T0 + 30, "2"]]),
    m(err({ cluster: "demo", service_name: "demo-eth-canary", failing_provider: "node-c" }), [[T0 + 30, "7"]]),
  ];

  it("alone on its chain, it is its chain: no split needed", async () => {
    const calls: string[] = [];
    const sui = [m(err({ chain: "sui", failing_provider: "sui-a" }), [[T0 + 30, "5"]])];
    const r = await new ErrorGroupsService(promOf(sui, [], calls), cfg).groups("1h", undefined, "Sui");
    expect(calls[0]).toContain(`sum by (${BY}) (sum_over_time(${RECORDED_ERRORS}{chain="sui"}[600s]))`);
    expect(r.groups.map((g) => [g.spec, g.failingProvider, g.count])).toEqual([["SUI", "sui-a", 5]]);
  });

  it("sharing its chain, its own counts by service_name - <tenant>-<router id lower-cased>", async () => {
    const calls: string[] = [];
    const r = await new ErrorGroupsService(promOf(SIBLINGS, [], calls), cfg).groups("1h", undefined, "eth-prod");
    expect(calls[0]).toContain(`sum by (${BY}, cluster, service_name) (sum_over_time(${RECORDED_ERRORS}{chain="eth1"}[600s]))`);
    expect(r).toMatchObject({ available: true, total: 2 });
    expect(r.groups.map((g) => [g.failingProvider, g.count])).toEqual([["node-a", 2]]);
    const canary = await new ErrorGroupsService(promOf(SIBLINGS, [], calls), cfg).groups("1h", undefined, "eth-canary");
    expect(canary.groups.map((g) => [g.failingProvider, g.count])).toEqual([["node-c", 7]]);
  });

  it("sharing its chain, when no count names a router of the chain: shared-chain", async () => {
    const calls: string[] = [];
    const unnamed = [m(err({ cluster: "demo", service_name: "other-eth" }), [[T0 + 30, "2"]])];
    expect(await new ErrorGroupsService(promOf(unnamed, [], calls), cfg).groups("1h", undefined, "eth-prod"))
      .toMatchObject({ available: false, reason: "shared-chain", groups: [] });
  });

  it("an unknown router, one off the chain asked for, or a chain that isn't a plain token: nothing, without a read", async () => {
    const calls: string[] = [];
    const svc = new ErrorGroupsService(promOf(SIBLINGS, [], calls), cfg);
    expect(await svc.groups("1h", undefined, "nope")).toMatchObject({ available: true, groups: [], source: null });
    expect(await svc.groups("1h", "SUI", "eth-prod")).toMatchObject({ available: true, groups: [] });
    expect(await svc.groups("1h", 'ETH1"} or vector(1) #')).toMatchObject({ available: true, groups: [] });
    expect(calls).toEqual([]);
  });
});

describe("GET /api/error-groups", () => {
  let app: FastifyInstance;
  let queries: string[];
  /** A store with `matrix` for the range read, nothing in the running bar, and `family` samples of the family. */
  const store = (matrix: unknown[], family = 0) => {
    queries = [];
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(input.toString());
      const q = url.searchParams.get("query") ?? "";
      queries.push(q);
      if (url.pathname.endsWith("/api/v1/query_range") && q.includes(RECORDED_ERRORS)) {
        return Response.json({ status: "success", data: { resultType: "matrix", result: matrix } });
      }
      if (q.startsWith("count(present_over_time(") && family) {
        return Response.json({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [NOW, String(family)] }] } });
      }
      return Response.json({ status: "success", data: { resultType: "vector", result: [] } });
    });
  };
  afterEach(async () => {
    await app.close();
    delete process.env.METRICS_SCOPE_LABEL;
    delete process.env.METRICS_SCOPE_VALUE;
    vi.unstubAllGlobals();
  });

  it("answers with the groups; a chain that isn't a plain token is a 400", async () => {
    store([{ metric: err({}), values: [[T0 + 30, "2"]] }]);
    app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/error-groups?spec=ETH1%60" })).statusCode).toBe(400);
    const res = await app.inject({ method: "GET", url: "/api/error-groups?window=1h&spec=ETH1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      available: true, source: "recorded", total: 2, reached: { count: 2 },
      groups: [{ spec: "ETH1", errorClass: null, outcome: "no_answer", failingProvider: "node-a", reachedClient: true, count: 2, buckets: bars({ 5: 2 }) }],
    });
  });

  it("a store without the series answers not available, with the reason", async () => {
    store([], 0);
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/error-groups?window=7d" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: false, reason: "no-series", groups: [] });
  });

  it("the deployment scope rides on every read", async () => {
    process.env.METRICS_SCOPE_LABEL = "zone";
    process.env.METRICS_SCOPE_VALUE = "eu-west";
    store([], 0);
    app = await buildApp();
    await app.inject({ method: "GET", url: "/api/error-groups?window=1d&spec=ETH1" });
    const ours = queries.filter((q) => q.includes(RECORDED_ERRORS));
    expect(ours.length).toBeGreaterThanOrEqual(2);
    for (const q of ours) expect(q).toMatch(/smartrouter_request_errors:count1m\{zone="eu-west"(,chain="eth1")?\}/);
  });
});
