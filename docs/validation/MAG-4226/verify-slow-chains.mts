// Run with pnpm --filter @sr/api exec tsx ../../docs/validation/MAG-4226/verify-slow-chains.ts.
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import Fastify from "../../../apps/api/node_modules/fastify/fastify.js";
import { PrometheusClient } from "../../../apps/api/src/services/prometheus-client.js";
import { MetricsService } from "../../../apps/api/src/services/metrics.js";
import { metricRoutes } from "../../../apps/api/src/routes/metrics.js";
import type { ConfigurationService } from "../../../apps/api/src/services/configuration.js";
const dir = process.env.SLOW_FIXTURE_DIR ?? "/tmp/mag4226-slow-chain";
const schedule = JSON.parse(await readFile(`${dir}/schedule.json`, "utf8"));
const prometheus = process.env.SLOW_PROM_URL ?? "http://127.0.0.1:19096";
const configured = {
  getRouters: () =>
    schedule.specs.map((spec: string) => ({
      id: spec,
      spec,
      nodes: ["fixture-peer", "fixture-switchable"].map((name) => ({
        name,
        endpoints: [{ interface: "jsonrpc" }],
      })),
    })),
} as unknown as ConfigurationService;
let evaluation = schedule.origin;
const app = Fastify();
app.decorate("scoped", () => ({
  metrics: new MetricsService(
    new PrometheusClient(`${prometheus}?time=${evaluation}`, 10000, null, {}),
    configured,
  ),
}));
await app.register(metricRoutes);
const address = await app.listen({ port: 0, host: "127.0.0.1" });
const results = [];
try {
  for (const point of schedule.evaluations) {
    evaluation = schedule.origin + point.offset;
    const response = await fetch(`${address}/api/metrics/upstreams?window=5m`);
    assert.equal(response.status, 200);
    const rows = (await response.json()).upstreams;
    const slowRows = rows.filter(
      (row: { spec: string; endpointId: string }) =>
        ["BTC", "BTCT", "BCHT", "UNRATED"].includes(row.spec) &&
        row.endpointId === "fixture-switchable",
    );
    assert.equal(slowRows.length, 4);
    for (const row of slowRows)
      assert.equal(row.health, point.expected, `${point.name} ${row.spec}: ${row.healthReason}`);
    const overview = await (await fetch(`${address}/api/metrics/overview?window=7d`)).json();
    assert.equal(
      overview.upstreamHealthCounts.unhealthy,
      rows.filter((row: { health: string }) => row.health === "unhealthy").length,
    );
    assert.equal(
      overview.upstreamHealthCounts.unknown,
      rows.filter((row: { health: string }) => row.health === "unknown").length,
    );
    const filtered = await (
      await fetch(`${address}/api/metrics/overview?spec=BTC&routerId=BTC`)
    ).json();
    assert.deepEqual(filtered.upstreamHealthCounts, {
      unhealthy: point.expected === "unhealthy" ? 1 : 0,
      unknown: point.expected === "unknown" ? 1 : 0,
    });
    const query = `sum by(endpoint_id,spec) (increase(rpc_endpoint_fetch_latest_fails[5m]))`;
    const old = await (
      await fetch(
        `${prometheus}/api/v1/query?time=${evaluation}&query=${encodeURIComponent(query)}`,
      )
    ).json();
    assert.equal(old.status, "success");
    results.push({
      name: point.name,
      evaluation,
      expected: point.expected,
      slowRows,
      counts: overview.upstreamHealthCounts,
      fixedFiveMinuteFailures: old.data.result,
    });
  }
  // Prometheus must parse each grouped branch, including literal regex metacharacters.
  evaluation = schedule.origin + 960;
  const grouped = await (await fetch(`${address}/api/metrics/upstreams`)).json();
  assert.equal(
    grouped.upstreams.find(
      (row: { spec: string; endpointId: string }) =>
        row.spec === "A.B" && row.endpointId === "fixture-peer",
    ).health,
    "operational",
  );
  await writeFile(
    `${dir}/results.json`,
    JSON.stringify(
      {
        fixture:
          "Controlled OpenMetrics loaded into real Prometheus TSDB; actual Fastify HTTP routes and PrometheusClient, no mocked PromQL answers",
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Passed ${results.length} sparse-event/recovery/expiry scenarios through real HTTP and Prometheus.`,
  );
} finally {
  await app.close();
}
