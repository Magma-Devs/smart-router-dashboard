import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECORDED, setRecordedReads } from "@sr/shared";
import { MetricsDetailService } from "../services/metrics-detail.js";
import type { PrometheusClient } from "../services/prometheus-client.js";

/**
 * `errorIncidents` - the Errors tab's timeline: what it reads from the store
 * for a window, a chain and a config router, and what it keeps of the answer.
 */
describe("MetricsDetailService.errorIncidents · the reads behind the timeline", () => {
  const NOW = 1_800_000_000; // a multiple of 300 s
  const config = {
    getRouters: () => [
      { id: "eth-prod", spec: "ETH1", localPort: null, nodes: [{ name: "node-a", isBackup: false, endpoints: [] }, { name: "node-b", isBackup: true, endpoints: [] }] },
      { id: "base-prod", spec: "BASE", localPort: null, nodes: [{ name: "node-c", isBackup: false, endpoints: [] }] },
    ],
  };
  /** 5-minute counts over a day: `n` stretches from stretch `at` carry `v`, the rest 0. */
  const day = (at: number, n: number, v: string) =>
    Array.from({ length: 289 }, (_, k) => [NOW - 86_400 + k * 300, k >= at && k < at + n ? v : "0"] as [number, string]);

  function service(refuse: string | null = null) {
    const reads: { expr: string; start: number; end: number; step: string }[] = [];
    const prom = {
      async queryRangeOrNull(expr: string, start: number, end: number, step: string) {
        reads.push({ expr, start, end, step });
        if (refuse && expr.includes(refuse)) return null;
        if (expr.includes("smartrouter_requests_failed_total")) {
          return [
            { metric: { spec: "ETH1", provider_address: "Node-A" }, values: day(286, 3, "40") },
            { metric: { spec: "ETH1", provider_address: "node-x" }, values: day(100, 3, "40") },
            { metric: { spec: "ETH1", provider_address: "Cached" }, values: day(286, 3, "40") },
            { metric: { spec: "BASE", provider_address: "node-c" }, values: day(200, 3, "40") },
          ];
        }
        return [{ metric: { spec: "ETH1", provider_address: "node-b" }, values: day(287, 2, "300") }];
      },
    } as unknown as PrometheusClient;
    return { svc: new MetricsDetailService(prom, config as never), reads };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000 + 42_000);
  });
  afterEach(() => vi.useRealTimers());

  it("reads failed tries and error replies once each, a day back at 5-minute steps, ending on a step", async () => {
    const { svc, reads } = service();
    const body = await svc.errorIncidents("1d");
    expect(reads.map((r) => [r.start, r.end, r.step])).toEqual([[NOW - 86_400, NOW, "300s"], [NOW - 86_400, NOW, "300s"]]);
    expect(reads.map((r) => r.expr)).toEqual([
      "sum by (spec, provider_address) (increase(smartrouter_requests_failed_total[300s]))",
      "sum by (spec, provider_address) (increase(smartrouter_node_errors_total[300s]))",
    ]);
    expect(body).toMatchObject({ from: NOW - 86_400, to: NOW, stepSec: 300, available: true, failed: [] });
    // Every chain and provider but the relay cache.
    expect(body.lines.map((l) => `${l.kind} ${l.providers.join()} ${l.chains[0]!.spec}`).sort()).toEqual([
      "failed Node-A ETH1", "failed node-c BASE", "failed node-x ETH1", "reply node-b ETH1",
    ]);
  });

  it("reads one chain's series when a chain is picked", async () => {
    const { svc, reads } = service();
    const body = await svc.errorIncidents("1d", "ETH1");
    expect(reads.every((r) => r.expr.includes('{spec="ETH1"}'))).toBe(true);
    expect(body.lines.every((l) => l.chains.every((c) => c.spec === "ETH1"))).toBe(true);
  });

  it("reads a config router's chain and keeps the providers it declares, in any case", async () => {
    const { svc, reads } = service();
    const body = await svc.errorIncidents("1d", undefined, "eth-prod");
    expect(reads.every((r) => r.expr.includes('{spec="ETH1"}'))).toBe(true);
    expect(body.lines.map((l) => `${l.kind} ${l.providers.join()}`).sort()).toEqual(["failed Node-A", "reply node-b"]);
  });

  it("answers no lines, without a read, for a router the config does not name", async () => {
    const { svc, reads } = service();
    const body = await svc.errorIncidents("1d", undefined, "gone");
    expect(reads).toEqual([]);
    expect(body).toEqual({ from: NOW - 86_400, to: NOW, stepSec: 300, lines: [], steady: [], available: true, failed: [] });
  });

  it("names a read the store refused, and keeps the lines of the other", async () => {
    const { svc } = service("smartrouter_node_errors_total");
    const body = await svc.errorIncidents("1d", "ETH1");
    expect(body).toMatchObject({ available: false, failed: ["reply"] });
    expect(body.lines.map((l) => l.kind)).toEqual(["failed", "failed"]);
  });

  it("reads at a 1-minute step up to 3 hours and 30 minutes beyond 7 days, always at least a day back", async () => {
    const { svc, reads } = service();
    await svc.errorIncidents("30m");
    await svc.errorIncidents("30d");
    expect(reads.map((r) => [r.end - r.start, r.step, r.end % Number.parseInt(r.step, 10)])).toEqual([
      [86_400, "60s", 0], [86_400, "60s", 0], [30 * 86_400, "1800s", 0], [30 * 86_400, "1800s", 0],
    ]);
  });
});

describe("MetricsDetailService.errorIncidents · a config router past a week, from recorded series", () => {
  const NOW = 1_800_000_000;
  const config = {
    getRouters: () => [{ id: "eth-prod", spec: "ETH1", localPort: null, nodes: [{ name: "node-a", isBackup: false, endpoints: [] }] }],
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    setRecordedReads({ from: "3h", available: true, historySeconds: 30 * 86_400 + 11 * 3600 });
  });
  afterEach(() => {
    vi.useRealTimers();
    setRecordedReads({ from: null, available: false });
  });

  it("reads its chain's recorded series and keeps the providers it declares", async () => {
    const reads: string[] = [];
    const prom = {
      async queryRangeOrNull(expr: string, start: number, end: number, step: string) {
        reads.push(expr);
        const values = (v: (t: number) => string) => {
          const out: [number, string][] = [];
          for (let t = start; t <= end; t += Number.parseInt(step, 10)) out.push([t, v(t)]);
          return out;
        };
        if (expr.startsWith("max(count_over_time(")) return [{ metric: {}, values: values(() => "30") }];
        if (expr.includes(RECORDED.requestsByProvider)) {
          const hot = (t: number) => (t > NOW - 3600 ? "400" : "0");
          return [
            { metric: { spec: "ETH1", provider_address: "Node-A" }, values: values(hot) },
            { metric: { spec: "ETH1", provider_address: "node-other" }, values: values(hot) },
          ];
        }
        return [];
      },
    } as unknown as PrometheusClient;
    const body = await new MetricsDetailService(prom, config as never).errorIncidents("30d", undefined, "eth-prod");
    expect(reads.filter((q) => q.includes(":rate2m15s"))).toHaveLength(2);
    for (const q of reads) expect(q).toContain('{spec="ETH1"}');
    expect(reads.some((q) => q.includes("smartrouter_requests_failed_total"))).toBe(false);
    expect(body.lines.map((l) => `${l.kind} ${l.providers.join()} ${l.count}`)).toEqual(["failed Node-A 800"]);
  });
});
