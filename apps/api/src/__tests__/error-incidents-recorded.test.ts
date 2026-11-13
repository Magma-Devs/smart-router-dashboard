import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { RECORDED, qErrorRepliesBySpecProvider, qFailedTriesBySpecProvider, qFailedTriesBySpecProviderRecorded, qRecordedSamplesPerStep, setRecordedReads } from "@sr/shared";
import { buildApp } from "../app.js";

/**
 * `GET /api/metrics/error-incidents` past a week: the failed tries come from
 * the recorded relays per provider where the store has them for the whole
 * read, and the stretches the ruler skipped minutes of are read raw. Asserted
 * on the PromQL that leaves the api and on the lines the answers make.
 */

const NOW = 1_800_000_000; // a multiple of 1800 s
const DAY = 86_400;
/** History the probe reports when the recorded series reach past a 30-day read. */
const DEEP = 30 * DAY + 11 * 3600;

interface RangeRead { query: string; start: number; end: number; step: string }

interface StoreOptions {
  /** Age of the newest recorded sample; null = no recorded series. */
  ageSec?: number | null;
  historySec?: number;
  /** Failed tries per stretch at `t`, as the recorded read answers them. */
  recorded?: (t: number) => number;
  /** Failed tries per stretch at `t`, as the raw read answers them. */
  raw?: (t: number) => number;
  /** Recorded samples per stretch at `t` (30 = every minute evaluated). */
  samples?: (t: number) => number;
  /** Range reads whose query matches are refused. */
  refuse?: RegExp;
}

function store(opts: StoreOptions = {}): RangeRead[] {
  const { ageSec = 30, historySec = DEEP, recorded = () => 0, raw = () => 0, samples = () => 30, refuse } = opts;
  const ranges: RangeRead[] = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const p = url.searchParams;
    const query = p.get("query") ?? "";
    const vector = (v: number | null) =>
      Response.json({ status: "success", data: { resultType: "vector", result: v === null ? [] : [{ metric: {}, value: [NOW, String(v)] }] } });
    if (!url.pathname.endsWith("/query_range")) {
      if (query.startsWith("time() - max(timestamp(")) return vector(ageSec);
      if (query.startsWith("time() - min(min_over_time(timestamp(")) return vector(ageSec === null ? null : historySec);
      if (query.startsWith("600 / max(count_over_time(")) return vector(15);
      return vector(null);
    }
    const start = Number(p.get("start")), end = Number(p.get("end")), step = p.get("step") ?? "";
    ranges.push({ query, start, end, step });
    if (refuse?.test(query)) return Response.json({ status: "error", errorType: "execution", error: "refused" }, { status: 422 });
    const sec = Number.parseInt(step, 10);
    const values = (f: (t: number) => number) => {
      const out: [number, string][] = [];
      for (let t = start; t <= end; t += sec) out.push([t, String(f(t))]);
      return out;
    };
    const matrix = (result: unknown[]) => Response.json({ status: "success", data: { resultType: "matrix", result } });
    if (query.startsWith("max(count_over_time(")) return matrix([{ metric: {}, values: values(samples) }]);
    if (query.includes(RECORDED.requestsByProvider)) {
      return matrix([
        { metric: { spec: "ETH1", provider_address: "node-a" }, values: values(recorded) },
        { metric: { spec: "ETH1", provider_address: "Cached" }, values: values(() => 500) },
      ]);
    }
    if (query.includes("smartrouter_requests_failed_total")) {
      return matrix([{ metric: { spec: "ETH1", provider_address: "node-a" }, values: values(raw) }]);
    }
    return matrix([]);
  });
  return ranges;
}

/** A burst of 400 failed tries a stretch over `[from, to]`, quiet elsewhere. */
const burst = (from: number, to: number) => (t: number) => (t >= from && t <= to ? 400 : 0);

let app: FastifyInstance | null = null;

async function incidents(url: string) {
  app = await buildApp();
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  return res.json();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000 + 42_000);
});

afterEach(async () => {
  await app?.close();
  app = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setRecordedReads({ from: null, available: false });
});

describe("GET /api/metrics/error-incidents · failed tries from recorded series past a week", () => {
  const RECORDED_FAILED = qFailedTriesBySpecProviderRecorded("1800s");
  const RAW_FAILED = qFailedTriesBySpecProvider("1800s");
  const REPLIES = qErrorRepliesBySpecProvider("1800s");

  it("reads them at 30 days where the history reaches the step before the read; error replies stay raw", async () => {
    // The recorded burst ends the window; the raw one, three days in, must not show.
    const ranges = store({ recorded: burst(NOW - 3600, NOW), raw: burst(NOW - 27 * DAY, NOW - 27 * DAY + 3600) });
    const body = await incidents("/api/metrics/error-incidents?window=30d");
    expect(ranges.map((r) => r.query).sort()).toEqual([RECORDED_FAILED, qRecordedSamplesPerStep("1800s"), REPLIES].sort());
    for (const r of ranges) expect([r.start, r.end, r.step]).toEqual([NOW - 30 * DAY, NOW, "1800s"]);
    expect(body).toMatchObject({ from: NOW - 30 * DAY, to: NOW, stepSec: 1800, available: true, failed: [] });
    // The relay cache is left out, as on the raw read.
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ kind: "failed", providers: ["node-a"], start: NOW - 3600, end: NOW, count: 1200, ongoing: true });
  });

  it("reads them at 14 and 21 days too", async () => {
    const ranges = store();
    await incidents("/api/metrics/error-incidents?window=14d");
    await app!.inject({ method: "GET", url: "/api/metrics/error-incidents?window=21d" });
    expect(ranges.filter((r) => r.query === RECORDED_FAILED).map((r) => r.end - r.start)).toEqual([14 * DAY, 21 * DAY]);
    expect(ranges.some((r) => r.query === RAW_FAILED)).toBe(false);
  });

  it("reads raw at 30 days while the recorded series are stale or absent", async () => {
    for (const ageSec of [900, null]) {
      const ranges = store({ ageSec, raw: burst(NOW - 3600, NOW) });
      const body = await incidents("/api/metrics/error-incidents?window=30d");
      expect(ranges.map((r) => r.query).sort()).toEqual([RAW_FAILED, REPLIES].sort());
      expect(ranges.some((r) => r.query.includes(":rate2m15s"))).toBe(false);
      expect(body.lines).toHaveLength(1);
      await app!.close();
      app = null;
      vi.unstubAllGlobals();
    }
  });

  it("reads raw at 30 days when the history covers the window but not the stretch before its first point", async () => {
    const ranges = store({ historySec: 30 * DAY + 1800 });
    await incidents("/api/metrics/error-incidents?window=30d");
    expect(ranges.map((r) => r.query).sort()).toEqual([RAW_FAILED, REPLIES].sort());
  });

  it("reads raw at 7 days and below, at 5-minute steps", async () => {
    const ranges = store();
    await incidents("/api/metrics/error-incidents?window=7d");
    await app!.inject({ method: "GET", url: "/api/metrics/error-incidents?window=1d" });
    expect(ranges.map((r) => r.query)).toEqual(expect.arrayContaining([qFailedTriesBySpecProvider("300s")]));
    expect(ranges.some((r) => r.query.includes(":rate2m15s") || r.query.startsWith("max(count_over_time("))).toBe(false);
  });

  it("keeps the chain and the router scope on every recorded selector", async () => {
    const ranges = store();
    await incidents("/api/metrics/error-incidents?window=30d&spec=ETH1&router=eth-router");
    const recordedReads = ranges.filter((r) => r.query.includes(":rate2m15s"));
    expect(recordedReads).toHaveLength(2);
    const selectors = recordedReads.flatMap((r) => r.query.match(/[a-z_]+:smartrouter_[a-z_]+:rate2m15s\{[^}]*\}/g) ?? []);
    // Two families in the failed read (total twice, through `or`), one in the samples read.
    expect(selectors).toHaveLength(4);
    for (const s of selectors) {
      expect(s).toContain('spec="ETH1"');
      expect(s).toContain('router="eth-router"');
    }
  });

  it("reads raw the stretches the ruler skipped minutes of, and the counts there come from the raw read", async () => {
    // The ruler missed 8 minutes 10 days back: the recorded read holds none of
    // the burst there, the raw counters hold all of it.
    const gap = NOW - 10 * DAY;
    const ranges = store({ recorded: () => 0, raw: burst(gap, gap), samples: (t) => (t === gap ? 22 : 30) });
    const body = await incidents("/api/metrics/error-incidents?window=30d");
    expect(ranges.filter((r) => r.query === RAW_FAILED).map((r) => [r.start, r.end, r.step])).toEqual([[gap, gap, "1800s"]]);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ kind: "failed", providers: ["node-a"], start: gap, end: gap, count: 400 });
  });

  it("replaces the recorded counts of a patched stretch, and reads runs a few hours apart as one", async () => {
    // Recorded counts a burst at 10:00 and 12:00 that the raw read does not
    // hold: inside the patched run they are replaced, not added.
    const a = NOW - 5 * DAY, b = a + 4 * 3600;
    const ranges = store({ recorded: (t) => (t === a || t === a + 2 * 3600 ? 400 : 0), raw: () => 0, samples: (t) => (t === a || t === b ? 10 : 30) });
    const body = await incidents("/api/metrics/error-incidents?window=30d");
    expect(ranges.filter((r) => r.query === RAW_FAILED).map((r) => [r.start, r.end])).toEqual([[a, b]]);
    expect(body.lines).toEqual([]);
  });

  it("reads the newest stretch raw until the ruler has written all of it", async () => {
    const ranges = store({ samples: (t) => (t === NOW ? 29 : 30) });
    await incidents("/api/metrics/error-incidents?window=30d");
    expect(ranges.filter((r) => r.query === RAW_FAILED).map((r) => [r.start, r.end])).toEqual([[NOW, NOW]]);
  });

  it("reads the whole window raw once the gaps need more than eight reads", async () => {
    // Nine gaps a day apart.
    const gaps = new Set(Array.from({ length: 9 }, (_, k) => NOW - (k + 1) * DAY));
    const ranges = store({ samples: (t) => (gaps.has(t) ? 0 : 30), raw: burst(NOW - 3600, NOW) });
    const body = await incidents("/api/metrics/error-incidents?window=30d");
    expect(ranges.filter((r) => r.query === RAW_FAILED).map((r) => [r.start, r.end])).toEqual([[NOW - 30 * DAY, NOW]]);
    expect(body.lines).toHaveLength(1);
  });

  it("names the failed tries refused when the samples read or a patch read is refused", async () => {
    for (const refuse of [/^max\(count_over_time\(/, /^sum by \(spec, provider_address\) \(increase\(smartrouter_requests_failed_total/]) {
      store({ refuse, samples: (t) => (t === NOW - DAY ? 0 : 30) });
      const body = await incidents("/api/metrics/error-incidents?window=30d");
      expect(body).toMatchObject({ available: false, failed: ["failed"] });
      await app!.close();
      app = null;
      vi.unstubAllGlobals();
    }
  });
});
