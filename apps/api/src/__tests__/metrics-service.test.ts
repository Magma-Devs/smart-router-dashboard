import { describe, expect, it } from "vitest";
import { MetricsService } from "../services/metrics.js";
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
});

/* ── Upstream roster: role + per-chain rows (MAG-2537 item 2) ─────────────── */

/**
 * Prometheus with one upstream serving two chains, labelled the way the ROUTER
 * labels it — lower-case, regardless of how the values file spells the node.
 */
function rosterProm(): PrometheusClient {
  const relays = [
    { metric: { endpoint_id: "blockdaemon", spec: "SOLANA" }, value: [1, "100"] as [number, string] },
    { metric: { endpoint_id: "blockdaemon", spec: "SOLANAT" }, value: [1, "50"] as [number, string] },
  ];
  return {
    async query(expr: string) {
      return expr.includes("total_relays_serviced") ? relays : [];
    },
    async queryRange() {
      return [];
    },
    async scalar() {
      return null;
    },
    async ping() {
      return true;
    },
  } as unknown as PrometheusClient;
}

/** Topology stub; `localPort` is what the removed `isHelm` gate keyed off. */
function topology(
  routers: {
    spec: string;
    localPort: number | null;
    nodes: { name: string; isBackup: boolean }[];
  }[],
): ConfigurationService {
  return {
    getRouters: () =>
      routers.map((r) => ({
        id: r.spec,
        spec: r.spec,
        network: r.spec.toLowerCase(),
        pathBased: false,
        customUrlPrefix: null,
        localPort: r.localPort,
        localPorts: {},
        publicUrls: {},
        interfaces: ["jsonrpc"],
        nodes: r.nodes.map((n) => ({
          ...n,
          endpoints: [{ urlHost: "https://x", interface: "jsonrpc", addons: [] }],
        })),
      })),
  } as unknown as ConfigurationService;
}

describe("MetricsService.upstreams · role resolution", () => {
  /** Values file spells the node `Blockdaemon`; the series say `blockdaemon`. */
  const twoChains = topology([
    { spec: "SOLANA", localPort: null, nodes: [{ name: "Tatum", isBackup: false }, { name: "Blockdaemon", isBackup: true }] },
    { spec: "SOLANAT", localPort: null, nodes: [{ name: "Blockdaemon", isBackup: false }] },
  ]);

  it("resolves role per (upstream, chain) — the same upstream differs across chains", async () => {
    const rows = await new MetricsService(rosterProm(), twoChains).upstreams(undefined, "1d");
    const solana = rows.find((r) => r.endpointId === "blockdaemon" && r.spec === "SOLANA");
    const testnet = rows.find((r) => r.endpointId === "blockdaemon" && r.spec === "SOLANAT");
    // One row per chain served — the roster's Chain column has always implied
    // this; keying on the name alone collapsed them into one last-wins row.
    expect(rows).toHaveLength(2);
    expect(solana?.role).toBe("backup");
    expect(testnet?.role).toBe("primary");
    // …and each keeps its own numbers rather than overwriting the other's.
    expect(solana?.requests).toBe(100);
    expect(testnet?.requests).toBe(50);
  });

  it("matches the config node name case-insensitively", async () => {
    const rows = await new MetricsService(rosterProm(), twoChains).upstreams(undefined, "1d");
    // `Blockdaemon` in the values file vs `blockdaemon` on the series: a
    // case-sensitive lookup left role null and the chip never rendered.
    expect(rows.every((r) => r.role !== null)).toBe(true);
  });

  it("marks backups on an SR_CONFIG mount too, not just helm", async () => {
    // SR_CONFIG routers carry a localPort — the old `isHelm` gate keyed off
    // exactly that and pinned role to null for every such mount, even though
    // the parser marks `backup-direct-rpc` nodes isBackup.
    const srConfig = topology([
      { spec: "SOLANA", localPort: 3360, nodes: [{ name: "blockdaemon", isBackup: true }] },
    ]);
    const rows = await new MetricsService(rosterProm(), srConfig).upstreams(undefined, "1d");
    expect(rows.find((r) => r.spec === "SOLANA")?.role).toBe("backup");
  });

  it("leaves role null when the config doesn't describe the upstream", async () => {
    const rows = await new MetricsService(rosterProm(), topology([])).upstreams(undefined, "1d");
    expect(rows.every((r) => r.role === null)).toBe(true);
  });
});
