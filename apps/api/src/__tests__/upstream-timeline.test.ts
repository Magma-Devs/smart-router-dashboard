import { describe, expect, it, vi } from "vitest";
import { MetricsDetailService } from "../services/metrics-detail.js";
import type { PrometheusClient } from "../services/prometheus-client.js";

/**
 * `upstreamTimeline` - the ChainDetail Availability view's provider rows:
 * every upstream of one chain, a cell per point of the availability grid.
 */
describe("MetricsDetailService.upstreamTimeline · every upstream of a chain on the availability grid", () => {
  const NOW = 1_800_000_000; // a multiple of 15 s
  const START = NOW - 300;
  const ts = Array.from({ length: 21 }, (_, k) => START + k * 15);
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
        if (expr.startsWith("sum by (provider_address) (rate(smartrouter_requests_total")) {
          return [
            series("provider_address", "eth-primary", () => "2"),
            // The series carries another case than the values file.
            series("provider_address", "Eth-Backup", (k) => (k >= 16 ? "1" : null)),
            series("provider_address", "Cached", () => "1"),
          ];
        }
        if (expr.startsWith("clamp_min(")) {
          return [
            series("provider_address", "eth-primary", (k) => (k >= 10 && k <= 15 ? "2" : "0")),
            series("provider_address", "Eth-Backup", (k) => (k >= 16 ? "0" : null)),
          ];
        }
        if (expr.includes("fetch_latest_success")) {
          return [
            series("endpoint_id", "eth-backup", () => "1"),
            series("endpoint_id", "eth-orphan", (k) => (k < 3 ? "1" : null)),
          ];
        }
        if (expr.includes("fetch_latest_fails")) return [series("endpoint_id", "eth-backup", () => "0")];
        return [];
      },
    } as unknown as PrometheusClient;
    return { svc: new MetricsDetailService(prom, config as never), queries };
  }

  it("primaries, then backups, then what only the metrics name; every cell on the availability grid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    try {
      const { svc, queries } = service();
      const body = await svc.upstreamTimeline("ETH1", "5m");
      expect(body.available).toBe(true);
      expect(body.grid).toEqual({ start: START, end: NOW, stepSec: 15 });
      // Four range reads, on the window's own step: the availability series' grid.
      expect(queries).toHaveLength(4);
      for (const q of queries) expect(q.startsWith(`${START} ${NOW} 15s `)).toBe(true);
      for (const q of queries) expect(q).toContain('{spec="ETH1"}');
      expect(body.upstreams.map((u) => [u.upstream, u.role, u.inConfig])).toEqual([
        ["eth-primary", "primary", true],
        ["eth-stage-node", "primary", true],
        ["eth-backup", "backup", true],
        ["eth-orphan", null, false],
      ]);
      const [primary, stage, backup, orphan] = body.upstreams;
      expect(primary!.cells).toHaveLength(21);
      expect(primary!.cells[0]).toEqual({ t: START, state: "operational", rps: 2, failedRps: 0, share: 2 / 3, pollsOk: null, pollsFailed: null });
      expect(primary!.cells[12]!.state).toBe("unhealthy");
      // Nothing scraped for a declared node: a gap, never a health or a 0%.
      expect(stage!.cells.every((c) => c.state === null && c.share === null)).toBe(true);
      // The backup took nothing until k = 16: healthy from its polls, no share.
      expect(backup!.cells[0]).toMatchObject({ state: "operational", rps: null, share: null, pollsOk: 1 });
      // Then a quarter of the chain's tries, the cache's counted in the denominator.
      expect(backup!.cells[20]).toMatchObject({ state: "operational", rps: 1, share: 0.25 });
      expect(orphan!.cells[0]!.state).toBe("operational");
      expect(orphan!.cells[5]!.state).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("one config router keeps only its own nodes", async () => {
    const { svc } = service();
    const body = await svc.upstreamTimeline("ETH1", "5m", "eth-stage");
    expect(body.upstreams.map((u) => u.upstream)).toEqual(["eth-stage-node"]);
  });

  it("a read the store refused says so instead of reading as quiet", async () => {
    const { svc } = service("fetch_latest_fails");
    const body = await svc.upstreamTimeline("ETH1", "5m");
    expect(body.available).toBe(false);
    expect(body.failed).toEqual(["pollsFailed"]);
  });
});
