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
