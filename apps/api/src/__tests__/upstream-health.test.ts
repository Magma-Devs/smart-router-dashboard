import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { metricRoutes } from "../routes/metrics.js";
import { MetricsService } from "../services/metrics.js";
import type { PrometheusClient, PromVectorSample } from "../services/prometheus-client.js";

const sample = (value: string, spec = "ETH1", apiInterface = "jsonrpc"): PromVectorSample => ({
  metric: { endpoint_id: "test-upstream", spec, apiInterface },
  value: [1, value],
});

async function roster(healthRows: PromVectorSample[], total = 1_000_000, ok = 999_999) {
  const prom = {
    query: async (q: string) => {
      if (q.startsWith("rpc_endpoint_overall_health")) return healthRows;
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
