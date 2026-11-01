import { describe, expect, it } from "vitest";
import { WINDOWS } from "@sr/shared/constants";
import { rateRange } from "@sr/shared";
import { MetricsService } from "../services/metrics.js";
import { MetricsDetailService } from "../services/metrics-detail.js";
import type { ConfigurationService } from "../services/configuration.js";
import type {
  PrometheusClient,
  PromMatrixSample,
  PromVectorSample,
} from "../services/prometheus-client.js";

interface FakeAnswers {
  /** The chains `count by (spec)` lists. Default: one. */
  specs?: string[];
  /** Canned rows for an instant expression (`query()` and `scalar()`); undefined → none. */
  vector?: (expr: string) => PromVectorSample[] | undefined;
  /** Canned rows for a range expression; undefined → none. */
  matrix?: (expr: string) => PromMatrixSample[] | undefined;
}

/**
 * Fake Prometheus client that records every expression: all of them in
 * `queries`, the `scalar()` reads in `scalars`, the range reads in `ranges`.
 */
function capturingProm(answers: FakeAnswers = {}) {
  const queries: string[] = [];
  const scalars: string[] = [];
  const ranges: string[] = [];
  const prom = {
    async query(expr: string) {
      queries.push(expr);
      // listSpecs() must find a chain or the per-chain rows never appear.
      if (expr.startsWith("count by (spec)")) {
        return (answers.specs ?? ["ETH1"]).map((spec) => ({ metric: { spec }, value: [1, "1"] as [number, string] }));
      }
      return answers.vector?.(expr) ?? [];
    },
    async queryRange(expr: string) {
      queries.push(expr);
      ranges.push(expr);
      return answers.matrix?.(expr) ?? [];
    },
    async scalar(expr: string) {
      queries.push(expr);
      scalars.push(expr);
      const n = Number(answers.vector?.(expr)?.[0]?.value[1]);
      return Number.isFinite(n) ? n : null;
    },
    async ping() {
      return true;
    },
  } as unknown as PrometheusClient;
  return { prom, queries, scalars, ranges };
}

describe("MetricsService query construction (bug regressions)", () => {
  it("latency KPI priors use an offset — deltas were permanently 0 before", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).overview("1d");
    const latencyPriors = queries.filter(
      (q) => q.includes("histogram_quantile") && q.includes("offset 86400s"),
    );
    // p50, p95, p99 priors must all be offset by one window length.
    expect(latencyPriors.length).toBeGreaterThanOrEqual(3);
  });

  it("prior errors come from the derived error count, offset by the window", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).overview("1h");
    // round(clamp_min(total − success)) — whole errors, offset one window back.
    expect(
      queries.some((q) => q.includes("clamp_min(") && q.includes("offset 3600s")),
    ).toBe(true);
  });

  it("requests served / RPS are CLIENT-scoped (histogram _count), not relay-scoped", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).dashboardSummary("1d");
    // requestsServed must read the end-to-end latency histogram count — the
    // only counter that increments once per client request (requests_total
    // counts relays: cross-validation fan-out + tracker probes included).
    expect(
      queries.some((q) =>
        q.includes("round(sum(increase(smartrouter_end_to_end_latency_milliseconds_count"),
      ),
    ).toBe(true);
  });

  it("stale caught reads consistency_failed_total, never consistency_success_total", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).dashboardSummary("1d");
    // success_total counts checks that PASSED — displaying it as "stale
    // caught" was the original bug. With the failed family absent (this fake
    // returns no presence), no consistency_success query may run for the tile.
    expect(queries.every((q) => !q.includes("consistency_success_total"))).toBe(true);
  });

  it("per-chain health reads the spec-labelled ENDPOINT gauge, not the global router gauge", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).chains("1d");
    expect(queries.some((q) => q === "max by (spec) (rpc_endpoint_overall_health)")).toBe(true);
    // The label-less router gauge must not be used with a spec in mind:
    // it may appear alone (global health) but never filtered per chain.
    expect(queries.every((q) => !q.includes("smartrouter_overall_health{spec="))).toBe(true);
  });

  // MAG-2710: the hero tile read "50.0K across 4 upstreams" while the Routers
  // table below it showed 1 for the same chain — a chain-scoped numerator
  // paired with an account-wide upstream count. Both of these passed before
  // only because every existing dashboardSummary test called it without a spec.
  it("upstreamCount scopes to the selected chain (MAG-2710)", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).dashboardSummary("1d", "ETH1");
    expect(
      queries.some((q) =>
        q.includes('count by (endpoint_id) (rpc_endpoint_overall_health{spec="ETH1"}'),
      ),
    ).toBe(true);
    // The unfiltered form is what produced the wrong count — it must be gone.
    expect(
      queries.every((q) => !q.includes("count by (endpoint_id) (rpc_endpoint_overall_health)")),
    ).toBe(true);
  });

  it("hero health scopes to the selected chain, not the whole deployment (MAG-2710)", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).dashboardSummary("1d", "ETH1");
    expect(
      queries.some((q) => q.includes('max by (spec) (rpc_endpoint_overall_health{spec="ETH1"}')),
    ).toBe(true);
    // The label-less router gauge answers "is the deployment healthy", which is
    // the wrong question once a chain is selected.
    expect(queries.every((q) => q !== "smartrouter_overall_health")).toBe(true);
  });

  it("with no chain selected both stay account-wide", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).dashboardSummary("1d");
    // selector({ spec: undefined }) collapses to "" — no empty `{}` selector.
    expect(
      queries.some((q) => q === "count by (endpoint_id) (rpc_endpoint_overall_health)"),
    ).toBe(true);
    expect(queries.some((q) => q === "smartrouter_overall_health")).toBe(true);
  });
});

/** Every `by (…)` label list in a query: `sum by (spec, le) (…)` → ["spec, le"]. */
function groupings(q: string): string[] {
  return [...q.matchAll(/\bby \(([^)]*)\)/g)].map((m) => m[1] ?? "");
}

/** Quantiles over the router histogram with NO chain selector, at one range. */
function allChainQuantiles(queries: string[], range: string): string[] {
  return queries.filter(
    (q) =>
      q.startsWith("histogram_quantile(") &&
      q.includes(`smartrouter_end_to_end_latency_milliseconds_bucket[${range}]`),
  );
}

// With no chain selected, a quantile grouped `by (spec, le)` came back as one
// series per chain and scalar() kept the first: the hero p95 was whichever
// chain Prometheus listed first, and "—" when that chain had no traffic in the
// window, while all chains together had a p95. (The per-chain panel reads
// `by (spec, le)` on purpose, through `query()`, and joins on the label — see
// the grouped-reads cases below.)
describe("MetricsService · latency with no chain selected reads all chains as one", () => {
  it("hero p95 and its prior group by le only", async () => {
    const { prom, scalars } = capturingProm();
    await new MetricsService(prom).dashboardSummary("1d");
    const kpi = allChainQuantiles(scalars, "86400s");
    expect(kpi).toHaveLength(2);
    expect(kpi.filter((q) => q.includes("offset 86400s"))).toHaveLength(1);
    for (const q of kpi) expect(groupings(q)).toEqual(["le"]);
  });

  it("overview p50/p95/p99, their priors and the latency chart group by le only", async () => {
    const { prom, scalars, ranges } = capturingProm();
    await new MetricsService(prom).overview("1d");
    // 1d: the KPIs read [86400s], the chart's series one [10m] step each.
    const kpis = allChainQuantiles(scalars, "86400s");
    expect(kpis).toHaveLength(6);
    for (const q of kpis) expect(groupings(q)).toEqual(["le"]);
    // The chart plots the first series of each percentile, so it had the same bug.
    const chart = allChainQuantiles(ranges, "10m");
    expect(chart).toHaveLength(3);
    for (const q of chart) expect(groupings(q)).toEqual(["le"]);
  });
});

// MAG-4294: the overview read three series per chain for its per-chain panels,
// and the trend a second time for `perChainSeries` — about 200 reads on a
// 40-chain deployment, enough for the store to reject part of each burst and
// the rows to render empty. It reads one grouped series each and joins on the
// spec label.
describe("MetricsService.overview · per-chain panels read grouped series (MAG-4294)", () => {
  const perSpecP50 = "histogram_quantile(0.5, sum by (spec, le) (rate(smartrouter_end_to_end_latency_milliseconds_bucket";
  const perSpecHealth = "max by (spec) (rpc_endpoint_overall_health";
  const perSpecTrend = "sum by (spec) (rate(smartrouter_end_to_end_latency_milliseconds_count";
  const row = (spec: string, v: string): PromVectorSample => ({ metric: { spec }, value: [1, v] });

  it("costs the same number of reads for one chain as for three", async () => {
    const one = capturingProm({ specs: ["ETH1"] });
    await new MetricsService(one.prom).overview("1h");
    const three = capturingProm({ specs: ["ETH1", "SOLANA", "APT1"] });
    await new MetricsService(three.prom).overview("1h");
    expect(three.queries).toHaveLength(one.queries.length);
    // Without a chain filter no read names a single chain.
    expect(three.queries.every((q) => !q.includes('{spec="'))).toBe(true);
    expect(three.queries.filter((q) => q.startsWith(perSpecP50))).toHaveLength(1);
    expect(three.queries.filter((q) => q.startsWith(perSpecHealth))).toHaveLength(1);
    expect(three.ranges.filter((q) => q.startsWith(perSpecTrend))).toHaveLength(1);
  });

  it("joins the grouped rows onto each chain; a chain without a row keeps its nulls", async () => {
    const { prom } = capturingProm({
      specs: ["APT1", "ETH1", "SOLANA"],
      vector: (expr) => {
        // A NaN quantile is a chain with buckets but no samples in the window.
        if (expr.startsWith(perSpecP50)) return [row("ETH1", "42"), row("SOLANA", "NaN")];
        if (expr.startsWith(perSpecHealth)) return [row("ETH1", "0"), row("SOLANA", "1")];
        return undefined;
      },
      matrix: (expr) =>
        expr.startsWith(perSpecTrend) ? [{ metric: { spec: "ETH1" }, values: [[1, "3"], [2, "4"]] }] : undefined,
    });
    const data = await new MetricsService(prom).overview("1h");
    const by = Object.fromEntries(data.perChainLatency.map((c) => [c.spec, c]));
    expect(by.ETH1).toMatchObject({ p50Ms: 42, degraded: true, trend: [{ t: 1, v: 3 }, { t: 2, v: 4 }] });
    expect(by.SOLANA).toMatchObject({ p50Ms: null, degraded: false, trend: [] });
    expect(by.APT1).toMatchObject({ p50Ms: null, degraded: false, trend: [] });
    expect(data.perChainLatency.map((c) => c.spec)).toEqual(["APT1", "ETH1", "SOLANA"]);
    // perChainSeries is the same matrix, not a second read of it.
    const series = Object.fromEntries(data.perChainSeries.map((c) => [c.spec, c.points]));
    expect(series.ETH1).toEqual(by.ETH1!.trend);
    expect(series.SOLANA).toEqual([]);
  });

  it("a chain filter scopes the grouped reads to that chain", async () => {
    const { prom, queries, ranges } = capturingProm({ specs: ["ETH1", "SOLANA"] });
    const data = await new MetricsService(prom).overview("1h", "ETH1");
    expect(queries.find((q) => q.startsWith(perSpecP50))).toContain('{spec="ETH1"}[3600s]');
    expect(queries.find((q) => q.startsWith(perSpecHealth))).toBe(
      'max by (spec) (rpc_endpoint_overall_health{spec="ETH1"})',
    );
    expect(ranges.find((q) => q.startsWith(perSpecTrend))).toBe(
      // Never a rate over less than a minute: a 30-second range misses series whose scrapes don't land twice in it.
      `sum by (spec) (rate(smartrouter_end_to_end_latency_milliseconds_count{spec="ETH1"}[${rateRange(WINDOWS["1h"].step)}]))`,
    );
    expect(data.perChainLatency.map((c) => c.spec)).toEqual(["ETH1"]);
  });
});

// MAG-4322: the hero summary gated its optional-family reads behind their
// presence probes, then awaited the retries and cache pairs on their own —
// four round trips to the store per call, each waiting for the slowest read
// of the one before. Every read now goes out at once; the probes decide
// afterwards whether an answer is kept.
describe("MetricsService.dashboardSummary · one round of reads (MAG-4322)", () => {
  const PRESENCE = "count({__name__=";

  /** A client that records every read and answers none until `release()`. */
  function gatedProm(answer: (expr: string) => number | null) {
    const issued: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = async (expr: string): Promise<number | null> => {
      issued.push(expr);
      await gate;
      return answer(expr);
    };
    const prom = {
      async query(expr: string): Promise<PromVectorSample[]> {
        const v = await read(expr);
        return v === null ? [] : [{ metric: {}, value: [1, String(v)] }];
      },
      scalar: read,
      async queryRange() {
        return [];
      },
      async ping() {
        return true;
      },
    } as unknown as PrometheusClient;
    return { prom, issued, release: () => release() };
  }

  it("issues every read before the first one is answered", async () => {
    const { prom, issued, release } = gatedProm(() => 1);
    const pending = new MetricsService(prom).dashboardSummary("6h");
    await Promise.resolve();
    // 3 presence probes, 6 KPI pairs, the chain list, the upstream count, health.
    expect(issued).toHaveLength(18);
    expect(issued.filter((q) => q.startsWith(PRESENCE))).toHaveLength(3);
    const reads = issued.filter((q) => !q.startsWith(PRESENCE));
    expect(reads.filter((q) => q.includes("smartrouter_retries_success_total"))).toHaveLength(2);
    expect(reads.filter((q) => q.includes("cache_total_hits"))).toHaveLength(2);
    expect(reads.filter((q) => q.includes("smartrouter_consistency_failed_total"))).toHaveLength(2);
    release();
    await pending;
  });

  it("with a chain selected, the same eighteen reads, scoped", async () => {
    const { prom, issued, release } = gatedProm(() => 1);
    const pending = new MetricsService(prom).dashboardSummary("6h", "ETH1");
    await Promise.resolve();
    expect(issued).toHaveLength(18);
    // The six KPI pairs, the upstream count and the chain's health gauge.
    expect(issued.filter((q) => q.includes('spec="ETH1"'))).toHaveLength(14);
    release();
    await pending;
  });

  it("an answered read of an absent family is discarded, not shown", async () => {
    // Every probe says absent; every other read answers 7 anyway.
    const { prom, release } = gatedProm((expr) => (expr.startsWith(PRESENCE) ? 0 : 7));
    const pending = new MetricsService(prom).dashboardSummary("6h");
    release();
    const summary = await pending;
    expect(summary.requestsServed).toEqual({ value: 7, prior: 7 });
    expect(summary.retriesRecovered).toEqual({ value: null, prior: null });
    expect(summary.cacheOffloadPct).toEqual({ value: null, prior: null });
    // Absent consistency_failed_total = zero failures since boot, not unknown.
    expect(summary.staleCaught).toEqual({ value: 0, prior: 0 });
    expect(summary.emitted).toEqual({ retries: false, cache: false });
  });

  it("a present family's read is kept", async () => {
    const { prom, release } = gatedProm((expr) => (expr.startsWith(PRESENCE) ? 1 : 7));
    const pending = new MetricsService(prom).dashboardSummary("6h");
    release();
    const summary = await pending;
    expect(summary.retriesRecovered).toEqual({ value: 7, prior: 7 });
    expect(summary.cacheOffloadPct).toEqual({ value: 7, prior: 7 });
    expect(summary.staleCaught).toEqual({ value: 7, prior: 7 });
    expect(summary.emitted).toEqual({ retries: true, cache: true });
  });
});

describe("MetricsDetailService · chain-series backup share (MAG-2537)", () => {
  /** A chain whose values file marks one of two upstreams as the backup. */
  const configWithBackup = {
    getRouters: () => [
      {
        id: "SOLANA",
        spec: "SOLANA",
        network: "solana",
        pathBased: false,
        customUrlPrefix: null,
        localPort: null,
        localPorts: {},
        publicUrls: {},
        interfaces: ["jsonrpc"],
        nodes: [
          { name: "Tatum", isBackup: false, endpoints: [] },
          { name: "Blockdaemon", isBackup: true, endpoints: [] },
        ],
      },
    ],
  } as unknown as ConfigurationService;

  it("matches backup upstreams case-insensitively", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsDetailService(prom, configWithBackup).chainSeries("SOLANA", "1d");
    // The values file says `Blockdaemon`; the router may label its series
    // `blockdaemon`. Case-sensitive matching returned an empty numerator, which
    // the UI then rendered as a confident "0% backup".
    expect(
      queries.some((q) => q.includes('provider_address=~"(?i)(Blockdaemon)"')),
    ).toBe(true);
  });

  it("an unmatched backup selector is null, never a fabricated 0%", async () => {
    const { prom } = capturingProm();
    const series = await new MetricsDetailService(prom, configWithBackup).chainSeries(
      "SOLANA",
      "1d",
    );
    // Empty matrix ⇒ "no data", which must stay distinguishable from a real
    // measured zero. `[]` is truthy in the web layer, so returning it here is
    // what let the fabricated tile through.
    expect(series.backupShare).toBeNull();
  });
});

describe("MetricsService · router attribution on the upstream roster", () => {
  /** Two routers on ONE chain — the case a chain filter alone can't separate.
   *  `shared-node` is declared by both, which is how one series ends up
   *  belonging to two routers. */
  const twoRoutersOneChain = {
    getRouters: () => [
      {
        id: "eth-prod",
        spec: "ETH1",
        network: "eth1",
        pathBased: false,
        customUrlPrefix: null,
        localPort: null,
        localPorts: {},
        publicUrls: {},
        interfaces: ["jsonrpc"],
        nodes: [
          { name: "prod-vendor", isBackup: false, endpoints: [{ interface: "jsonrpc", urlHost: "https://a", addons: [] }] },
          { name: "shared-node", isBackup: false, endpoints: [{ interface: "jsonrpc", urlHost: "https://s", addons: [] }] },
        ],
      },
      {
        id: "eth-staging",
        spec: "ETH1",
        network: "eth1",
        pathBased: false,
        customUrlPrefix: null,
        localPort: null,
        localPorts: {},
        publicUrls: {},
        interfaces: ["jsonrpc"],
        nodes: [
          { name: "staging-vendor", isBackup: false, endpoints: [{ interface: "jsonrpc", urlHost: "https://b", addons: [] }] },
          { name: "shared-node", isBackup: false, endpoints: [{ interface: "jsonrpc", urlHost: "https://s", addons: [] }] },
        ],
      },
    ],
  } as unknown as ConfigurationService;

  /** Prom client that reports traffic for the three distinct node names. */
  function promWithEndpoints(): PrometheusClient {
    const rows = (ids: string[]) =>
      ids.map((id) => ({ metric: { endpoint_id: id, spec: "ETH1" }, value: [1, "10"] as [number, string] }));
    return {
      async query(expr: string) {
        if (expr.startsWith("count by (spec)")) {
          return [{ metric: { spec: "ETH1" }, value: [1, "1"] as [number, string] }];
        }
        if (expr.includes("endpoint_id")) return rows(["prod-vendor", "staging-vendor", "shared-node"]);
        return [];
      },
      async queryRange() { return []; },
      async scalar() { return null; },
      async ping() { return true; },
    } as unknown as PrometheusClient;
  }

  it("names every config router that declares an upstream", async () => {
    const rows = await new MetricsService(promWithEndpoints(), twoRoutersOneChain).upstreams(
      undefined,
      "1d",
    );
    const byId = new Map(rows.map((r) => [r.endpointId, r.routerIds]));
    expect(byId.get("prod-vendor")).toEqual(["eth-prod"]);
    expect(byId.get("staging-vendor")).toEqual(["eth-staging"]);
    // One name, two routers: the series can't be split, so BOTH are named
    // rather than one of them being picked.
    expect(byId.get("shared-node")).toEqual(["eth-prod", "eth-staging"]);
  });

  it("routerId filters the roster to what that router declares", async () => {
    const rows = await new MetricsService(promWithEndpoints(), twoRoutersOneChain).upstreams(
      undefined,
      "1d",
      "eth-staging",
    );
    expect(rows.map((r) => r.endpointId).sort()).toEqual(["shared-node", "staging-vendor"]);
  });

  it("an upstream the config no longer places is filtered out, not guessed at", async () => {
    const prom = {
      async query(expr: string) {
        if (expr.startsWith("count by (spec)")) {
          return [{ metric: { spec: "ETH1" }, value: [1, "1"] as [number, string] }];
        }
        if (expr.includes("endpoint_id")) {
          return [{ metric: { endpoint_id: "gone-vendor", spec: "ETH1" }, value: [1, "5"] as [number, string] }];
        }
        return [];
      },
      async queryRange() { return []; },
      async scalar() { return null; },
      async ping() { return true; },
    } as unknown as PrometheusClient;
    const svc = new MetricsService(prom, twoRoutersOneChain);
    // Unfiltered it still shows up (real traffic, honestly reported) with no
    // router to its name; asked for one router's rows, it is not one of them.
    const all = await svc.upstreams(undefined, "1d");
    expect(all.find((r) => r.endpointId === "gone-vendor")?.routerIds).toEqual([]);
    const prod = await svc.upstreams(undefined, "1d", "eth-prod");
    expect(prod.every((r) => r.routerIds.includes("eth-prod"))).toBe(true);
    expect(prod.some((r) => r.endpointId === "gone-vendor")).toBe(false);
    expect(prod).toHaveLength(2); // Configured rows remain visible without metrics.
  });
});

/**
 * QoS without traffic.
 *
 * The router publishes one set of scores through two gauges. The routing path's
 * (`rpc_endpoint_selection_score`) exists only where a relay was routed; the
 * sampler's (`rpc_optimizer_selection_score`) is refreshed for every upstream on
 * a timer, fed by the probe loop. The roster read the first, so a backup nobody
 * had failed over to had no score at all — the router was scoring it the whole
 * time.
 */
describe("MetricsService.upstreams · scores without traffic", () => {
  /** Builds a prom stub from explicit per-family answers. */
  function prom(answers: {
    optimizer?: [string, string, string][];
    endpoint?: [string, string, string][];
    pollsOk?: [string, string][];
    pollsFailed?: [string, string][];
    relays?: [string, string][];
  }): PrometheusClient {
    const vec = (rows: [string, string, string][]) =>
      rows.map(([id, type, v]) => ({
        metric: { endpoint_id: id, spec: "ETH1", score_type: type },
        value: [1, v] as [number, string],
      }));
    const plain = (rows: [string, string][]) =>
      rows.map(([id, v]) => ({
        metric: { endpoint_id: id, spec: "ETH1" },
        value: [1, v] as [number, string],
      }));
    return {
      async query(expr: string) {
        if (expr.startsWith("count by (spec)")) {
          return [{ metric: { spec: "ETH1" }, value: [1, "1"] as [number, string] }];
        }
        if (expr.includes("rpc_optimizer_selection_score")) return vec(answers.optimizer ?? []);
        if (expr.includes("rpc_endpoint_selection_score")) return vec(answers.endpoint ?? []);
        if (expr.includes("fetch_latest_success")) return plain(answers.pollsOk ?? []);
        if (expr.includes("fetch_latest_fails")) return plain(answers.pollsFailed ?? []);
        if (expr.includes("total_relays_serviced")) return plain(answers.relays ?? []);
        return [];
      },
      async queryRange() { return []; },
      async scalar() { return null; },
      async ping() { return true; },
    } as unknown as PrometheusClient;
  }

  const row = async (p: PrometheusClient, id: string) =>
    (await new MetricsService(p).upstreams(undefined, "1d")).find((r) => r.endpointId === id);

  it("one row per upstream × chain: poll counts join the row they belong to, never a chain-less copy", async () => {
    // Answer as Prometheus does - only the labels the query groups by. A poll
    // query grouped by endpoint alone came back without `spec`, and the join
    // made a second row with an empty chain for every upstream.
    const labelled = (expr: string, id: string) => {
      const by = /sum by \(([^)]*)\)/.exec(expr)?.[1]?.split(",").map((x) => x.trim()) ?? ["endpoint_id", "spec"];
      return Object.fromEntries(Object.entries({ endpoint_id: id, spec: "ETH1" }).filter(([k]) => by.includes(k)));
    };
    const p = {
      async query(expr: string) {
        if (expr.includes("fetch_latest_success") || expr.includes("total_relays_serviced")) {
          return [{ metric: labelled(expr, "eth-a"), value: [1, "10"] as [number, string] }];
        }
        return [];
      },
      async queryRange() { return []; },
      async scalar() { return null; },
      async ping() { return true; },
    } as unknown as PrometheusClient;
    const rows = await new MetricsService(p).upstreams(undefined, "1d");
    expect(rows.map((r) => [r.endpointId, r.spec])).toEqual([["eth-a", "ETH1"]]);
  });

  it("scores an upstream that served nothing, and says the score is live", async () => {
    // The whole point: zero relays, real score. This is the backup case.
    const backup = await row(
      prom({ optimizer: [["cold-backup", "composite", "0.97"], ["cold-backup", "availability", "1"]] }),
      "cold-backup",
    );
    expect(backup?.requests).toBe(0);
    expect(backup?.scores.composite).toBeCloseTo(0.97);
    expect(backup?.scores.availability).toBe(1);
    expect(backup?.scoreSource).toBe("optimizer");
  });

  it("prefers the sampler's gauge over the routing path's for the same upstream", async () => {
    const r = await row(
      prom({
        optimizer: [["eth-lava", "composite", "0.99"]],
        endpoint: [["eth-lava", "composite", "0.42"]],
        relays: [["eth-lava", "5000"]],
      }),
      "eth-lava",
    );
    expect(r?.scores.composite).toBeCloseTo(0.99);
    expect(r?.scoreSource).toBe("optimizer");
  });

  it("falls back to the routing path's gauge when the sampler's is absent", async () => {
    // An older router build. Same numbers, written only on selection — so the
    // row still gets a score rather than an empty column.
    const r = await row(prom({ endpoint: [["eth-lava", "composite", "0.42"]] }), "eth-lava");
    expect(r?.scores.composite).toBeCloseTo(0.42);
    expect(r?.scoreSource).toBe("endpoint");
  });

  it("never blends the two gauges within one row", async () => {
    // Mixing them would put two different write cadences under one number and
    // make `scoreSource` a lie for whichever half it did not name.
    const r = await row(
      prom({
        optimizer: [["eth-lava", "composite", "0.99"]],
        endpoint: [["eth-lava", "composite", "0.42"], ["eth-lava", "latency", "0.10"]],
      }),
      "eth-lava",
    );
    expect(r?.scoreSource).toBe("optimizer");
    expect(r?.scores.composite).toBeCloseTo(0.99);
    expect(r?.scores.latency).toBeUndefined();
  });

  it("lets each row pick its own source", async () => {
    const p = prom({
      optimizer: [["new-node", "composite", "0.9"]],
      endpoint: [["old-node", "composite", "0.5"]],
    });
    const rows = await new MetricsService(p).upstreams(undefined, "1d");
    const by = new Map(rows.map((r) => [r.endpointId, r.scoreSource]));
    expect(by.get("new-node")).toBe("optimizer");
    expect(by.get("old-node")).toBe("endpoint");
  });

  it("leaves scoreSource null when neither gauge names the upstream", async () => {
    const r = await row(prom({ relays: [["quiet", "0"]] }), "quiet");
    expect(r?.scores).toEqual({});
    expect(r?.scoreSource).toBeNull();
  });

  it("reports poll outcomes, which need no traffic either", async () => {
    const r = await row(
      prom({ optimizer: [["cold-backup", "composite", "0.97"]], pollsOk: [["cold-backup", "287.6"]], pollsFailed: [["cold-backup", "2.2"]] }),
      "cold-backup",
    );
    // Poll counts are whole events — increase() extrapolation is rounded off.
    expect(r?.polls).toEqual({ ok: 288, failed: 2 });
  });

  it("keeps 'family absent' distinct from 'polled zero times'", async () => {
    // null ⇒ an older router that does not publish the counters at all.
    // {0,0} ⇒ it does, and the poll gate suppressed every poll this window —
    // which is "we did not ask", not "it answered fine".
    const absent = await row(prom({ optimizer: [["a", "composite", "1"]] }), "a");
    expect(absent?.polls).toBeNull();

    const zero = await row(prom({ pollsOk: [["b", "0"]], pollsFailed: [["b", "0"]] }), "b");
    expect(zero?.polls).toEqual({ ok: 0, failed: 0 });
  });
});

describe("MetricsService · cross-chain shared node names (MAG-2875)", () => {
  /** Two routers on DIFFERENT chains reusing one vendor node name - a shape
   *  production deployments have: every chain's router declares
   *  "lava"/"publicnode"-style nodes. */
  const twoChainsSharedName = {
    getRouters: () => [
      {
        id: "Ethereum",
        spec: "ETH1",
        network: "eth1",
        pathBased: false,
        customUrlPrefix: null,
        localPort: null,
        localPorts: {},
        publicUrls: {},
        interfaces: ["jsonrpc"],
        nodes: [
          { name: "lava", isBackup: false, endpoints: [{ interface: "jsonrpc", urlHost: "https://a", addons: [] }] },
        ],
      },
      {
        id: "Solana",
        spec: "SOLANA",
        network: "solana",
        pathBased: false,
        customUrlPrefix: null,
        localPort: null,
        localPorts: {},
        publicUrls: {},
        interfaces: ["jsonrpc"],
        nodes: [
          { name: "lava", isBackup: true, endpoints: [{ interface: "jsonrpc", urlHost: "https://b", addons: [] }] },
        ],
      },
    ],
  } as unknown as ConfigurationService;

  /** Traffic for the SAME endpoint_id on both chains. */
  function promTwoSpecs(): PrometheusClient {
    return {
      async query(expr: string) {
        if (expr.startsWith("count by (spec)")) {
          return [
            { metric: { spec: "ETH1" }, value: [1, "1"] as [number, string] },
            { metric: { spec: "SOLANA" }, value: [1, "1"] as [number, string] },
          ];
        }
        if (expr.includes("endpoint_id")) {
          return [
            { metric: { endpoint_id: "lava", spec: "ETH1" }, value: [1, "10"] as [number, string] },
            { metric: { endpoint_id: "lava", spec: "SOLANA" }, value: [1, "5"] as [number, string] },
          ];
        }
        return [];
      },
      async queryRange() { return []; },
      async scalar() { return null; },
      async ping() { return true; },
    } as unknown as PrometheusClient;
  }

  it("keeps one row per (endpoint × chain) and attributes each to its own chain's router", async () => {
    const rows = await new MetricsService(promTwoSpecs(), twoChainsSharedName).upstreams(
      undefined,
      "1d",
    );
    // Keyed by endpoint_id alone this collapsed to ONE row wearing the first
    // spec Prometheus returned, and every chain's row named the first router
    // in the values file — the "router says ETH for all chains" bug.
    expect(rows.map((r) => [r.endpointId, r.spec, r.routerIds])).toEqual([
      ["lava", "ETH1", ["Ethereum"]],
      ["lava", "SOLANA", ["Solana"]],
    ]);
  });

  it("resolves role and the routerId filter per chain, not per name", async () => {
    const svc = new MetricsService(promTwoSpecs(), twoChainsSharedName);
    const rows = await svc.upstreams(undefined, "1d");
    // ETH1 declares the node primary, SOLANA declares it backup — first-wins
    // name-only lookup gave SOLANA's row ETH1's role.
    expect(rows.map((r) => [r.spec, r.role])).toEqual([
      ["ETH1", "primary"],
      ["SOLANA", "backup"],
    ]);
    const solOnly = await svc.upstreams(undefined, "1d", "Solana");
    expect(solOnly.map((r) => [r.endpointId, r.spec])).toEqual([["lava", "SOLANA"]]);
  });
});

// MAG-4295: `chains()` and the Routers table read eight series per chain or
// per router. They read seven grouped series per set and join on the labels.
describe("MetricsService · chain-level figures read grouped series (MAG-4295)", () => {
  const row = (metric: Record<string, string>, v: string): PromVectorSample => ({ metric, value: [1, v] });
  const answers = (expr: string): PromVectorSample[] | undefined => {
    if (expr.startsWith("sum by (spec) (increase(smartrouter_end_to_end_latency_milliseconds_count")) return [row({ spec: "ETH1" }, "1234.4")];
    if (expr.startsWith("clamp_max(sum by (spec) (increase(smartrouter_requests_success_total")) return [row({ spec: "ETH1" }, "0.995")];
    if (expr.startsWith("histogram_quantile(0.95, sum by (spec, le)")) return [row({ spec: "ETH1" }, "42"), row({ spec: "SOLANA" }, "NaN")];
    if (expr.startsWith("avg by (spec) (rpc_endpoint_selection_score")) return [row({ spec: "ETH1" }, "0.9")];
    if (expr === "max by (spec) (rpc_endpoint_overall_health)") return [row({ spec: "ETH1" }, "1"), row({ spec: "SOLANA" }, "0")];
    if (expr === "max by (spec) (smartrouter_latest_block)") return [row({ spec: "ETH1" }, "100")];
    if (expr === "count by (spec, endpoint_id) (rpc_endpoint_overall_health)") {
      return [row({ spec: "ETH1", endpoint_id: "a" }, "1"), row({ spec: "ETH1", endpoint_id: "b" }, "1"), row({ endpoint_id: "orphan" }, "1")];
    }
    return undefined;
  };

  it("costs the same reads for one chain as for three", async () => {
    const one = capturingProm({ specs: ["ETH1"] });
    await new MetricsService(one.prom).chains("1h");
    const three = capturingProm({ specs: ["ETH1", "SOLANA", "APT1"] });
    await new MetricsService(three.prom).chains("1h");
    // The chain list, then seven grouped reads.
    expect(one.queries).toHaveLength(1 + 7);
    expect(three.queries).toHaveLength(one.queries.length);
    expect(three.queries.every((q) => !q.includes('{spec="'))).toBe(true);
  });

  it("joins every figure on the spec label and derives the error rate from the availability read", async () => {
    const { prom, queries } = capturingProm({ specs: ["ETH1", "SOLANA"], vector: answers });
    const chains = await new MetricsService(prom).chains("1h");
    const eth = chains.find((c) => c.spec === "ETH1")!;
    expect(eth).toMatchObject({ requests: 1234, availability: 0.995, p95Ms: 42, qos: 0.9, health: "operational", latestBlock: 100, upstreamCount: 2 });
    expect(eth.errorRate).toBeCloseTo(0.005, 10);
    // No second read of the ratio for the error rate.
    expect(queries.filter((q) => q.startsWith("1 - ("))).toHaveLength(0);
    // A NaN quantile is "no samples"; a health gauge of 0 is unhealthy; the rest never arrived.
    const sol = chains.find((c) => c.spec === "SOLANA")!;
    expect(sol).toMatchObject({ requests: 0, availability: null, errorRate: null, p95Ms: null, qos: null, health: "unhealthy", latestBlock: null, upstreamCount: 0 });
  });

  it("the Routers table reads per-target rows for the routers the collector splits, and the chain row for the rest", async () => {
    const topology = [
      { id: "eth-prod", spec: "ETH1", nodes: [{}, {}] },
      { id: "eth-staging", spec: "ETH1", nodes: [{}] },
      { id: "sol-main", spec: "SOLANA", nodes: [{}] },
    ];
    const configSvc = { getRouters: () => topology } as unknown as ConfigurationService;
    const { prom, queries } = capturingProm({
      vector: (expr) => {
        if (expr.startsWith("count by (service)")) return [row({ service: "eth-prod-router" }, "1")];
        if (expr.startsWith("sum by (spec, service) (increase(smartrouter_end_to_end_latency_milliseconds_count")) {
          return [row({ spec: "ETH1", service: "eth-prod-router" }, "700")];
        }
        return answers(expr);
      },
    });
    const rows = await new MetricsService(prom, configSvc).routers("1h", "service");
    // Target discovery + one set by spec + one set by (spec, service): never a read per router.
    expect(queries).toHaveLength(1 + 7 + 7);
    const by = Object.fromEntries(rows.map((r) => [r.routerId, r]));
    expect(by["eth-prod"]).toMatchObject({ attribution: "own", requests: 700, upstreamCount: 2, sharedWith: [] });
    expect(by["eth-staging"]).toMatchObject({ attribution: "shared", requests: 1234, sharedWith: ["eth-prod"], upstreamCount: 1 });
    expect(by["sol-main"]).toMatchObject({ attribution: "own", requests: 0, health: "unhealthy", sharedWith: [] });
  });

  it.each(["spec", "le", "endpoint_id"])("%s, a label the grouped reads use, cannot serve as the target label", async (label) => {
    const configSvc = { getRouters: () => [{ id: "eth-prod", spec: "ETH1", nodes: [] }] } as unknown as ConfigurationService;
    const { prom, queries } = capturingProm();
    const rows = await new MetricsService(prom, configSvc).routers("1h", label);
    // No target discovery and no per-target set: the one chain-level set only.
    expect(queries).toHaveLength(7);
    expect(queries.some((q) => q.startsWith(`count by (${label})`))).toBe(false);
    expect(rows[0]!.attribution).toBe("own");
  });
});

// MAG-4296: the topbar read the full overview — dozens of reads, per-chain
// series it never shows — every 30 s on every page, for three fields.
describe("MetricsService.pulse · the topbar reads six series, not the overview (MAG-4296)", () => {
  it("costs six reads whatever the chain count, none of them per chain", async () => {
    const { prom, queries } = capturingProm({ specs: ["ETH1", "SOLANA", "APT1"] });
    const pulse = await new MetricsService(prom).pulse();
    expect(queries).toHaveLength(6);
    expect(queries).toContain("smartrouter_overall_health");
    expect(queries).toContain("sum(rate(smartrouter_end_to_end_latency_milliseconds_count[5m]))");
    expect(queries.every((q) => !q.includes("histogram_quantile") && !q.startsWith("count by (spec)"))).toBe(true);
    expect(pulse).toMatchObject({ health: "unknown", upstreamHealthCounts: { unhealthy: 0, unknown: 0 }, throughputRps: null });
  });

  it("under a chain filter reads that chain's endpoint gauge and RPS, like the hero", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).pulse("ETH1");
    expect(queries).toContain('max by (spec) (rpc_endpoint_overall_health{spec="ETH1"})');
    expect(queries).toContain('sum(rate(smartrouter_end_to_end_latency_milliseconds_count{spec="ETH1"}[5m]))');
    expect(queries.every((q) => q !== "smartrouter_overall_health")).toBe(true);
  });
});
