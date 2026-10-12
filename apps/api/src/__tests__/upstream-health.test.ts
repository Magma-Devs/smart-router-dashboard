import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { metricRoutes } from "../routes/metrics.js";
import { MetricsService } from "../services/metrics.js";
import type { ConfigurationService } from "../services/configuration.js";
import { readUpstreamHealth, healthWindowSeconds } from "../services/upstream-health.js";
import type { PrometheusClient, PromVectorSample } from "../services/prometheus-client.js";

const sample = (value: string, spec = "ETH1", apiInterface = "jsonrpc"): PromVectorSample => ({
  metric: { endpoint_id: "test-upstream", spec, apiInterface },
  value: [1, value],
});

async function roster(healthRows: PromVectorSample[], total = 1_000_000, ok = 999_999) {
  const prom = {
    query: async (q: string) => {
      if (q.startsWith("rpc_endpoint_overall_health")) return healthRows;
      if (q.includes("rpc_endpoint_fetch_latest_success"))
        return healthRows.filter((row) => row.value[1] === "1");
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
    const [row] = await roster([sample("0")]);
    expect(row.health).toBe("unhealthy");
    expect(row.uptime).toBe(0.999999);
  });

  it("does not manufacture success rate when no requests were sent", async () => {
    const [row] = await roster([sample("0")], 0, 0);
    expect(row.health).toBe("unhealthy");
    expect(row.uptime).toBeNull();
  });

  it.each([false, true])(
    "uses the worst interface health independent of result order (reversed=%s)",
    async (reverse) => {
      const rows = [sample("0", "ETH1", "rest"), sample("1"), sample("1", "SOLANA")];
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
      const samples = [sample("NaN", "ETH1", "rest"), sample("1")];
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
) {
  const queries: string[] = [];
  const prom = {
    query: async (q: string) => {
      queries.push(q);
      if (q.startsWith("rpc_endpoint_overall_health")) return gauges;
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
    const overview = await app.inject(`/api/metrics/overview?window=1h${params}`);
    expect(roster.statusCode).toBe(200);
    expect(overview.statusCode).toBe(200);
    return {
      rows: roster.json().upstreams as import("@sr/shared").UpstreamMetrics[],
      overview: overview.json() as import("@sr/shared").OverviewData,
    };
  } finally {
    await app.close();
  }
}

describe("MAG-4226 review: configured upstream liveness", () => {
  it("keeps every configured endpoint visible with a reason before the first scrape", async () => {
    const { rows, overview } = await healthHttp([], [], []);
    expect(rows).toHaveLength(4);
    expect(
      rows.every(
        (row) => row.health === "unknown" && row.healthReason?.includes("check the router"),
      ),
    ).toBe(true);
    expect(overview.upstreamHealthCounts).toEqual({ unhealthy: 0, unknown: 4 });
  });

  it("failed recent block polls override a stuck healthy gauge with no traffic", async () => {
    const { rows, overview } = await healthHttp(
      [sample("1")],
      [],
      [sample("2")],
      "&routerId=eth-prod",
    );
    const row = rows.find((row) => row.endpointId === "test-upstream")!;
    expect(row.health).toBe("unhealthy");
    expect(row.healthReason).toContain("All reported block polls failed");
    expect(row.requests).toBe(0);
    expect(row.uptime).toBeNull();
    expect(rows).toHaveLength(2);
    expect(overview.upstreamHealthCounts).toEqual({ unhealthy: 1, unknown: 1 });
  });

  it("does not label zero polls as failure, and positive successes establish health", async () => {
    const { prom } = healthProm([], [sample("0")], [sample("0")]);
    expect([...(await readUpstreamHealth(prom))].map(([, row]) => row.health)).toEqual(["unknown"]);
    const recovered = healthProm([], [sample("1")], [sample("0")]);
    expect([...(await readUpstreamHealth(recovered.prom))].map(([, row]) => row.health)).toEqual([
      "operational",
    ]);
  });

  it("mixed poll results do not override a healthy gauge", async () => {
    const { prom } = healthProm([sample("1")], [sample("1")], [sample("2")]);
    expect([...(await readUpstreamHealth(prom))].map(([, row]) => row.health)).toEqual([
      "operational",
    ]);
  });

  it("successful polls never override an unhealthy live check", async () => {
    const { prom } = healthProm([sample("0")], [sample("4")]);
    expect([...(await readUpstreamHealth(prom))].map(([, row]) => row.health)).toEqual([
      "unhealthy",
    ]);
  });

  it.each([false, true])(
    "does not let another interface's successful polls mask failures (reverse=%s)",
    async (reverse) => {
      const gauges = [sample("1"), sample("1", "ETH1", "rest")];
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
      [replica("1", "a"), replica("1", "b")],
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
    const { prom } = healthProm([sample("1")], [sample("1")]);
    const row = [...(await readUpstreamHealth(prom, config))][0][1];
    expect(row.health).toBe("unknown");
    expect(row.healthReason).toContain("rest interface");
  });

  it("isolates the same vendor name on different chains and filters both counts and rows", async () => {
    const { rows, overview } = await healthHttp(
      [sample("0"), sample("1", "SOLANA")],
      [sample("1", "SOLANA")],
      [],
      "&spec=SOLANA&routerId=sol",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].spec).toBe("SOLANA");
    expect(rows[0].health).toBe("operational");
    expect(overview.upstreamHealthCounts).toEqual({ unhealthy: 0, unknown: 0 });
  });

  it("uses four bounded current-health queries, without traffic, QoS or histograms", async () => {
    const { prom, queries } = healthProm([sample("1")]);
    await readUpstreamHealth(prom, configured);
    expect(queries).toHaveLength(4);
    expect(queries.every((q) => !/histogram|selection_score|requests_total/.test(q))).toBe(true);
    expect(queries.filter((q) => q.includes("increase(")).every((q) => q.includes("[1800s]"))).toBe(
      true,
    );
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
    expect(queries).toHaveLength(4);
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
        [sample("1", spec)],
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
        const overview = (
          await app.inject(`/api/metrics/overview?spec=${spec}&routerId=slow&window=7d`)
        ).json();
        expect(rows[0].health).toBe("unhealthy");
        expect(rows[0].healthReason).toContain("30 minutes");
        expect(overview.upstreamHealthCounts).toEqual({ unhealthy: 1, unknown: 0 });
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

  it("does not let an empty or expired poll window turn a reset gauge green", async () => {
    const { prom } = healthProm(
      [sample("1", "BTC")],
      [sample("0", "BTC")],
      [sample("0", "BTC")],
      [sample("0", "BTC")],
    );
    const row = [...(await readUpstreamHealth(prom))][0][1];
    expect(row.health).toBe("unknown");
    expect(row.healthReason).toContain("cannot confirm recovery");
    expect(row.healthReason).toContain("30 minutes");
  });

  it("requires positive success evidence to recover from a stuck gauge", async () => {
    const { prom } = healthProm(
      [sample("1", "BTC")],
      [sample("1", "BTC")],
      [sample("2", "BTC")],
      [sample(String(1 / 600), "BTC")],
    );
    expect([...(await readUpstreamHealth(prom))][0][1].health).toBe("operational");
  });
});
