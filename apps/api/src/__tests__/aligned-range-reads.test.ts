import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOWS, durationSeconds, type MetricWindow } from "@sr/shared";
import { MetricsService } from "../services/metrics.js";
import { MetricsDetailService } from "../services/metrics-detail.js";
import { MetricsDashboardService } from "../services/metrics-dashboard.js";
import { PrometheusClient, RANGE_REUSE_MAX_MS, RANGE_SETTLE_MS } from "../services/prometheus-client.js";

interface RangeRead {
  expr: string;
  start: number;
  end: number;
  step: string;
}

/** A store that answers nothing and records every range read: its query, bounds and step. */
function recordingProm() {
  const reads: RangeRead[] = [];
  const range = async (expr: string, start: number, end: number, step: string) => {
    reads.push({ expr, start, end, step });
    return [];
  };
  const prom = {
    // listSpecs() must find a chain or the per-chain reads never go out.
    async query(expr: string) {
      return expr.startsWith("count by (spec)") ? [{ metric: { spec: "ETH1" }, value: [1, "1"] }] : [];
    },
    async scalar() {
      return null;
    },
    queryRange: range,
    queryRangeOrNull: range,
    async queryAtOrNull() {
      return [];
    },
    async ping() {
      return true;
    },
  } as unknown as PrometheusClient;
  return { prom, reads };
}

/** Every service call that draws a chart from a range read. */
async function everyChart(prom: PrometheusClient, w: MetricWindow): Promise<void> {
  const metrics = new MetricsService(prom);
  const detail = new MetricsDetailService(prom);
  await metrics.overview(w);
  await metrics.traffic(w);
  await metrics.rpsSeries(undefined, w);
  await detail.chainSeries("ETH1", w);
  await detail.upstreamDetail({ endpointId: "eth-lava", spec: "ETH1" }, w);
  await detail.upstreamPeers("ETH1", w);
  await detail.errors(w);
  await new MetricsDashboardService(prom).dashboard(w);
}

const WINDOW_KEYS = Object.keys(WINDOWS) as MetricWindow[];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// MAG-4571: range reads ended on the current second, so every poll asked for a
// new window: our read cache never matched one, and Mimir's results cache
// keeps a range read only when both ends are multiples of its step.
describe("chart range reads end on a step boundary (MAG-4571)", () => {
  it("every range read, every window: both ends on its step, the end no later than now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.UTC(2026, 9, 22, 15, 23, 32, 750);
    vi.setSystemTime(now);
    for (const w of WINDOW_KEYS) {
      const { prom, reads } = recordingProm();
      await everyChart(prom, w);
      expect(reads.length, w).toBeGreaterThan(30);
      for (const r of reads) {
        const stepSec = durationSeconds(r.step);
        const at = `${w}: ${r.expr} @ ${r.step}`;
        expect(r.start % stepSec, at).toBe(0);
        expect(r.end % stepSec, at).toBe(0);
        expect(r.end, at).toBeLessThanOrEqual(now / 1000);
        expect(now / 1000, at).toBeLessThan(r.end + stepSec);
      }
    }
  });

  it("two polls within one step ask for exactly the same windows; the next step moves the shortest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 16:00 UTC is a boundary of every step in the catalog, 15 s to 4 h.
    const boundary = Date.UTC(2026, 9, 22, 16, 0);
    const poll = async (ms: number, w: MetricWindow) => {
      vi.setSystemTime(boundary + ms);
      const { prom, reads } = recordingProm();
      await everyChart(prom, w);
      return reads;
    };
    for (const w of WINDOW_KEYS) {
      const first = await poll(1_000, w);
      expect(await poll(14_999, w), w).toEqual(first);
    }
    // A step on, the 15-second reads of the 30-minute window move by one step.
    const before = await poll(1_000, "30m");
    const after = await poll(15_000, "30m");
    const moved = after.filter((r, i) => r.end !== before[i]!.end);
    expect(moved.length).toBeGreaterThan(0);
    for (const r of moved) expect(r.step === "15s" && r.end === boundary / 1000 + 15, r.expr).toBe(true);
  });
});

// The error bars' whole-bar read ends where the last bar closed. Read seconds
// after it closes, that bar can be short of its last scrapes, so the answer
// keeps the instant TTL until the bar is three minutes old.
describe("a bar that has just closed is read again until it has settled (MAG-4571)", () => {
  it("the 6-hour window's 10-minute bars, through the real client", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const closed = Date.UTC(2026, 9, 22, 16, 0);
    const barReads: string[] = [];
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(String(input));
      const range = url.pathname.endsWith("/query_range");
      if (range && url.searchParams.get("step") === "600s") barReads.push(url.searchParams.get("end")!);
      return Response.json({ status: "success", data: { resultType: range ? "matrix" : "vector", result: [] } });
    });
    const detail = new MetricsDetailService(new PrometheusClient("http://prom.test", 1000, null, {}, { cacheTtlMs: 10_000 }));
    const poll = async (sinceClosed: number) => {
      vi.setSystemTime(closed + sinceClosed);
      await detail.upstreamDetail({ endpointId: "eth-lava", spec: "ETH1" }, "6h");
    };
    await poll(5_000);
    await poll(20_000); // the next poll reads the closed bar again
    expect(barReads).toHaveLength(2);
    await poll(RANGE_SETTLE_MS + 5_000); // settled: one more read...
    await poll(RANGE_SETTLE_MS + 200_000); // ...that is kept
    expect(barReads).toHaveLength(3);
    await poll(RANGE_SETTLE_MS + 5_000 + RANGE_REUSE_MAX_MS); // for five minutes
    expect(barReads).toHaveLength(4);
    // Every one of them is the window ending where the bar closed.
    expect(new Set(barReads)).toEqual(new Set([String(closed / 1000)]));
  });
});
