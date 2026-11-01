// Deterministic sparse block events, ingested by real Prometheus via promtool.
// These are controlled observations, not traffic from a customer's router.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "/tmp/mag4226-slow-chain");
await mkdir(output, { recursive: true });
const origin = Math.floor(Date.now() / 1000 / 15) * 15 - 3 * 3600;
const lines = [];
const specs = ["BTC", "BTCT", "BCHT", "ETH1", "UNRATED", "A.B"];
for (const spec of specs) {
  const interval = spec === "ETH1" || spec === "A.B" ? 12 : 600;
  for (const endpoint of ["fixture-peer", "fixture-switchable"]) {
    const labels = `endpoint_id="${endpoint}",spec="${spec}",apiInterface="jsonrpc",instance="fixture:7779"`;
    for (let t = -4200; t <= 7200; t += 15) {
      const healthy = endpoint === "fixture-peer";
      const ok = healthy
        ? Math.floor((t + 4200) / interval)
        : t >= 3000
          ? 1
          : t >= 2700
            ? 0
            : t >= 2400
              ? 1
              : 0;
      const failed = healthy || t >= 2700 ? 0 : t < 0 ? 0 : Math.min(4, Math.floor(t / 600) + 1);
      const tip =
        healthy && spec !== "UNRATED" ? 100000 + Math.floor((t + 4200) / interval) : 100000;
      lines.push(`rpc_endpoint_overall_health{${labels}} 1 ${origin + t}`);
      lines.push(`rpc_endpoint_fetch_latest_success{${labels}} ${ok} ${origin + t}`);
      lines.push(`rpc_endpoint_fetch_latest_fails{${labels}} ${failed} ${origin + t}`);
      lines.push(`rpc_endpoint_latest_block{${labels}} ${tip} ${origin + t}`);
    }
  }
}
for (let t = -4200; t <= 7200; t += 15) lines.push(`smartrouter_overall_health 1 ${origin + t}`);
lines.push("# EOF");
await writeFile(resolve(output, "samples.om"), lines.join("\n") + "\n");
await writeFile(
  resolve(output, "schedule.json"),
  JSON.stringify(
    {
      origin,
      specs,
      evaluations: [
        { name: "sparse-failure-6-minutes-after-last-event", offset: 960, expected: "unhealthy" },
        { name: "sparse-failure-9-minutes-after-last-event", offset: 1140, expected: "unhealthy" },
        { name: "next-failure-event", offset: 1215, expected: "unhealthy" },
        { name: "failure-in-window", offset: 2100, expected: "unhealthy" },
        { name: "recovery-positive-success", offset: 2415, expected: "operational" },
        { name: "counter-reset-and-new-success", offset: 3015, expected: "operational" },
        { name: "expired-outcomes-no-false-green", offset: 7200, expected: "unknown" },
      ],
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  resolve(output, "prometheus.yml"),
  "global:\n  scrape_interval: 15s\nscrape_configs: []\n",
);
console.log(output);
