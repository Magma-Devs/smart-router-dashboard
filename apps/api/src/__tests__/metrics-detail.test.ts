import { describe, expect, it } from "vitest";
import { MetricsDetailService } from "../services/metrics-detail.js";
import type { PrometheusClient } from "../services/prometheus-client.js";

/** Fake Prometheus client that records every instant/range expression.
 *  Mirrors the harness in metrics-service.test.ts. */
function capturingProm(): { prom: PrometheusClient; queries: string[] } {
  const queries: string[] = [];
  const prom = {
    async query(expr: string) {
      queries.push(expr);
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

describe("MetricsDetailService query construction (bug regressions)", () => {
  // MAG-2737: the ChainDetail "Requests / sec" chart read the RELAY-scoped
  // counter, which counts the router's own health probes and one increment per
  // cross-validation participant. On an idle chain it drew a permanent
  // non-zero floor, and it disagreed with the Traffic tab's chart of the same
  // name — that one has always been client-scoped, as is the hero
  // "Requests served" card. This service had no tests at all, which is how the
  // two surfaces drifted apart unnoticed.
  it("chain rps series is CLIENT-scoped, not the relay counter (MAG-2737)", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsDetailService(prom).chainSeries("ETH1", "1d");

    // The latency histogram _count increments once per client request.
    expect(
      queries.some((q) =>
        q.includes('sum(rate(smartrouter_end_to_end_latency_milliseconds_count{spec="ETH1"}'),
      ),
    ).toBe(true);

    // No expression may be a BARE relay rate — that is the old rps series.
    // `includes` would be wrong here: availability is
    // `clamp_max(sum(rate(success_total…)) / sum(rate(requests_total…)), 1)`,
    // where requests_total is a legitimate denominator (both sides are
    // relay-scoped, so the ratio is sound). Only a leading, undivided
    // `sum(rate(requests_total…))` is the throughput bug.
    expect(
      queries.every((q) => !q.startsWith("sum(rate(smartrouter_requests_total")),
    ).toBe(true);
  });

  it("every chain-series expression scopes to the requested spec", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsDetailService(prom).chainSeries("ETH1", "1d");
    // A series that silently went account-wide would make the expanded row
    // describe the whole deployment rather than the chain that was clicked.
    const unscoped = queries.filter((q) => !q.includes('spec="ETH1"'));
    expect(unscoped).toEqual([]);
  });
});

describe("MetricsDetailService.retries", () => {
  const vec = (metric: Record<string, string>, v: number) => ({ metric, value: [1, String(v)] as [number, string] });

  /** The retry family present; canned rows keyed on the counter each query reads. */
  function retryProm(): PrometheusClient {
    return {
      async query(expr: string) {
        if (expr.includes("retries_success_total")) {
          return [vec({ spec: "SOLANA", method: "getSlot" }, 11), vec({ spec: "ETH1", method: "eth_getLogs" }, 2)];
        }
        if (expr.includes("retries_failed_total")) return [vec({ spec: "ETH1", method: "eth_getLogs" }, 3)];
        return [];
      },
      async scalar(expr: string) {
        if (expr.startsWith("count({__name__=")) return 1;
        if (expr.includes("retry_attempts_sum")) return 1.5;
        if (expr.includes("latency_milliseconds_count")) return 1600;
        return null;
      },
    } as unknown as PrometheusClient;
  }

  it("adds the cards up from the per-method rows, so they agree on screen", async () => {
    const r = await new MetricsDetailService(retryProm()).retries("1h");
    expect(r).toMatchObject({ emitted: true, retried: 16, recovered: 13, failed: 3, avgExtraAttempts: 1.5 });
    expect(r.recoveryRate).toBeCloseTo(13 / 16);
    expect(r.retryRate).toBeCloseTo(16 / 1600);
  });

  it("every retry expression scopes to the chosen chain", async () => {
    const { prom, queries } = capturingProm();
    // capturingProm answers every presence probe with null ⇒ nothing else is
    // queried; flip the probes on to see the rest.
    (prom as unknown as { scalar: (e: string) => Promise<number | null> }).scalar = async (e: string) => {
      queries.push(e);
      return e.startsWith("count({__name__=") ? 1 : null;
    };
    await new MetricsDetailService(prom).retries("1h", "SOLANA");
    const retryQueries = queries.filter(
      (q) =>
        !q.startsWith("count({__name__=") &&
        (q.includes("smartrouter_retr") || q.includes("latency_milliseconds_count")),
    );
    expect(retryQueries.length).toBe(4);
    expect(retryQueries.every((q) => q.includes('spec="SOLANA"'))).toBe(true);
  });
});

describe("MetricsDetailService error classes (MAG-3847)", () => {
  /**
   * The router books a protocol error on an attempt it also counts in
   * requests_failed_total, so the attempt is already inside total − success.
   * The classes must stay disjoint: transport = failed − protocol.
   */
  function classProm(counts: {
    failed: number;
    protocol: number | null;
    node: number | null;
  }): PrometheusClient {
    const present = (n: number | null) => (n === null ? null : 1);
    return {
      async query() {
        return [];
      },
      async queryRange() {
        return [];
      },
      async scalar(expr: string) {
        if (expr === 'count({__name__="smartrouter_protocol_errors_total"})')
          return present(counts.protocol);
        if (expr === 'count({__name__="smartrouter_node_errors_total"})')
          return present(counts.node);
        // Derived failed attempts: total − success, the transport expression and qErrorCount alike.
        if (expr.startsWith("round(clamp_min(sum(increase(smartrouter_requests_total"))
          return counts.failed;
        if (expr.startsWith("round(sum(increase(smartrouter_protocol_errors_total"))
          return counts.protocol;
        if (expr.startsWith("round(sum(increase(smartrouter_node_errors_total")) return counts.node;
        return null;
      },
      async ping() {
        return true;
      },
    } as unknown as PrometheusClient;
  }
  const ref = { spec: "ETH1", endpointId: "vendor-a" };

  it("N dropped connections and nothing else: N errors, all under protocol (the ticket's done-when)", async () => {
    const service = new MetricsDetailService(classProm({ failed: 7, protocol: 7, node: null }));

    const detail = await service.upstreamDetail(ref, "1d");
    expect(detail.errorSplit).toEqual({ node: 0, protocol: 7, transport: 0 });

    const report = await service.errors("1d", "ETH1");
    expect(report.pivots.category.map((c) => [c.key, c.errors, c.share])).toEqual([
      ["protocol-error", 7, 1],
    ]);
  });

  it("transport keeps the failed attempts the protocol class does not cover", async () => {
    const service = new MetricsDetailService(classProm({ failed: 10, protocol: 4, node: 3 }));

    const detail = await service.upstreamDetail(ref, "1d");
    expect(detail.errorSplit).toEqual({ node: 3, protocol: 4, transport: 6 });

    const report = await service.errors("1d", "ETH1");
    expect(report.total).toBe(10);
    const classes = Object.fromEntries(report.pivots.category.map((c) => [c.key, c.errors]));
    expect(classes).toEqual({ "node-error": 3, "protocol-error": 4, transport: 6 });
    const shares = report.pivots.category.reduce((sum, c) => sum + (c.share ?? 0), 0);
    expect(shares).toBeCloseTo(1, 10);
  });

  it("before the router emits protocol errors, transport is every failed attempt", async () => {
    const service = new MetricsDetailService(classProm({ failed: 5, protocol: null, node: null }));

    expect((await service.upstreamDetail(ref, "1d")).errorSplit).toEqual({
      node: 0,
      protocol: 0,
      transport: 5,
    });
    const report = await service.errors("1d", "ETH1");
    expect(report.pivots.category.map((c) => [c.key, c.errors])).toEqual([["transport", 5]]);
  });

  it("transport never goes negative when increase() extrapolation puts protocol above failed", async () => {
    const service = new MetricsDetailService(classProm({ failed: 6, protocol: 7, node: null }));

    expect((await service.upstreamDetail(ref, "1d")).errorSplit.transport).toBe(0);
    const report = await service.errors("1d", "ETH1");
    expect(report.pivots.category.find((c) => c.key === "transport")).toBeUndefined();
  });
});
