import { describe, expect, it, vi } from "vitest";
import { MetricsDetailService } from "../services/metrics-detail.js";
import type { PrometheusClient } from "../services/prometheus-client.js";

/**
 * `upstreamTimeline` - the Availability view: every upstream of one chain,
 * a cell per stretch of the clock.
 */
describe("MetricsDetailService.upstreamTimeline · every upstream of a chain on the clock", () => {
  const NOW = 1_800_000_000; // a multiple of 600 s: no bar filling
  const STEP = 600; // an hour in 10-minute bars
  const START = NOW - 3000;
  const ts = Array.from({ length: 6 }, (_, k) => START + k * STEP);
  const series = (label: string, name: string, at: (k: number) => string | null) => ({
    metric: { [label]: name },
    values: ts.flatMap((t, k) => {
      const v = at(k);
      return v === null ? [] : [[t, v] as [number, string]];
    }),
  });
  const config = {
    getRouters: () => [
      {
        id: "eth-prod", spec: "ETH1", localPort: null, nodes: [
          { name: "eth-primary", isBackup: false, endpoints: [] },
          { name: "eth-backup", isBackup: true, endpoints: [] },
        ],
      },
      { id: "eth-stage", spec: "ETH1", localPort: null, nodes: [{ name: "eth-stage-node", isBackup: false, endpoints: [] }] },
      { id: "base-prod", spec: "BASE", localPort: null, nodes: [{ name: "base-node", isBackup: false, endpoints: [] }] },
    ],
  };
  function service(fail: string | null = null) {
    const queries: string[] = [];
    const prom = {
      async queryRangeOrNull(expr: string, start: number, end: number, step: string) {
        queries.push(`${start} ${end} ${step} ${expr}`);
        if (fail && expr.includes(fail)) return null;
        // The bar still filling: one point at now.
        if (start === end) {
          return expr.startsWith("sum by (provider_address) (rate(smartrouter_requests_total")
            ? [{ metric: { provider_address: "eth-primary" }, values: [[start, "5"]] }]
            : [];
        }
        if (expr.startsWith("sum by (provider_address) (rate(smartrouter_requests_total")) {
          return [
            series("provider_address", "eth-primary", () => "2"),
            // The series carries another case than the values file.
            series("provider_address", "Eth-Backup", (k) => (k >= 4 ? "1" : null)),
            series("provider_address", "Cached", () => "1"),
          ];
        }
        if (expr.startsWith("clamp_min(")) {
          return [
            series("provider_address", "eth-primary", (k) => (k === 2 ? "2" : "0")),
            series("provider_address", "Eth-Backup", (k) => (k >= 4 ? "0" : null)),
          ];
        }
        if (expr.includes("fetch_latest_success")) {
          return [
            series("endpoint_id", "eth-backup", () => "1"),
            series("endpoint_id", "eth-orphan", (k) => (k < 1 ? "1" : null)),
          ];
        }
        if (expr.includes("fetch_latest_fails")) return [series("endpoint_id", "eth-backup", () => "0")];
        // What clients got: requests, and the ones the router couldn't serve.
        if (expr.includes("smartrouter_final_requests:count1m")) return [series("chain", "eth1", (k) => (k === 5 ? null : "40"))];
        if (expr.includes("smartrouter_final_failures:count1m")) return [series("chain", "eth1", (k) => (k === 2 ? "3" : "0"))];
        return [];
      },
    } as unknown as PrometheusClient;
    return { svc: new MetricsDetailService(prom, config as never), queries };
  }

  it("primaries, then backups, then what only the metrics name; a cell per stretch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    try {
      const { svc, queries } = service();
      const body = await svc.upstreamTimeline("ETH1", "1h");
      expect(body.available).toBe(true);
      expect(body.grid).toEqual({ start: START, end: NOW, stepSec: STEP });
      // Four range reads on the cells' own step, and the two counts of what clients got.
      expect(queries).toHaveLength(6);
      for (const q of queries) expect(q.startsWith(`${START} ${NOW} 10m `)).toBe(true);
      expect(queries.filter((q) => q.includes('{spec="ETH1"}'))).toHaveLength(4);
      expect(queries.filter((q) => q.includes('{chain="eth1"}'))).toHaveLength(2);
      expect(body.upstreams.map((u) => [u.upstream, u.role, u.inConfig])).toEqual([
        ["eth-primary", "primary", true],
        ["eth-stage-node", "primary", true],
        ["eth-backup", "backup", true],
        ["eth-orphan", null, false],
      ]);
      const [primary, stage, backup, orphan] = body.upstreams;
      expect(primary!.cells).toHaveLength(6);
      expect(primary!.cells[0]).toEqual({ t: START, state: "operational", rps: 2, failedRps: 0, share: 2 / 3, pollsOk: null, pollsFailed: null });
      expect(primary!.cells[2]!.state).toBe("unhealthy");
      // Nothing scraped for a declared node: a gap, never a health or a 0%.
      expect(stage!.cells.every((c) => c.state === null && c.share === null)).toBe(true);
      // The backup took nothing until bar 4: healthy from its polls, no share.
      expect(backup!.cells[0]).toMatchObject({ state: "operational", rps: null, share: null, pollsOk: 1 });
      // Then a quarter of the chain's tries, the cache's counted in the denominator.
      expect(backup!.cells[5]).toMatchObject({ state: "operational", rps: 1, share: 0.25 });
      expect(orphan!.cells[0]!.state).toBe("operational");
      expect(orphan!.cells[3]!.state).toBeNull();
      // Requests and the ones the router couldn't serve, per cell; a stretch with none recorded says so.
      expect(body.served![0]).toEqual({ t: START, requests: 40, failed: 0 });
      expect(body.served![2]).toEqual({ t: START + 2 * STEP, requests: 40, failed: 3 });
      expect(body.served![5]).toEqual({ t: NOW, requests: null, failed: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the stretch still filling is read at now and laid at its end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((NOW + 125) * 1000);
    try {
      const { svc, queries } = service();
      const body = await svc.upstreamTimeline("ETH1", "1h");
      expect(body.asOf).toBe(NOW + 125);
      expect(body.grid.end).toBe(NOW + STEP);
      // Each read once more, at now only.
      expect(queries.filter((q) => q.startsWith(`${NOW + 125} ${NOW + 125} `))).toHaveLength(6);
      const last = body.upstreams[0]!.cells.at(-1)!;
      expect(last).toMatchObject({ t: NOW + STEP, rps: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("one config router keeps only its own nodes, and reads what its clients got by its service_name", async () => {
    const { svc, queries } = service();
    const body = await svc.upstreamTimeline("ETH1", "1h", "eth-stage");
    expect(body.upstreams.map((u) => u.upstream)).toEqual(["eth-stage-node"]);
    const outcomes = queries.filter((q) => q.includes("smartrouter_final_"));
    expect(outcomes.length).toBeGreaterThan(0);
    for (const q of outcomes) expect(q).toContain('{chain="eth1", service_name=~".+-eth-stage"}');
  });

  it("a store without the recorded counts says nothing of what clients got, never 100%", async () => {
    const { svc } = service("smartrouter_final_");
    expect((await svc.upstreamTimeline("ETH1", "1h")).served).toBeNull();
  });

  it("a read the store refused says so instead of reading as quiet", async () => {
    const { svc } = service("fetch_latest_fails");
    const body = await svc.upstreamTimeline("ETH1", "1h");
    expect(body.available).toBe(false);
    expect(body.failed).toEqual(["pollsFailed"]);
  });
});
