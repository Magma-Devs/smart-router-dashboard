import { describe, expect, it } from "vitest";
import { MetricsDashboardService } from "../services/metrics-dashboard.js";
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

/** A bare, undivided, UNGROUPED rate of the RELAY counter — the throughput bug.
 *
 *  Deliberately narrow on both sides:
 *
 *  - `includes` would be wrong. Availability is
 *    `clamp_max(sum(rate(success_total…)) / sum(rate(requests_total…)), 1)`,
 *    where requests_total is a legitimate denominator — both sides are
 *    relay-scoped, so that ratio is sound.
 *  - Grouped forms (`sum by (spec) (rate(…))`, `sum by (provider_address)
 *    (rate(…))`) do not match, and must not. The client-scoped histogram
 *    carries only {spec, apiInterface, function} — it has NO
 *    `provider_address`, so per-upstream RPS can only come from the relay
 *    counter. Banning the counter outright would break that panel with no
 *    alternative source.
 *
 *  What is left is exactly the defect: a whole-deployment throughput number
 *  taken from a counter that includes the router's own probes. */
const BARE_RELAY_RATE = "sum(rate(smartrouter_requests_total";

describe("MetricsDashboardService query construction (bug regressions)", () => {
  // MAG-2738: the Dashboard page's "RPC Traffic" tile (value, delta and
  // sparkline) read the relay counter, which includes the router's own health
  // probes and one increment per cross-validation participant. Probes never
  // stop, so the tile reported non-zero req/s on a chain nobody was calling,
  // and its delta compared two equally inflated numbers. This service had no
  // tests, the same gap that hid the identical defect in MAG-2737.
  it("throughput KPI and series are CLIENT-scoped (MAG-2738)", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsDashboardService(prom).dashboard("1d", "ETH1");

    const client = queries.filter((q) =>
      q.startsWith('sum(rate(smartrouter_end_to_end_latency_milliseconds_count{spec="ETH1"}'),
    );
    // Three: the KPI value, its prior-window offset, and the series.
    expect(client.length).toBeGreaterThanOrEqual(3);
    expect(client.some((q) => q.includes("offset"))).toBe(true);

    expect(queries.every((q) => !q.startsWith(BARE_RELAY_RATE))).toBe(true);
  });

  it("availability keeps the relay counter as a ratio denominator", async () => {
    const { prom, queries } = capturingProm();
    await new MetricsDashboardService(prom).dashboard("1d", "ETH1");
    // Guards the fix above from being "tidied" into banning the counter
    // outright: success ÷ total is relay-scoped on both sides and correct.
    expect(
      queries.some(
        (q) => q.includes("smartrouter_requests_total") && !q.startsWith(BARE_RELAY_RATE),
      ),
    ).toBe(true);
  });
});
