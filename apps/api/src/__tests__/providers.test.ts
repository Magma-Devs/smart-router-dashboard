import { afterEach, describe, expect, it } from "vitest";
import { RECORDED, setRecordedReads } from "@sr/shared";
import { ProvidersService, bucketsRange, countsRange, histogramQuantile, minuteRules, peakWindowSec } from "../services/providers.js";
import { MetricsService } from "../services/metrics.js";
import { StoreReadError, type PrometheusClient, type PromVectorSample } from "../services/prometheus-client.js";

type Row = { metric: Record<string, string>; value: [number, string] };
const v = (metric: Record<string, string>, value: number): Row => ({ metric, value: [1, String(value)] });

/**
 * Fake Prometheus answering by query shape. `present` lists the optional
 * families whose presence probe answers 1; `down` picks the reads the store
 * doesn't answer.
 */
function fakeProm(
  present: string[],
  down?: (q: string) => boolean,
  opts: { holdsHaveChain?: boolean; more?: { tries: Row[]; ok: Row[] } } = {},
): { prom: PrometheusClient; queries: string[] } {
  const queries: string[] = [];
  const answer = (q: string): Row[] => {
    if (q.startsWith("count({__name__=")) {
      const name = /__name__="([^"]+)"/.exec(q)?.[1] ?? "";
      return present.includes(name) ? [v({}, 1)] : [];
    }
    // Whether the hold-offs carry the scrape target's chain label.
    if (q === 'count(smartrouter_rate_limit_holdoffs_total{chain!=""})') {
      return opts.holdsHaveChain !== false && present.includes("smartrouter_rate_limit_holdoffs_total") ? [v({}, 2)] : [];
    }
    if (q.includes("by (provider_address, spec, method)")) return [];
    // The recorded per-provider rates and per-upstream buckets (windows of 3h
    // and up) answer as their raw counterparts do.
    if (q.includes(RECORDED.successByProvider)) return answer("sum by (provider_address, spec) (increase(smartrouter_requests_success_total[1s]))");
    if (q.includes(RECORDED.requestsByProvider)) return answer("sum by (provider_address, spec) (increase(smartrouter_requests_total[1s]))");
    if (q.includes(RECORDED.endpointLatencyBucket)) return answer("rpc_endpoint_end_to_end_latency_milliseconds_bucket");
    // Rate-limited minutes, down minutes, then minutes with traffic, per (node × chain).
    if (q.includes("(sum_over_time(") && q.includes("rate_limit_holdoffs") && !q.includes("clamp_min")) {
      return [v({ provider_address: "blockdaemon", spec: "NEAR" }, 12)];
    }
    if (q.includes("(sum_over_time(")) {
      return [v({ provider_address: "tatum", spec: "ETH1" }, 30), v({ provider_address: "tatum", spec: "SOLANA" }, 0)];
    }
    if (q.includes("(count_over_time(")) {
      return [
        v({ provider_address: "tatum", spec: "ETH1" }, 1440),
        v({ provider_address: "tatum", spec: "SOLANA" }, 1440),
        v({ provider_address: "blockdaemon", spec: "NEAR" }, 600),
      ];
    }
    if (q.startsWith("sum by (provider_address, spec) (increase(smartrouter_requests_total")) {
      return [
        v({ provider_address: "tatum", spec: "ETH1" }, 1000),
        v({ provider_address: "tatum", spec: "SOLANA" }, 500),
        v({ provider_address: "blockdaemon", spec: "NEAR" }, 300),
        v({ provider_address: "blockdaemon-2", spec: "BTCT" }, 100),
        v({ provider_address: "Cached", spec: "ETH1" }, 9999),
        v({ provider_address: "d644d", spec: "XRP" }, 7),
        ...(opts.more?.tries ?? []),
      ];
    }
    if (q.startsWith("sum by (provider_address, spec) (increase(smartrouter_requests_success_total")) {
      return [
        v({ provider_address: "tatum", spec: "ETH1" }, 990),
        v({ provider_address: "tatum", spec: "SOLANA" }, 500),
        v({ provider_address: "blockdaemon", spec: "NEAR" }, 240),
        v({ provider_address: "blockdaemon-2", spec: "BTCT" }, 100),
        ...(opts.more?.ok ?? []),
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

describe("recorded series (windows of 3h and up, while the store has them)", () => {
  afterEach(() => setRecordedReads({ from: null, available: false }));

  it("the list reads tries, successes, peak rate and latency from them - so a week has a p95", async () => {
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    const { prom, queries } = fakeProm(ALL);
    const report = await new ProvidersService(prom, null, new MetricsService(prom)).list("7d");
    expect(queries).toContain(`sum by (provider_address, spec) (sum_over_time(${RECORDED.requestsByProvider}[604800s])) * 60`);
    expect(queries).toContain(`sum by (provider_address, spec) (sum_over_time(${RECORDED.successByProvider}[604800s])) * 60`);
    expect(queries).toContain(`sum by (endpoint_id, spec, le) (sum_over_time(${RECORDED.endpointLatencyBucket}[604800s])) * 60`);
    expect(queries).toContain(`sum by (provider_address) (avg_over_time(${RECORDED.requestsByProvider}[303s]))`);
    // Not the raw counter or histogram, which is what a shared store can't take at a week.
    expect(queries.some((q) => q.includes("increase(smartrouter_requests_total["))).toBe(false);
    expect(queries.some((q) => q.includes("increase(rpc_endpoint_end_to_end_latency_milliseconds_bucket") && q.includes("604800s"))).toBe(false);
    expect(report.latencyRead).toBe(true);
    const tatum = report.providers.find((p) => p.id === "tatum")!;
    expect(tatum.requests).toBe(1500);
    expect(tatum.p95Ms).toBe(500);
  });

  it("an hour stays on the raw counters, exact", async () => {
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    const { prom, queries } = fakeProm(ALL);
    await new ProvidersService(prom, null, new MetricsService(prom)).list("1h");
    expect(queries.some((q) => q.includes(RECORDED.requestsByProvider))).toBe(false);
    expect(queries.some((q) => q.startsWith("sum by (provider_address, spec) (increase(smartrouter_requests_total"))).toBe(true);
  });

  it("a provider's page past a day has chain p95s but says latency per method isn't read", async () => {
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    const { prom, queries } = fakeProm(ALL);
    const detail = await new ProvidersService(prom, null, new MetricsService(prom)).detail("tatum", "7d");
    expect(detail.latencyRead).toBe(true);
    expect(detail.methodLatencyRead).toBe(false);
    expect(detail.chains.find((c) => c.spec === "ETH1")?.p95Ms).toBe(500);
    // No per-method histogram read over a week.
    expect(queries.some((q) => q.includes("function, le") && q.includes("604800s"))).toBe(false);
  });
});

describe("one round", () => {
  // The family probes and the reads go out together: no read waits for the
  // probes to answer (as the HeroPanel's reads, #249).
  it("the list's reads don't wait for the family probes", async () => {
    const { prom } = fakeProm(ALL);
    const p = prom as unknown as { queryOrNull: (q: string) => Promise<unknown> };
    const inner = p.queryOrNull.bind(prom);
    let probeAnswered = false;
    let readsBeforeProbe = 0;
    p.queryOrNull = async (q: string) => {
      if (q.startsWith("count({__name__=") && q.includes("provider_blocked")) {
        await new Promise((r) => setTimeout(r, 40));
        probeAnswered = true;
        return inner(q);
      }
      if (!probeAnswered && q.includes("increase(smartrouter_requests_total")) readsBeforeProbe += 1;
      return inner(q);
    };
    const report = await new ProvidersService(prom, null, new MetricsService(prom)).list("1d");
    expect(readsBeforeProbe).toBeGreaterThan(0);
    expect(report.providers.find((p2) => p2.id === "blockdaemon")?.blockedNow).toBe(true);
  });

  it("a provider's page starts its per-method reads with the rest, on the live node names", async () => {
    const { prom, queries } = fakeProm(ALL);
    const p = prom as unknown as { queryOrNull: (q: string) => Promise<unknown> };
    const inner = p.queryOrNull.bind(prom);
    p.queryOrNull = async (q: string) =>
      q.startsWith("count by (provider_address) (smartrouter_requests_total")
        ? [{ metric: { provider_address: "tatum" }, value: [0, "1"] }]
        : inner(q);
    await new ProvidersService(prom, null, new MetricsService(prom)).detail("tatum", "1d");
    // Once, from the early start: the list named the same node, so no second read.
    expect(queries.filter((q) => q.includes("by (provider_address, spec, method)") && q.includes("smartrouter_requests_total{")).length).toBe(1);
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
      rateLimitByChain: false,
      blocked: false,
      endpointErrored: false,
    });
    // Read in the same round as the probes (they match nothing on such a
    // store); the probes, not the reads, decide what is null.
    expect(queries.some((q) => q.includes("smartrouter_rate_limit_holdoffs_total{event"))).toBe(true);
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

  // The PRD's rule, not the health gauge: an idle or disabled upstream reads
  // 100% on the gauge, because only traffic ever moves it.
  it("uptime: a minute is down when half its tries failed, each chain's minute counting once", async () => {
    const { prom, queries } = fakeProm(ALL);
    const report = await new ProvidersService(prom, null, new MetricsService(prom)).list("1d");
    const tatum = report.providers.find((p) => p.id === "tatum")!;
    // 30 down of 2 × 1,440 chain-minutes.
    expect(tatum.downMinutes).toBe(30);
    expect(tatum.uptime).toBeCloseTo(1 - 30 / 2880);
    expect(report.uptimeRead).toBe(true);
    const down = queries.find((q) => q.includes("(sum_over_time("))!;
    expect(down).toContain(">= bool 0.5)[86400s:1m]");
    // A node that never succeeded has no success series: it reads as zero successes.
    expect(down).toContain('or sum by (provider_address, spec) (increase(smartrouter_requests_total{method!~"grpc[.]reflection[.].*"}[1m])) * 0');
    const detail = await new ProvidersService(prom, null, new MetricsService(prom)).detail("tatum", "1d");
    expect(detail.chains.find((c) => c.spec === "ETH1")).toMatchObject({ downMinutes: 30, trafficMinutes: 1440 });
  });

  // A "too many requests" is often the plan's limit, not the provider failing:
  // it doesn't make a minute down, and it is counted on its own.
  it("rate limits: not counted as down, counted as rate-limited minutes", async () => {
    const { prom, queries } = fakeProm(ALL);
    const svc = new ProvidersService(prom, null, new MetricsService(prom));
    const report = await svc.list("1d");
    expect(report.families.rateLimitByChain).toBe(true);
    const down = queries.find((q) => q.includes("(sum_over_time(") && q.includes("clamp_min"))!;
    // Half or more of the tries that weren't rate-limited failed; nothing but rate limits is 0/0, not down.
    expect(down).toContain("clamp_min(");
    // The hold-offs meet the request counter on (node, chain) and take its spec.
    expect(down).toContain('label_replace(increase(smartrouter_rate_limit_holdoffs_total{event="recorded",chain!=""}[1m]), "provider_address", "$1", "provider", "(.+)")');
    expect(down).toContain("* on (provider_address, chain) group_left");
    const limited = queries.find((q) => q.includes("(sum_over_time(") && q.includes("rate_limit_holdoffs") && !q.includes("clamp_min"))!;
    expect(limited).toContain(">= bool 0.5)[86400s:1m]");
    expect(report.providers.find((p) => p.id === "blockdaemon")?.rateLimitedMinutes).toBe(12);
    expect(report.providers.find((p) => p.id === "tatum")?.rateLimitedMinutes).toBe(0);
    const detail = await svc.detail("blockdaemon", "1d");
    expect(detail.chains.find((c) => c.spec === "NEAR")?.rateLimitedMinutes).toBe(12);
  });

  // The router's own gRPC reflection calls never reach the provider (it
  // refuses to send them), so they can't make a minute down - on the whole
  // deployment and on one provider's graphs alike.
  it("the router's own calls are left out of the down rule", async () => {
    const all = minuteRules("", '{event="recorded",chain!=""}');
    expect(all.tries).toContain('smartrouter_requests_total{method!~"grpc[.]reflection[.].*"}[1m]');
    expect(all.down).toContain('smartrouter_requests_success_total{method!~"grpc[.]reflection[.].*"}[1m]');
    const one = minuteRules('{provider_address=~"tatum"}', null);
    expect(one.down).toContain('smartrouter_requests_total{provider_address=~"tatum",method!~"grpc[.]reflection[.].*"}[1m]');

    const { prom, queries } = fakeProm(ALL);
    await new ProvidersService(prom, null, new MetricsService(prom)).list("1d");
    const down = queries.find((q) => q.includes("(sum_over_time(") && q.includes("clamp_min"))!;
    expect(down).toContain('method!~"grpc[.]reflection[.].*"');
  });

  it("rate limits that can't be put on a chain count as failures, as before - and rate-limited minutes say unknown", async () => {
    const { prom, queries } = fakeProm(ALL, undefined, { holdsHaveChain: false });
    const report = await new ProvidersService(prom, null, new MetricsService(prom)).list("1d");
    expect(report.families.rateLimitByChain).toBe(false);
    // The rate-limited minutes are read in the same round, then dropped.
    expect(queries.some((q) => q.includes("(sum_over_time(") && q.includes("rate_limit_holdoffs") && !q.includes("clamp_min"))).toBe(true);
    expect(report.providers.every((p) => p.rateLimitedMinutes === null)).toBe(true);
    // Uptime still reads, on the old rule.
    expect(report.providers.find((p) => p.id === "tatum")?.downMinutes).toBe(30);
  });

  it("uptime isn't read past a day - it needs every minute", async () => {
    const { prom, queries } = fakeProm(ALL);
    const report = await new ProvidersService(prom, null, new MetricsService(prom)).list("7d");
    expect(queries.some((q) => q.includes("(sum_over_time(") || q.includes("(count_over_time("))).toBe(false);
    expect(report.uptimeRead).toBe(false);
    expect(report.providers.every((p) => p.uptime === null && p.downMinutes === null)).toBe(true);
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

  // Is it the provider, or the chain? Every other company on the chain, together.
  it("each chain row carries the chain's other providers", async () => {
    const { prom } = fakeProm(ALL, undefined, {
      more: {
        tries: [v({ provider_address: "alchemy", spec: "ETH1" }, 200), v({ provider_address: "lava", spec: "ETH1" }, 100)],
        ok: [v({ provider_address: "alchemy", spec: "ETH1" }, 150), v({ provider_address: "lava", spec: "ETH1" }, 100)],
      },
    });
    const detail = await new ProvidersService(prom, null, new MetricsService(prom)).detail("tatum", "1d");
    // Alchemy failed 50 of 200, Lava none of 100: 50 of 300 together.
    expect(detail.chains.find((c) => c.spec === "ETH1")?.others).toEqual({
      providers: 2,
      requests: 300,
      errorRate: 50 / 300,
      nodeErrorRate: 0,
    });
    // Alone on a chain: no others, and no rate to compare with.
    expect(detail.chains.find((c) => c.spec === "SOLANA")?.others).toEqual({
      providers: 0,
      requests: 0,
      errorRate: null,
      nodeErrorRate: null,
    });
  });

  it("a company's second account is not another provider on the chain", async () => {
    const { prom } = fakeProm(ALL, undefined, {
      more: { tries: [v({ provider_address: "blockdaemon-2", spec: "NEAR" }, 50)], ok: [v({ provider_address: "blockdaemon-2", spec: "NEAR" }, 50)] },
    });
    const detail = await new ProvidersService(prom, null, new MetricsService(prom)).detail("blockdaemon", "1d");
    expect(detail.chains.find((c) => c.spec === "NEAR" && c.node === "blockdaemon")?.others.providers).toBe(0);
  });

  it("returns an empty detail for an unknown provider", async () => {
    const { prom } = fakeProm(ALL);
    const detail = await new ProvidersService(prom, null, new MetricsService(prom)).detail("nope", "1d");
    expect(detail.provider).toBeNull();
    expect(detail.chains).toEqual([]);
  });
});

describe("ProvidersService.series", () => {
  // Every chain's bars come back in one read, so a clicked bar can open its report on the chain that failed most.
  it("adds the chains up, and keeps each chain's failures for the bar's report", async () => {
    const queries: string[] = [];
    const prom = {
      async queryOrNull(q: string) {
        queries.push(q);
        if (q.startsWith("count({__name__=")) return q.includes("node_errors") ? [v({}, 1)] : [];
        if (q.startsWith("count by (provider_address)")) return [v({ provider_address: "tatum" }, 1)];
        return [];
      },
      async queryRangeOrNull(q: string) {
        queries.push(q);
        const rows = (eth: [number, string][], sol: [number, string][]) => [
          { metric: { spec: "ETH1" }, values: eth },
          { metric: { spec: "SOLANA" }, values: sol },
        ];
        if (q.startsWith("sum by (spec) (increase(smartrouter_requests_total{")) return rows([[100, "10"], [200, "20"]], [[100, "5"]]);
        if (q.startsWith("sum by (spec) (increase(smartrouter_requests_success_total{")) return rows([[100, "10"], [200, "15"]], [[100, "5"]]);
        if (q.startsWith("sum by (spec) (increase(smartrouter_node_errors_total{")) return [{ metric: { spec: "ETH1" }, values: [[200, "2"]] }];
        return [];
      },
    } as unknown as PrometheusClient;
    const series = await new ProvidersService(prom, null, new MetricsService(prom)).series("tatum", "1d");
    const at = (points: { t: number; v: number | null }[], t: number) => points.find((p) => p.t === t)?.v;
    expect(at(series.tries, 100)).toBe(15);
    expect(at(series.tries, 200)).toBe(20);
    expect(at(series.failed, 200)).toBe(5);
    expect(at(series.errorReplies!, 200)).toBe(2);
    // Solana had nothing go wrong, so only Ethereum is kept: 5 failed + 2 error replies in the second bar.
    expect(series.failuresByChain.map((c) => c.spec)).toEqual(["ETH1"]);
    expect(at(series.failuresByChain[0]!.points, 200)).toBe(7);
    // No hold-off family here: the old down rule, and no rate-limited minutes.
    expect(series.rateLimitedMinutes).toBeNull();
  });
});
