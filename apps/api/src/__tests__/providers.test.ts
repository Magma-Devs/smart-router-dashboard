import { describe, expect, it } from "vitest";
import { ProvidersService, bucketsRange, countsRange, histogramQuantile, peakWindowSec } from "../services/providers.js";
import { MetricsService } from "../services/metrics.js";
import { StoreReadError, type PrometheusClient, type PromVectorSample } from "../services/prometheus-client.js";

type Row = { metric: Record<string, string>; value: [number, string] };
const v = (metric: Record<string, string>, value: number): Row => ({ metric, value: [1, String(value)] });

/**
 * Fake Prometheus answering by query shape. `present` lists the optional
 * families whose presence probe answers 1; `down` picks the reads the store
 * doesn't answer.
 */
function fakeProm(present: string[], down?: (q: string) => boolean): { prom: PrometheusClient; queries: string[] } {
  const queries: string[] = [];
  const answer = (q: string): Row[] => {
    if (q.startsWith("count({__name__=")) {
      const name = /__name__="([^"]+)"/.exec(q)?.[1] ?? "";
      return present.includes(name) ? [v({}, 1)] : [];
    }
    if (q.includes("by (provider_address, spec, method)")) return [];
    if (q.startsWith("sum by (provider_address, spec) (increase(smartrouter_requests_total")) {
      return [
        v({ provider_address: "tatum", spec: "ETH1" }, 1000),
        v({ provider_address: "tatum", spec: "SOLANA" }, 500),
        v({ provider_address: "blockdaemon", spec: "NEAR" }, 300),
        v({ provider_address: "blockdaemon-2", spec: "BTCT" }, 100),
        v({ provider_address: "Cached", spec: "ETH1" }, 9999),
        v({ provider_address: "d644d", spec: "XRP" }, 7),
      ];
    }
    if (q.startsWith("sum by (provider_address, spec) (increase(smartrouter_requests_success_total")) {
      return [
        v({ provider_address: "tatum", spec: "ETH1" }, 990),
        v({ provider_address: "tatum", spec: "SOLANA" }, 500),
        v({ provider_address: "blockdaemon", spec: "NEAR" }, 240),
        v({ provider_address: "blockdaemon-2", spec: "BTCT" }, 100),
      ];
    }
    if (q.startsWith("sum by (provider_address, spec) (increase(smartrouter_node_errors_total")) {
      return [v({ provider_address: "tatum", spec: "ETH1" }, 50)];
    }
    if (q.includes("smartrouter_rate_limit_holdoffs_total")) {
      return [
        v({ provider: "blockdaemon", chain: "near" }, 40),
        v({ provider: "blockdaemon-2", chain: "btct" }, 2),
      ];
    }
    if (q.includes("smartrouter_csm_provider_blocked")) {
      return [v({ provider_address: "blockdaemon", spec: "NEAR" }, 1)];
    }
    if (q.includes("avg_over_time(rpc_endpoint_overall_health")) {
      return [
        v({ endpoint_id: "tatum", spec: "ETH1" }, 1),
        v({ endpoint_id: "tatum", spec: "SOLANA" }, 0.5),
        v({ endpoint_id: "blockdaemon", spec: "NEAR" }, 1),
      ];
    }
    if (q.includes("rpc_endpoint_end_to_end_latency_milliseconds_bucket")) {
      const rows: Row[] = [];
      for (const [le, c] of [["100", 50], ["500", 90], ["+Inf", 100]] as const) {
        rows.push(v({ endpoint_id: "tatum", spec: "ETH1", le }, c));
      }
      return rows;
    }
    return [];
  };
  const prom = {
    async query(q: string) {
      queries.push(q);
      return answer(q) as PromVectorSample[];
    },
    async queryOrNull(q: string) {
      queries.push(q);
      return down?.(q) ? null : (answer(q) as PromVectorSample[]);
    },
    async queryRangeOrNull(q: string) {
      queries.push(q);
      if (down?.(q)) return null;
      return [
        { metric: { provider_address: "blockdaemon" }, values: [[1, "10"], [2, "30"]] },
        { metric: { provider_address: "blockdaemon-2" }, values: [[1, "5"], [2, "5"]] },
      ];
    },
    // The upstream roster (block lag) reads through the client's forgiving calls.
    async scalar() {
      return null;
    },
    async queryRange() {
      return [];
    },
  } as unknown as PrometheusClient;
  return { prom, queries };
}

const ALL = [
  "smartrouter_node_errors_total",
  "smartrouter_rate_limit_holdoffs_total",
  "smartrouter_csm_provider_blocked",
];

describe("histogramQuantile", () => {
  it("interpolates like Prometheus", () => {
    const b = new Map([[100, 50], [500, 90], [Infinity, 100]]);
    expect(histogramQuantile(0.5, b)).toBe(100);
    expect(histogramQuantile(0.7, b)).toBe(300);
    expect(histogramQuantile(0.95, b)).toBe(500);
  });
  it("is null with no observations", () => {
    expect(histogramQuantile(0.95, new Map())).toBeNull();
  });
});

// A week of raw samples for every series is more than a shared store answers
// in time, so a long window samples the series instead.
describe("long windows are read lightly", () => {
  it("counters: every scrape up to a day, then a sample every few minutes", () => {
    expect(countsRange(1800)).toBe("1800s");
    expect(countsRange(86_400)).toBe("86400s");
    expect(countsRange(7 * 86_400)).toBe("604800s:900s");
    expect(countsRange(30 * 86_400)).toBe("2592000s:3840s");
  });
  it("histogram buckets - thousands of series - are sampled sooner and wider", () => {
    expect(bucketsRange(10_800)).toBe("10800s");
    expect(bucketsRange(86_400)).toBe("86400s:900s");
    expect(bucketsRange(7 * 86_400)).toBe("604800s:6300s");
  });
  it("the peak rate averages 5 minutes until the window's step is longer, so no stretch goes unread", () => {
    expect(peakWindowSec("1d")).toBe(300);
    expect(peakWindowSec("30d")).toBe(1296);
  });
  it("the list's queries carry them", async () => {
    const { prom, queries } = fakeProm(ALL);
    const report = await new ProvidersService(prom, null, new MetricsService(prom)).list("7d");
    expect(queries).toContain("sum by (provider_address, spec) (increase(smartrouter_requests_total[604800s:900s]))");
    expect(queries).toContain("sum by (provider_address) (rate(smartrouter_requests_total[303s]))");
    expect(report.peakWindowSec).toBe(303);
  });
  // One series per upstream × chain × method × bucket: over a week this read
  // ran a shared store out of time. It is not sent; the p95s say they weren't read.
  it("latency is not read past a day - null and said so, never the heavy read", async () => {
    const week = fakeProm(ALL);
    const svc = new ProvidersService(week.prom, null, new MetricsService(week.prom));
    const report = await svc.list("7d");
    const detail = await svc.detail("tatum", "7d");
    // The only histogram read left is the roster's, over five minutes, for block lag.
    const histogramReads = week.queries.filter((q) => q.includes("latency_milliseconds_bucket"));
    expect(histogramReads.every((q) => q.includes("[300s]"))).toBe(true);
    expect(week.queries.some((q) => q.includes("604800s") && q.includes("_bucket"))).toBe(false);
    expect(report.latencyRead).toBe(false);
    expect(report.providers.every((p) => p.p95Ms === null)).toBe(true);
    expect(detail.latencyRead).toBe(false);

    const day = fakeProm(ALL);
    const dayReport = await new ProvidersService(day.prom, null, new MetricsService(day.prom)).list("1d");
    expect(day.queries.some((q) => q.includes("rpc_endpoint_end_to_end_latency_milliseconds_bucket[86400s:900s]"))).toBe(true);
    expect(dayReport.latencyRead).toBe(true);
  });
});

describe("ProvidersService.list", () => {
  it("groups node names by company and keeps cache and junk labels out", async () => {
    const { prom } = fakeProm(ALL);
    const report = await new ProvidersService(prom, null, new MetricsService(prom)).list("1d");
    const ids = report.providers.map((p) => p.id).sort();
    expect(ids).toEqual(["blockdaemon", "tatum"]);
    const bd = report.providers.find((p) => p.id === "blockdaemon")!;
    expect(bd.requests).toBe(400);
    expect(bd.accounts).toEqual(["1", "2"]);
    expect(bd.nodes).toEqual(["blockdaemon", "blockdaemon-2"]);
    expect(bd.errorRate).toBeCloseTo(60 / 400);
    expect(bd.rateLimitHits).toBe(42);
    expect(bd.blockedNow).toBe(true);
    // Peak sums the two accounts per timestamp: max(10+5, 30+5).
    expect(bd.peakRps).toBe(35);
    expect(report.unattributed).toEqual({ requests: 7, labels: ["d644d"] });
  });

  it("puts blocked providers first", async () => {
    const { prom } = fakeProm(ALL);
    const report = await new ProvidersService(prom, null, new MetricsService(prom)).list("1d");
    expect(report.providers[0]!.id).toBe("blockdaemon");
  });

  it("returns null, not zero, for families the router doesn't emit", async () => {
    const { prom, queries } = fakeProm([]);
    const report = await new ProvidersService(prom, null, new MetricsService(prom)).list("1d");
    const tatum = report.providers.find((p) => p.id === "tatum")!;
    expect(tatum.rateLimitHits).toBeNull();
    expect(tatum.blockedNow).toBeNull();
    expect(tatum.nodeErrorRate).toBeNull();
    expect(tatum.protocolErrorRate).toBeNull();
    expect(report.families).toEqual({
      nodeErrors: false,
      protocolErrors: false,
      rateLimit: false,
      blocked: false,
      endpointErrored: false,
    });
    expect(queries.some((q) => q.includes("smartrouter_rate_limit_holdoffs_total{event"))).toBe(false);
  });

  // The shared client turns a refused call into "no series". Here that would
  // read as a provider with every try failed, so the read fails instead.
  it("a read the store doesn't answer fails the response - never a 100% error rate or 'not emitted'", async () => {
    const okCounts = (q: string) => q.includes("smartrouter_requests_success_total");
    const { prom } = fakeProm(ALL, okCounts);
    await expect(new ProvidersService(prom, null, new MetricsService(prom), []).list("1d")).rejects.toBeInstanceOf(StoreReadError);

    const probe = (q: string) => q.startsWith("count({__name__=") && q.includes("rate_limit_holdoffs");
    const probed = fakeProm(ALL, probe);
    await expect(new ProvidersService(probed.prom, null, new MetricsService(probed.prom), []).list("1d")).rejects.toBeInstanceOf(StoreReadError);
  });

  it("at most four reads are out at once", async () => {
    let out = 0;
    let most = 0;
    const { prom } = fakeProm(ALL);
    const slow = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
      most = Math.max(most, ++out);
      await new Promise((r) => setTimeout(r, 2));
      out -= 1;
      return fn(...a);
    };
    const p = prom as unknown as { queryOrNull: (q: string) => Promise<unknown>; queryRangeOrNull: (q: string) => Promise<unknown> };
    p.queryOrNull = slow(p.queryOrNull);
    p.queryRangeOrNull = slow(p.queryRangeOrNull);
    await new ProvidersService(prom, null, new MetricsService(prom)).list("1d");
    expect(most).toBe(4);
  });

  it("tries a refused read again before giving up", async () => {
    let refusals = 2;
    const { prom } = fakeProm(ALL, (q) => q.includes("smartrouter_requests_success_total") && refusals-- > 0);
    const report = await new ProvidersService(prom, null, new MetricsService(prom), [1, 1]).list("1d");
    expect(report.providers.find((p) => p.id === "tatum")?.errorRate).toBeCloseTo(10 / 1500);
  });
});

describe("ProvidersService.detail", () => {
  it("chain requests add up to the provider total", async () => {
    const { prom } = fakeProm(ALL);
    const svc = new ProvidersService(prom, null, new MetricsService(prom));
    const detail = await svc.detail("tatum", "1d");
    expect(detail.provider?.requests).toBe(1500);
    expect(detail.chains.reduce((a, c) => a + c.requests, 0)).toBe(1500);
    const eth = detail.chains.find((c) => c.spec === "ETH1")!;
    expect(eth.p95Ms).toBe(500);
    expect(eth.share).toBeCloseTo(1000 / 1000);
  });

  it("maps hold-offs to a chain through the chain label", async () => {
    const { prom } = fakeProm(ALL);
    const detail = await new ProvidersService(prom, null, new MetricsService(prom)).detail("blockdaemon", "1d");
    expect(detail.chains.find((c) => c.spec === "NEAR")?.rateLimitHits).toBe(40);
    expect(detail.chains.find((c) => c.spec === "BTCT")?.rateLimitHits).toBe(2);
  });

  it("returns an empty detail for an unknown provider", async () => {
    const { prom } = fakeProm(ALL);
    const detail = await new ProvidersService(prom, null, new MetricsService(prom)).detail("nope", "1d");
    expect(detail.provider).toBeNull();
    expect(detail.chains).toEqual([]);
  });
});
