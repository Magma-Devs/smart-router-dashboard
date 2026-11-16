import { describe, expect, it } from "vitest";
import { DOWNTIME_AVOIDED_RULES, downtimeAvoided, downtimeAvoidedRead, type ServedStretch } from "../constants/downtime-avoided.js";
import { detectErrorIncidents, type ErrorIncidentSeries } from "../constants/error-incidents.js";

const STEP = 300;
const T0 = 1_700_000_000 - (1_700_000_000 % STEP);
const N = 288;
const at = (k: number) => T0 + k * STEP;
const END = at(N - 1);

/** A day of 5-minute stretches of failed tries: `bursts` of [fromStretch, toStretch, count], else 0. */
function failed(spec: string, provider: string, bursts: [number, number, number][]): ErrorIncidentSeries {
  return {
    kind: "failed", spec, provider,
    points: Array.from({ length: N }, (_, k) => [at(k), bursts.find(([a, z]) => k >= a && k <= z)?.[2] ?? 0] as [number, number]),
  };
}
/** What clients got on a chain: `requests` every stretch, `failed` in the stretches named. */
function served(chain: string, requests: number, bad: Record<number, number> = {}): [string, Map<number, ServedStretch>] {
  return [chain, new Map(Array.from({ length: N }, (_, k) => [at(k), { requests, failed: bad[k] ?? 0 }]))];
}
function run(series: ErrorIncidentSeries[], servedBy: [string, Map<number, ServedStretch>][] | null, windowFrom = T0) {
  const { lines } = detectErrorIncidents(series, STEP, T0, END, windowFrom);
  return downtimeAvoided({ lines, series, stepSec: STEP, windowFrom, to: END, served: servedBy ? new Map(servedBy) : null });
}

describe("downtimeAvoided", () => {
  it("counts the stretches a provider was failing while its chain kept answering", () => {
    // tatum fails for 4 stretches (20 minutes) on ETH1; every client request is answered.
    expect(run([failed("ETH1", "tatum", [[100, 103, 50]])], [served("ETH1", 10_000)])).toEqual({
      seconds: 4 * STEP, notAvoidedSeconds: 0, incidents: 1, chains: 1, strict: true, chainNames: ["ETH1"],
    });
  });

  it("does not count a stretch where the chain's own requests failed past the rule", () => {
    // In stretch 101, 1% of the chain's requests failed: the router did not cover that one.
    const r = run([failed("ETH1", "tatum", [[100, 103, 50]])], [served("ETH1", 10_000, { 101: 100 })]);
    expect(r).toMatchObject({ seconds: 3 * STEP, notAvoidedSeconds: STEP, incidents: 1, chains: 1 });
    // At the rule exactly (0.1% failed) the stretch still counts.
    expect(DOWNTIME_AVOIDED_RULES.minAnswered).toBe(0.999);
    expect(run([failed("ETH1", "tatum", [[100, 103, 50]])], [served("ETH1", 10_000, { 101: 10 })]).seconds).toBe(4 * STEP);
  });

  it("counts a stretch once per chain, however many providers failed in it, and each chain on its own", () => {
    const r = run(
      [failed("ETH1", "tatum", [[100, 103, 50]]), failed("ETH1", "lava", [[102, 105, 50]]), failed("BASE", "tatum", [[100, 101, 50]])],
      [served("ETH1", 5_000), served("BASE", 5_000)],
    );
    // ETH1: stretches 100..105 = 6; BASE: 100..101 = 2.
    expect(r.seconds).toBe(8 * STEP);
    expect(r.chains).toBe(2);
  });

  it("a chain with no client request in the stretch counts neither way: nothing was at stake", () => {
    const r = run([failed("ETH1", "tatum", [[100, 103, 50]])], [["ETH1", new Map([[at(100), { requests: 500, failed: 0 }]])]]);
    expect(r).toMatchObject({ seconds: STEP, notAvoidedSeconds: 0 });
    expect(run([failed("ETH1", "tatum", [[100, 103, 50]])], [served("BASE", 500)])).toMatchObject({ seconds: 0, incidents: 0, chains: 0, strict: true });
  });

  it("without recorded outcomes it is the time a provider was failing, and says it isn't strict", () => {
    expect(run([failed("ETH1", "tatum", [[100, 103, 50]])], null)).toEqual({
      seconds: 4 * STEP, notAvoidedSeconds: 0, incidents: 1, chains: 1, strict: false, chainNames: ["ETH1"],
    });
  });

  it("leaves out what is before the window, error replies, and failures under a burst", () => {
    // The burst spans stretches 100..103; the window starts at stretch 101's end, so 102 and 103 count.
    expect(run([failed("ETH1", "tatum", [[100, 103, 50]])], [served("ETH1", 5_000)], at(101)).seconds).toBe(2 * STEP);
    const replies: ErrorIncidentSeries = { ...failed("ETH1", "tatum", [[100, 103, 500]]), kind: "reply" };
    expect(run([replies], [served("ETH1", 5_000)]).seconds).toBe(0);
    // 9 failed tries in 5 minutes is under the burst floor: not provider trouble.
    expect(run([failed("ETH1", "tatum", [[100, 103, 9]])], [served("ETH1", 5_000)]).seconds).toBe(0);
  });
});

describe("downtimeAvoidedRead", () => {
  const END = 1_800_000_000; // a multiple of 300 s
  const DAY = 86_400;

  it("reads a window up to a week in one piece, a day back at least, at a minute up to 3 hours and 5 minutes beyond", () => {
    expect(downtimeAvoidedRead(1800, END)).toEqual({ stepSec: 60, pieces: [{ readFrom: END - DAY, from: END - 1800, to: END }] });
    expect(downtimeAvoidedRead(7 * DAY, END)).toEqual({ stepSec: 300, pieces: [{ readFrom: END - 7 * DAY, from: END - 7 * DAY, to: END }] });
  });

  it("reads a longer window in equal pieces of a week at most, still at 5 minutes, covering it once", () => {
    const { stepSec, pieces } = downtimeAvoidedRead(30 * DAY, END);
    expect(stepSec).toBe(300);
    expect(pieces).toHaveLength(5);
    expect(pieces[0]!.from).toBe(END - 30 * DAY);
    expect(pieces[4]!.to).toBe(END);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]!.from).toBe(pieces[i - 1]!.to);
    for (const p of pieces) {
      expect(p.to - p.from).toBeLessThanOrEqual(DOWNTIME_AVOIDED_RULES.maxPieceSec);
      expect(p.readFrom).toBeLessThanOrEqual(p.from);
    }
    expect(downtimeAvoidedRead(14 * DAY, END).pieces).toHaveLength(2);
  });
});
