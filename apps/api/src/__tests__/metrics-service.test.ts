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
