import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { metricRoutes } from "../routes/metrics.js";
import { MetricsService } from "../services/metrics.js";
import type { ConfigurationService } from "../services/configuration.js";
import {
  SINCE_LOOKBACK_SEC, healthWindowSeconds, providersNeedingAttention, readHealthSince, readUpstreamHealth, type UpstreamHealth,
} from "../services/upstream-health.js";
import type { PrometheusClient, PromVectorSample } from "../services/prometheus-client.js";

// For a gauge row the value is the blocked gauge: "1" blocked, "0" serving.
const sample = (value: string, spec = "ETH1", apiInterface = "jsonrpc"): PromVectorSample => ({
  metric: { endpoint_id: "test-upstream", spec, apiInterface },
  value: [1, value],
});

async function roster(healthRows: PromVectorSample[], total = 1_000_000, ok = 999_999) {
  const prom = {
    query: async (q: string) => {
      if (q.startsWith("label_replace(smartrouter_csm_provider_blocked")) return healthRows;
      // Every upstream the router routes to also answers its block polls here.
      if (q.includes("rpc_endpoint_fetch_latest_success"))
        return healthRows
          .filter((row) => row.value[1] === "0")
          .map((row) => ({ ...row, value: [row.value[0], "1"] as [number, string] }));
      if (q.includes("smartrouter_requests_success_total"))
        return [
          { metric: { provider_address: "test-upstream", spec: "ETH1" }, value: [1, String(ok)] },
        ];
      if (q.includes("smartrouter_requests_total"))
        return [
          {
            metric: { provider_address: "test-upstream", spec: "ETH1" },
            value: [1, String(total)],
          },
        ];
      return [];
    },
  } as unknown as PrometheusClient;
  const metrics = new MetricsService(prom);
  const app = Fastify();
  app.decorate("scoped", () => ({ metrics }));
  await app.register(metricRoutes);
  try {
    const response = await app.inject({ method: "GET", url: "/api/metrics/upstreams?window=1d" });
    expect(response.statusCode).toBe(200);
    return response.json().upstreams;
  } finally {
    await app.close();
  }
}

describe("MAG-4226: upstream health through the HTTP route", () => {
  it("keeps current unhealthiness separate from nearly 100% successful past traffic", async () => {
    const [row] = await roster([sample("1")]);
    expect(row.health).toBe("unhealthy");
    expect(row.uptime).toBe(0.999999);
  });

  it("does not manufacture success rate when no requests were sent", async () => {
    const [row] = await roster([sample("1")], 0, 0);
    expect(row.health).toBe("unhealthy");
    expect(row.uptime).toBeNull();
  });

  it.each([false, true])(
    "uses the worst interface health independent of result order (reversed=%s)",
    async (reverse) => {
      const rows = [sample("1", "ETH1", "rest"), sample("0"), sample("0", "SOLANA")];
      const result = await roster(reverse ? rows.reverse() : rows);
      expect(result.find((row: { spec: string }) => row.spec === "ETH1").health).toBe("unhealthy");
      expect(result.find((row: { spec: string }) => row.spec === "SOLANA").health).toBe(
        "operational",
      );
    },
  );

  it("does not interpret a non-finite health sample as a measurement", async () => {
    const [row] = await roster([sample("NaN")]);
    expect(row.health).toBe("unknown");
  });

  it.each([false, true])(
    "does not let a healthy interface mask an unknown interface (reversed=%s)",
    async (reverse) => {
      const samples = [sample("NaN", "ETH1", "rest"), sample("0")];
      const [row] = await roster(reverse ? samples.reverse() : samples);
      expect(row.health).toBe("unknown");
    },
  );
});

const configured = {
  getRouters: () => [
    {
      id: "eth-prod",
      spec: "ETH1",
      nodes: [
        { name: "test-upstream", endpoints: [{ interface: "jsonrpc" }] },
        { name: "missing", endpoints: [{ interface: "jsonrpc" }] },
      ],
    },
    {
      id: "eth-staging",
      spec: "ETH1",
      nodes: [{ name: "staging", endpoints: [{ interface: "jsonrpc" }] }],
    },
    {
      id: "sol",
      spec: "SOLANA",
      nodes: [{ name: "test-upstream", endpoints: [{ interface: "jsonrpc" }] }],
    },
  ],
} as unknown as ConfigurationService;

function healthProm(
  gauges: PromVectorSample[],
  ok: PromVectorSample[] = [],
  failed: PromVectorSample[] = [],
  rates: PromVectorSample[] = [],
  tracking: PromVectorSample[] = [],
) {
  const queries: string[] = [];
  const prom = {
    query: async (q: string) => {
      queries.push(q);
      if (q.startsWith("label_replace(smartrouter_csm_provider_blocked")) return gauges;
      if (q.includes("rpc_endpoint_url_block_tracking")) return tracking;
      if (q.includes("rpc_endpoint_fetch_latest_success")) return ok;
      if (q.includes("rpc_endpoint_fetch_latest_fails")) return failed;
      if (q.includes("deriv(")) return rates;
      return [];
    },
    scalar: async () => 1,
    queryRange: async () => [],
  } as unknown as PrometheusClient;
  return { prom, queries };
}

async function healthHttp(
  gauges: PromVectorSample[],
  ok: PromVectorSample[],
  failed: PromVectorSample[],
  params = "",
) {
  const { prom } = healthProm(gauges, ok, failed);
  const metrics = new MetricsService(prom, configured);
  const app = Fastify();
  app.decorate("scoped", () => ({ metrics }));
  await app.register(metricRoutes);
  try {
    const roster = await app.inject(`/api/metrics/upstreams?window=7d${params}`);
    // The topbar's counts: no window, the same filters as the roster.
    const pulse = await app.inject(`/api/metrics/pulse${params.replace(/^&/, "?")}`);
    expect(roster.statusCode).toBe(200);
    expect(pulse.statusCode).toBe(200);
    return {
      rows: roster.json().upstreams as import("@sr/shared").UpstreamMetrics[],
      pulse: pulse.json() as import("@sr/shared").DeploymentPulse,
    };
  } finally {
    await app.close();
  }
}

describe("MAG-4226 review: configured upstream liveness", () => {
  it("keeps every configured endpoint visible with a reason before the first scrape", async () => {
    const { rows, pulse } = await healthHttp([], [], []);
    expect(rows).toHaveLength(4);
    expect(
      rows.every(
        (row) => row.health === "unknown" && row.healthReason?.includes("No data yet") && row.healthCause === "no-data",
      ),
    ).toBe(true);
    expect(pulse.upstreamHealthCounts).toEqual({ unhealthy: 0, unknown: 4 });
  });

  it("failed recent block polls override a provider the router still routes to, with no traffic", async () => {
    const { rows, pulse } = await healthHttp(
      [sample("0")],
      [],
      [sample("2")],
      "&routerId=eth-prod",
    );
    const row = rows.find((row) => row.endpointId === "test-upstream")!;
    expect(row.health).toBe("unhealthy");
    expect(row.healthReason).toContain("Every block check failed");
    expect(row.healthCause).toBe("checks-failing");
    expect(row.requests).toBe(0);
    expect(row.uptime).toBeNull();
    expect(rows).toHaveLength(2);
    expect(pulse.upstreamHealthCounts).toEqual({ unhealthy: 1, unknown: 1 });
  });

  it("does not label zero polls as failure, and positive successes establish health", async () => {
    const { prom } = healthProm([], [sample("0")], [sample("0")]);
    expect([...(await readUpstreamHealth(prom))].map(([, row]) => row.health)).toEqual(["unknown"]);
    const recovered = healthProm([], [sample("1")], [sample("0")]);
    expect([...(await readUpstreamHealth(recovered.prom))].map(([, row]) => row.health)).toEqual([
      "operational",
    ]);
  });

  it("mixed poll results do not override a provider in rotation", async () => {
    const { prom } = healthProm([sample("0")], [sample("1")], [sample("2")]);
    expect([...(await readUpstreamHealth(prom))].map(([, row]) => row.health)).toEqual([
      "operational",
    ]);
  });

  it("successful polls never override a blocked provider", async () => {
    const { prom } = healthProm([sample("1")], [sample("4")]);
    expect([...(await readUpstreamHealth(prom))].map(([, row]) => row.health)).toEqual([
      "unhealthy",
    ]);
  });

  it.each([false, true])(
    "does not let another interface's successful polls mask failures (reverse=%s)",
    async (reverse) => {
      const gauges = [sample("0"), sample("0", "ETH1", "rest")];
      const { prom } = healthProm(
        reverse ? gauges.reverse() : gauges,
        [sample("3")],
        [sample("0.2", "ETH1", "rest")],
      );
      expect([...(await readUpstreamHealth(prom))].map(([, row]) => row.health)).toEqual([
        "unhealthy",
      ]);
    },
  );

  it("does not let another scrape target's successes mask a failed replica", async () => {
    const replica = (value: string, instance: string) => ({
      ...sample(value),
      metric: { ...sample(value).metric, instance },
    });
    const { prom } = healthProm(
      [replica("0", "a"), replica("0", "b")],
      [replica("3", "a")],
      [replica("2", "b")],
    );
    expect([...(await readUpstreamHealth(prom))].map(([, row]) => row.health)).toEqual([
      "unhealthy",
    ]);
  });

  it("does not hide an unmeasured configured interface behind a healthy one", async () => {
    const config = {
      getRouters: () => [
        {
          id: "eth",
          spec: "ETH1",
          nodes: [
            { name: "test-upstream", endpoints: [{ interface: "jsonrpc" }, { interface: "rest" }] },
          ],
        },
      ],
    } as unknown as ConfigurationService;
    const { prom } = healthProm([sample("0")], [sample("1")]);
    const row = [...(await readUpstreamHealth(prom, config))][0][1];
    expect(row.health).toBe("unknown");
    expect(row.healthReason).toContain("its rest endpoint");
  });

  it("isolates the same vendor name on different chains and filters both counts and rows", async () => {
    const { rows, pulse } = await healthHttp(
      [sample("1"), sample("0", "SOLANA")],
      [sample("1", "SOLANA")],
      [],
      "&spec=SOLANA&routerId=sol",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].spec).toBe("SOLANA");
    expect(rows[0].health).toBe("operational");
    expect(pulse.upstreamHealthCounts).toEqual({ unhealthy: 0, unknown: 0 });
  });

  it("uses five bounded current-health queries, without traffic, QoS or histograms", async () => {
    const { prom, queries } = healthProm([sample("0")]);
    await readUpstreamHealth(prom, configured);
    expect(queries).toHaveLength(5);
    expect(queries.every((q) => !/histogram|selection_score|requests_total/.test(q))).toBe(true);
    expect(queries.filter((q) => q.includes("increase(")).every((q) => q.includes("[1800s]"))).toBe(
      true,
    );
  });
});

describe("an unhealthy provider through the HTTP routes", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("the roster row carries the cause and since when, and the pulse lists the providers behind its counts", async () => {
    // Only the clock: the routes' own timers run as they are.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T12:00:20Z"));
    const end = Math.floor(Date.now() / 1000 / 60) * 60;
    const { prom } = healthProm([sample("1")]);
    const ranges: string[] = [];
    // Blocked for the last 30 minutes of the day read.
    (prom as unknown as { queryRangeOrNull: PrometheusClient["queryRangeOrNull"] }).queryRangeOrNull = async (q: string) => {
      ranges.push(q);
      return [{ metric: { provider_address: "test-upstream", spec: "ETH1" }, values: Array.from({ length: 121 }, (_, k) => [end - (120 - k) * 60, k >= 90 ? "1" : "0"] as [number, string]) }];
    };
    const metrics = new MetricsService(prom, configured);
    const app = Fastify();
    app.decorate("scoped", () => ({ metrics }));
    await app.register(metricRoutes);
    try {
      const rows = (await app.inject("/api/metrics/upstreams?window=5m&routerId=eth-prod")).json().upstreams as import("@sr/shared").UpstreamMetrics[];
      const pulse = (await app.inject("/api/metrics/pulse?routerId=eth-prod")).json() as import("@sr/shared").DeploymentPulse;
      const since = end - 30 * 60;
      const reason = "The router stopped sending it requests: none of its URLs is answering.";
      expect(rows.find((r) => r.endpointId === "test-upstream")).toMatchObject({
        health: "unhealthy", healthCause: "blocked", healthReason: reason, healthSince: since, healthSinceOrEarlier: false,
      });
      expect(rows.find((r) => r.endpointId === "missing")).toMatchObject({ health: "unknown", healthCause: "no-data", healthSince: null, healthSinceOrEarlier: false });
      expect(pulse.upstreamHealthCounts).toEqual({ unhealthy: 1, unknown: 1 });
      expect(pulse.attention).toEqual([
        { endpointId: "test-upstream", spec: "ETH1", health: "unhealthy", cause: "blocked", reason, since, sinceOrEarlier: false },
        { endpointId: "missing", spec: "ETH1", health: "unknown", cause: "no-data", reason: expect.stringContaining("No data yet"), since: null, sinceOrEarlier: false },
      ]);
      // One range read each, for the blocked provider's name only.
      expect(ranges).toEqual(Array(2).fill('max by (provider_address, spec) (smartrouter_csm_provider_blocked{provider_address=~"test-upstream"})'));
    } finally {
      await app.close();
    }
  });
});

describe("MAG-4226 slow-chain windows", () => {
  it.each([
    [1 / 12, 300],
    [1 / 200, 900],
    [1 / 600, 1800],
    [1 / 1200, 3600],
    [1 / 10000, 3600],
    [0, 1800],
    [-1, 1800],
    [NaN, 1800],
    [Infinity, 1800],
    [undefined, 1800],
  ])("sizes a bounded window for rate %s", (rate, expected) => {
    expect(healthWindowSeconds(rate)).toBe(expected);
  });

  it("groups chains into two poll requests and keeps unrated chains in the fallback", async () => {
    const { prom, queries } = healthProm(
      [],
      [],
      [],
      [
        sample(String(1 / 12)),
        sample(String(1 / 600), "BTC"),
        sample(String(1 / 1200), "SLOW"),
        sample(String(1 / 12), "A.B"),
      ],
    );
    await readUpstreamHealth(prom);
    expect(queries).toHaveLength(5);
    const polls = queries.filter((q) => q.includes("increase("));
    for (const q of polls) {
      expect(q).toContain("[300s]");
      expect(q).toContain("[1800s]");
      expect(q).toContain("[3600s]");
      expect(q).toContain("spec!~");
      expect(q).toContain("A\\\\.B");
      expect(q).not.toContain("endpoint_id=");
    }
  });

  it.each(["BTC", "BTCT", "BCHT"])(
    "uses thirty minutes for %s in both HTTP counts and rows",
    async (spec) => {
      const { prom, queries } = healthProm(
        [sample("0", spec)],
        [],
        [sample("1", spec)],
        [sample(String(1 / 600), spec)],
      );
      const config = {
        getRouters: () => [
          {
            id: "slow",
            spec,
            nodes: [{ name: "test-upstream", endpoints: [{ interface: "jsonrpc" }] }],
          },
        ],
      } as unknown as ConfigurationService;
      const metrics = new MetricsService(prom, config);
      const app = Fastify();
      app.decorate("scoped", () => ({ metrics }));
      await app.register(metricRoutes);
      try {
        const rows = (
          await app.inject(`/api/metrics/upstreams?spec=${spec}&routerId=slow&window=5m`)
        ).json().upstreams;
        const pulse = (await app.inject(`/api/metrics/pulse?spec=${spec}&routerId=slow`)).json();
        expect(rows[0].health).toBe("unhealthy");
        expect(rows[0].healthReason).toContain("30 minutes");
        expect(pulse.upstreamHealthCounts).toEqual({ unhealthy: 1, unknown: 0 });
        expect(
          queries.find(
            (q) => q.includes("rpc_endpoint_fetch_latest_fails") && q.includes("apiInterface"),
          ),
        ).toContain("[1800s]");
      } finally {
        await app.close();
      }
    },
  );

  it("does not let an empty or expired poll window turn a provider in rotation green", async () => {
    const { prom } = healthProm(
      [sample("0", "BTC")],
      [sample("0", "BTC")],
      [sample("0", "BTC")],
      [sample("0", "BTC")],
    );
    const row = [...(await readUpstreamHealth(prom))][0][1];
    expect(row.health).toBe("unknown");
    expect(row.healthReason).toContain("nothing confirms it is working");
    expect(row.healthCause).toBe("no-checks");
    expect(row.healthReason).toContain("30 minutes");
  });

  it("requires positive success evidence to show a provider in rotation operational", async () => {
    const { prom } = healthProm(
      [sample("0", "BTC")],
      [sample("1", "BTC")],
      [sample("2", "BTC")],
      [sample(String(1 / 600), "BTC")],
    );
    expect([...(await readUpstreamHealth(prom))][0][1].health).toBe("operational");
  });
});

// A provider whose every url serves only add-on methods with no way to read a
// block height (a service that only accepts transactions) is not polled, by
// design. The router says so on rpc_endpoint_url_block_tracking (0), and the
// row must read that, not "Unknown": nothing is missing.
describe("MAG-5349: a provider the router does not track by design", () => {
  const health = async (...args: Parameters<typeof healthProm>) =>
    [...(await readUpstreamHealth(healthProm(...args).prom))].map(([, row]) => row);

  it("reads untracked, not unknown, when in rotation with no polls", async () => {
    const [row] = await health([sample("0")], [], [], [], [sample("0")]);
    expect(row.health).toBe("untracked");
    expect(row.healthReason).toContain("Not tracked by design");
  });

  it("is unknown without the series: an older router, or polls really missing", async () => {
    const [row] = await health([sample("0")]);
    expect(row.health).toBe("unknown");
  });

  it("a tracked provider with no poll outcome is still unknown", async () => {
    const [row] = await health([sample("0")], [], [], [], [sample("1")]);
    expect(row.health).toBe("unknown");
  });

  it("a blocked provider is unhealthy whether tracked or not", async () => {
    const [row] = await health([sample("1")], [], [], [], [sample("0")]);
    expect(row.health).toBe("unhealthy");
  });

  it("failed polls still win: an older pod of the fleet may still poll it", async () => {
    const [row] = await health([sample("0")], [], [sample("3")], [], [sample("0")]);
    expect(row.health).toBe("unhealthy");
  });

  it("asks for the highest value per provider, so one tracked url is enough to judge it by polls", async () => {
    const { prom, queries } = healthProm([sample("0")]);
    await readUpstreamHealth(prom, undefined, "ETH1");
    expect(queries).toContain(
      'max by (endpoint_id, spec, apiInterface, instance) (rpc_endpoint_url_block_tracking{spec="ETH1"})',
    );
  });

  it.each([false, true])(
    "an interface judged by its polls decides the row (reverse=%s)",
    async (reverse) => {
      const order = (rows: PromVectorSample[]) => (reverse ? [...rows].reverse() : rows);
      const gauges = order([sample("0"), sample("0", "ETH1", "rest")]);
      const [working] = await health(gauges, [sample("2", "ETH1", "rest")], [], [], [sample("0")]);
      expect(working.health).toBe("operational");
      expect(working.healthReason).toContain("Block checks passed");
      const [failing] = await health(gauges, [], [sample("2", "ETH1", "rest")], [], [sample("0")]);
      expect(failing.health).toBe("unhealthy");
      const [gap] = await health(gauges, [], [], [], [sample("0")]);
      expect(gap.health).toBe("unknown");
    },
  );

  it("reads untracked when every interface is untracked", async () => {
    const rows = await health(
      [sample("0"), sample("0", "ETH1", "rest")],
      [],
      [],
      [],
      [sample("0"), sample("0", "ETH1", "rest")],
    );
    expect(rows.map((row) => row.health)).toEqual(["untracked"]);
  });

  it("is not listed among the providers to check: by design is nothing to act on", async () => {
    const rows = await readUpstreamHealth(healthProm([sample("0")], [], [], [], [sample("0")]).prom);
    expect([...rows.values()].map((row) => [row.health, row.healthCause])).toEqual([["untracked", "untracked"]]);
    expect(providersNeedingAttention(rows)).toEqual([]);
  });

  it("is not counted as a provider with no health data", async () => {
    const { prom } = healthProm([sample("0")], [], [], [], [sample("0")]);
    const pulse = await new MetricsService(prom).pulse();
    expect(pulse.upstreamHealthCounts).toEqual({ unhealthy: 0, unknown: 0 });
  });
});

describe("since when an unhealthy provider has been unhealthy", () => {
  const NOW = 1_800_000_000; // a multiple of 60 s
  const JSONRPC = { apiInterface: "jsonrpc", instance: "" };
  const row = (endpointId: string, cause: UpstreamHealth["healthCause"], health: UpstreamHealth["health"] = "unhealthy", failingChecks = cause === "checks-failing" ? [JSONRPC] : []): UpstreamHealth =>
    ({ endpointId, spec: "ETH1", health, healthCause: cause, healthReason: "why", healthSince: null, healthSinceOrEarlier: false, failingChecks, routerIds: [] });
  const rowsOf = (...list: UpstreamHealth[]) => new Map(list.map((r) => [`${r.endpointId}|${r.spec}`, r]));
  /** A value per minute over the day read, oldest first. */
  const minutes = (v: (minutesAgo: number) => string) =>
    Array.from({ length: SINCE_LOOKBACK_SEC / 60 + 1 }, (_, k) => [NOW - SINCE_LOOKBACK_SEC + k * 60, v(SINCE_LOOKBACK_SEC / 60 - k)] as [number, string]);
  const client = (answer: (q: string) => unknown) => {
    const reads: string[] = [];
    const prom = { queryRangeOrNull: async (q: string) => { reads.push(q); return answer(q); } } as unknown as PrometheusClient;
    return { prom, reads };
  };

  it("reads nothing while every provider is fine", async () => {
    const { prom, reads } = client(() => []);
    await readHealthSince(prom, rowsOf(row("a", "ok", "operational"), row("b", "no-data", "unknown")), NOW);
    expect(reads).toEqual([]);
  });

  it("a blocked provider: the start of the run its blocked gauge has been 1, read for the unhealthy names only", async () => {
    const { prom, reads } = client((q) =>
      q.includes("smartrouter_csm_provider_blocked")
        ? [{ metric: { provider_address: "Tatum", spec: "ETH1" }, values: minutes((ago) => (ago <= 130 || (ago > 600 && ago < 620) ? "1" : "0")) }]
        : []);
    const rows = rowsOf(row("tatum", "blocked"), row("lava", "ok", "operational"));
    await readHealthSince(prom, rows, NOW);
    expect(reads).toEqual(['max by (provider_address, spec) (smartrouter_csm_provider_blocked{provider_address=~"tatum"})']);
    // An earlier blocked stretch that ended is not this one.
    expect(rows.get("tatum|ETH1")).toMatchObject({ healthSince: NOW - 130 * 60, healthSinceOrEarlier: false });
  });

  it("a hole in the blocked gauge's series ends the run: blocked before it is another stretch", async () => {
    // Blocked 10 h ago, the series absent from 3 h 20 min to 20 min ago, blocked again since.
    const withHole = minutes(() => "1").filter(([t]) => { const ago = (NOW - t) / 60; return ago <= 600 && !(ago > 20 && ago < 200); });
    const { prom } = client(() => [{ metric: { provider_address: "tatum", spec: "ETH1" }, values: withHole }]);
    const rows = rowsOf(row("tatum", "blocked"));
    await readHealthSince(prom, rows, NOW);
    expect(rows.get("tatum|ETH1")).toMatchObject({ healthSince: NOW - 20 * 60, healthSinceOrEarlier: false });
  });

  it("a few missing points are not a hole: the run goes on through them", async () => {
    const fewMissing = minutes((ago) => (ago <= 130 ? "1" : "0")).filter(([t]) => { const ago = (NOW - t) / 60; return !(ago > 40 && ago < 45); });
    const { prom } = client(() => [{ metric: { provider_address: "tatum", spec: "ETH1" }, values: fewMissing }]);
    const rows = rowsOf(row("tatum", "blocked"));
    await readHealthSince(prom, rows, NOW);
    expect(rows.get("tatum|ETH1")).toMatchObject({ healthSince: NOW - 130 * 60, healthSinceOrEarlier: false });
  });

  it("blocked for the whole day read is at least that old", async () => {
    const { prom } = client(() => [{ metric: { provider_address: "tatum", spec: "ETH1" }, values: minutes(() => "1") }]);
    const rows = rowsOf(row("tatum", "blocked"));
    await readHealthSince(prom, rows, NOW);
    expect(rows.get("tatum|ETH1")).toMatchObject({ healthSince: NOW - SINCE_LOOKBACK_SEC, healthSinceOrEarlier: true });
  });

  it("every block check failing: since the last minute a check passed", async () => {
    const { prom, reads } = client((q) =>
      q.includes("rpc_endpoint_fetch_latest_success")
        ? [{ metric: { endpoint_id: "node.a", spec: "ETH1", apiInterface: "jsonrpc" }, values: minutes((ago) => (ago >= 45 ? "2" : "0")) }]
        : []);
    const rows = rowsOf(row("node.a", "checks-failing"));
    await readHealthSince(prom, rows, NOW);
    expect(reads).toEqual(['sum by (endpoint_id, spec, apiInterface, instance) (increase(rpc_endpoint_fetch_latest_success{endpoint_id=~"node\\\\.a"}[75s]))']);
    expect(rows.get("node.a|ETH1")).toMatchObject({ healthSince: NOW - 45 * 60, healthSinceOrEarlier: false });
  });

  it("one interface failing beside one that passes: since the failing interface's last pass", async () => {
    const series = (apiInterface: string, instance: string, v: (ago: number) => string) =>
      ({ metric: { endpoint_id: "node-a", spec: "ETH1", apiInterface, instance }, values: minutes(v) });
    // The verdict's own reads: jsonrpc passes on both replicas, rest fails on both.
    const { prom: now } = healthProm(
      [],
      [series("jsonrpc", "a", () => "0"), series("jsonrpc", "b", () => "0")].map((s) => ({ metric: s.metric, value: [1, "3"] as [number, string] })),
      [series("rest", "a", () => "0"), series("rest", "b", () => "0")].map((s) => ({ metric: s.metric, value: [1, "2"] as [number, string] })),
    );
    const rows = await readUpstreamHealth(now);
    const [verdict] = [...rows.values()];
    expect(verdict).toMatchObject({ health: "unhealthy", healthCause: "checks-failing" });
    expect(verdict!.failingChecks).toEqual([{ apiInterface: "rest", instance: "a" }, { apiInterface: "rest", instance: "b" }]);
    const { prom } = client(() => [
      series("jsonrpc", "a", () => "2"),
      series("jsonrpc", "b", () => "2"),
      series("rest", "a", (ago) => (ago >= 90 ? "1" : "0")),
      series("rest", "b", (ago) => (ago >= 200 ? "1" : "0")),
    ]);
    await readHealthSince(prom, rows, NOW);
    // Not "now", which the passing interface's checks would say; the earliest of the failing ones.
    expect(verdict).toMatchObject({ healthSince: NOW - 200 * 60, healthSinceOrEarlier: false });
  });

  it("a failing interface with no series of its own in the day read: at least a day, whatever the others passed", async () => {
    const { prom } = client(() => [{ metric: { endpoint_id: "node-a", spec: "ETH1", apiInterface: "jsonrpc" }, values: minutes(() => "2") }]);
    const rows = rowsOf(row("node-a", "checks-failing", "unhealthy", [{ apiInterface: "rest", instance: "" }]));
    await readHealthSince(prom, rows, NOW);
    expect(rows.get("node-a|ETH1")).toMatchObject({ healthSince: NOW - SINCE_LOOKBACK_SEC, healthSinceOrEarlier: true });
  });

  it("no check passed in the day read: at least a day", async () => {
    const { prom } = client(() => []);
    const rows = rowsOf(row("node-a", "checks-failing"));
    await readHealthSince(prom, rows, NOW);
    expect(rows.get("node-a|ETH1")).toMatchObject({ healthSince: NOW - SINCE_LOOKBACK_SEC, healthSinceOrEarlier: true });
  });

  it("a refused read, or a client that can't read a range, leaves it unknown", async () => {
    const refused = rowsOf(row("tatum", "blocked"));
    await readHealthSince(client(() => null).prom, refused, NOW);
    expect(refused.get("tatum|ETH1")!.healthSince).toBeNull();
    const none = rowsOf(row("tatum", "blocked"));
    await readHealthSince({} as PrometheusClient, none, NOW);
    expect(none.get("tatum|ETH1")!.healthSince).toBeNull();
  });

  it("lists the providers to look at: unhealthy first, the oldest trouble first, operational left out", () => {
    const a = { ...row("a", "blocked"), healthSince: 200 };
    const b = { ...row("b", "checks-failing"), healthSince: 100 };
    const list = providersNeedingAttention(rowsOf(row("ok", "ok", "operational"), row("c", "no-data", "unknown"), a, b));
    expect(list.map((p) => [p.endpointId, p.health, p.cause, p.since])).toEqual([
      ["b", "unhealthy", "checks-failing", 100], ["a", "unhealthy", "blocked", 200], ["c", "unknown", "no-data", null],
    ]);
  });
});
