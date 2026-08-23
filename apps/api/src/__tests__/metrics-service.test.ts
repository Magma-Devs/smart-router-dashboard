import { describe, expect, it } from "vitest";
import { MetricsService } from "../services/metrics.js";
import { MetricsDetailService } from "../services/metrics-detail.js";
import type { ConfigurationService } from "../services/configuration.js";
import type { PrometheusClient } from "../services/prometheus-client.js";

/** Fake Prometheus client that records every instant/range expression. */
function capturingProm(): { prom: PrometheusClient; queries: string[] } {
  const queries: string[] = [];
  const prom = {
    async query(expr: string) {
      queries.push(expr);
      // listSpecs() must find one chain or per-chain queries never fire.
      if (expr.startsWith("count by (spec)")) {
        return [{ metric: { spec: "ETH1" }, value: [1, "1"] as [number, string] }];
      }
      return [];
    },
    async queryRange(expr: string) {
      queries.push(expr);
      return [];
    },
    async scalar(expr: string) {
      queries.push(expr);
      return null;
    },
    async ping() {
      return true;
    },
  } as unknown as PrometheusClient;
  return { prom, queries };
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
    expect(
      queries.some((q) =>
        q.includes('max by (spec) (rpc_endpoint_overall_health{spec="'),
      ),
    ).toBe(true);
    // The label-less router gauge must not be used with a spec in mind:
    // it may appear alone (global health) but never filtered per chain.
    expect(queries.every((q) => !q.includes('smartrouter_overall_health{spec='))).toBe(true);
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
    expect(queries.every((q) => !q.includes("smartrouter_overall_health"))).toBe(true);
  });

  it("with no chain selected both stay account-wide", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).dashboardSummary("1d");
    // selector({ spec: undefined }) collapses to "" — no empty `{}` selector.
    expect(
      queries.some((q) => q === "count by (endpoint_id) (rpc_endpoint_overall_health)"),
    ).toBe(true);
    expect(queries.some((q) => q === "max(smartrouter_overall_health)")).toBe(true);
  });
});

describe("MetricsService · gauges fold replicas (MAG-2982)", () => {
  // With `autoscaling.maxReplicas > 1` every router pod is its own scrape
  // target. A raw gauge selector therefore returns one row per pod; `scalar()`
  // keeps result[0] and the roster Maps keep the last row, so which replica
  // answered was down to Prometheus' series order.
  it("deployment health reads max() over the label-less router gauge", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).dashboardSummary("1d");
    await new MetricsService(prom).overview("1d");
    expect(queries.filter((q) => q === "max(smartrouter_overall_health)")).toHaveLength(2);
    expect(queries.some((q) => q === "smartrouter_overall_health")).toBe(false);
  });

  it("upstream roster gauges are aggregated by endpoint, never raw selectors", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).upstreams("ETH1", "1d");
    expect(queries).toContain(
      'avg by (spec, endpoint_id, score_type) (rpc_endpoint_selection_score{spec="ETH1"})',
    );
    expect(queries).toContain(
      'max by (spec, endpoint_id, apiInterface) (rpc_endpoint_overall_health{spec="ETH1"})',
    );
    expect(queries).toContain('max by (spec, endpoint_id) (rpc_endpoint_latest_block{spec="ETH1"})');
    // The raw forms are exactly what produced last-pod-wins rows.
    expect(queries).not.toContain('rpc_endpoint_selection_score{spec="ETH1"}');
    expect(queries).not.toContain('rpc_endpoint_overall_health{spec="ETH1"}');
    expect(queries).not.toContain('rpc_endpoint_latest_block{spec="ETH1"}');
  });

  it("block tips fold per-pod health and tip-change rows before keying by endpoint", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsService(prom).blockTips("service", "ETH1");
    expect(queries).toContain(
      'max by (spec, endpoint_id, apiInterface) (rpc_endpoint_overall_health{spec="ETH1"})',
    );
    expect(queries).toContain(
      'max by (spec, endpoint_id, apiInterface) (changes(rpc_endpoint_latest_block{spec="ETH1"}[15m]))',
    );
    expect(queries).not.toContain('rpc_endpoint_overall_health{spec="ETH1"}');
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
    expect((await svc.upstreams(undefined, "1d")).map((r) => r.routerIds)).toEqual([[]]);
    expect(await svc.upstreams(undefined, "1d", "eth-prod")).toEqual([]);
  });
});
