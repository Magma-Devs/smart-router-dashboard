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
