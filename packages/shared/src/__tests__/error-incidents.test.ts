import { describe, expect, it } from "vitest";
import { ERROR_INCIDENT_RULES, detectErrorIncidents, errorIncidentsRead, type ErrorIncidentSeries } from "../constants/error-incidents.js";

const STEP = 300;
const T0 = 1_700_000_000 - (1_700_000_000 % STEP);
/** A day of 5-minute stretches, all quiet. */
const N = 288;
const at = (k: number) => T0 + k * STEP;
const END = at(N - 1);

/** A series that is `base` everywhere, with `bursts` of [fromStretch, toStretch, count]. */
function series(kind: "failed" | "reply", spec: string, provider: string, bursts: [number, number, number][], base = 0): ErrorIncidentSeries {
  const pts: [number, number][] = [];
  for (let k = 0; k < N; k++) {
    const b = bursts.find(([a, z]) => k >= a && k <= z);
    pts.push([at(k), b ? b[2] : base]);
  }
  return { kind, spec, provider, points: pts };
}
const detect = (s: ErrorIncidentSeries[], windowFrom?: number) => detectErrorIncidents(s, STEP, T0, END, windowFrom);

describe("detectErrorIncidents", () => {
  it("one burst at one provider is one incident, with its span and count", () => {
    const { lines } = detect([series("failed", "NEAR", "blockdaemon", [[100, 103, 50]])]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ shape: "incident", providers: ["blockdaemon"], start: at(100), end: at(103), count: 200, peak: 50, ongoing: false });
    expect(lines[0]!.chains).toEqual([{ spec: "NEAR", count: 200 }]);
  });

  it("ignores bumps under the floor, however far above the usual level", () => {
    const { lines } = detect([series("failed", "NEAR", "lava", [[100, 101, 9]])]);
    expect(lines).toEqual([]);
  });

  it("ignores a provider at its usual level, however high: that is the background", () => {
    const { lines, steady } = detect([series("reply", "CARDANO", "blockfrost", [[100, 101, 600]], 300)]);
    expect(lines).toEqual([]);
    expect(steady).toEqual([{ kind: "reply", spec: "CARDANO", provider: "blockfrost", perMinute: 60, presence: 1 }]);
  });

  it("joins hot stretches 15 minutes apart, and the same provider on several chains, into one incident", () => {
    const { lines } = detect([
      series("failed", "NEAR", "blockdaemon", [[100, 101, 40], [105, 106, 40]]),
      series("failed", "POLKADOTASSETHUB", "blockdaemon", [[102, 102, 30]]),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.chains.map((c) => c.spec)).toEqual(["NEAR", "POLKADOTASSETHUB"]);
    expect(lines[0]!.waves).toHaveLength(1);
  });

  it("a gap over 15 minutes starts a new wave; the same cause within 3 hours stays one line", () => {
    const { lines } = detect([series("failed", "SOLANAT", "lava", [[100, 101, 40], [110, 111, 40]])]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.waves).toHaveLength(2);
    expect(lines[0]!.shape).toBe("incident");
  });

  it("three waves or more read as recurring; a repeat over 3 hours later is its own line", () => {
    const waves: [number, number, number][] = [[10, 11, 40], [20, 21, 40], [30, 31, 40]];
    const far = 31 + ERROR_INCIDENT_RULES.repeatSec / STEP + 10;
    const { lines } = detect([series("failed", "TRXT", "tatum", [...waves, [far, far + 1, 40]])]);
    expect(lines.map((l) => [l.shape, l.waves.length]).sort()).toEqual([["incident", 1], ["recurring", 3]]);
  });

  it("two providers of one chain at the same time are one chain-wide line", () => {
    const { lines } = detect([
      series("reply", "XLMT", "blockdaemon", [[100, 104, 200]]),
      series("reply", "XLMT", "lava", [[101, 104, 200]]),
      series("reply", "XLMT", "tatum", [[100, 103, 200]]),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ shape: "chain-wide", providers: ["blockdaemon", "lava", "tatum"] });
  });

  it("a long burst stays long-running and swallows nothing else on its chains", () => {
    const { lines } = detect([
      series("reply", "HOD1", "tatum", [[10, 10 + ERROR_INCIDENT_RULES.longSec / STEP, 5000]]),
      series("reply", "HOD1", "lava", [[40, 41, 200]]),
    ]);
    expect(lines.map((l) => [l.shape, l.providers.join()]).sort()).toEqual([["incident", "lava"], ["long-running", "tatum"]]);
  });

  it("is long-running from exactly 6 hours, counting the first stretch's own 5 minutes", () => {
    const stretches = ERROR_INCIDENT_RULES.longSec / STEP; // 72 stretches of 5 minutes = 6 hours
    const shape = (n: number) => detect([series("failed", "NEAR", "lava", [[10, 10 + n - 1, 40]])]).lines.map((l) => l.shape);
    expect(shape(stretches)).toEqual(["long-running"]);
    expect(shape(stretches - 1)).toEqual(["incident"]);
  });

  it("a line with a 6-hour wave is long-running, even when a short repeat joins it", () => {
    const long = ERROR_INCIDENT_RULES.longSec / STEP;
    const { lines } = detect([series("failed", "NEAR", "lava", [[10, 10 + long, 40], [10 + long + 20, 10 + long + 21, 40]])]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.waves).toHaveLength(2);
    expect(lines[0]!.shape).toBe("long-running");
  });

  it("keeps failed tries and error replies apart", () => {
    const { lines } = detect([series("failed", "NEAR", "blockdaemon", [[100, 101, 40]]), series("reply", "NEAR", "blockdaemon", [[100, 101, 400]])]);
    expect(lines.map((l) => l.kind).sort()).toEqual(["failed", "reply"]);
  });

  it("marks a line still going at the newest stretch, lists it first, and leaves out lines ended before the window", () => {
    const { lines } = detect([series("failed", "NEAR", "lava", [[N - 3, N - 1, 40]]), series("failed", "BTC", "blockdaemon", [[20, 21, 40]])], at(200));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ongoing: true, providers: ["lava"] });
  });

  it("scales the floor to the read's step", () => {
    const one = (v: number) => detectErrorIncidents([{ kind: "failed", spec: "X", provider: "p", points: Array.from({ length: 600 }, (_, k) => [T0 + k * 60, k >= 300 && k < 310 ? v : 0] as [number, number]) }], 60, T0, T0 + 599 * 60);
    expect(one(2).lines).toHaveLength(1);
    expect(one(1).lines).toHaveLength(0);
  });

  it("needs 20 failed tries or 100 error replies in all, whatever the step", () => {
    // Minutes at 5 failed tries each: hot at a 1-minute step (floor 2), and a line only from 20 in all.
    const minutes = (kind: "failed" | "reply", n: number, v: number) =>
      detectErrorIncidents([{ kind, spec: "X", provider: "p", points: Array.from({ length: 600 }, (_, k) => [T0 + k * 60, k >= 300 && k < 300 + n ? v : 0] as [number, number]) }], 60, T0, T0 + 599 * 60).lines;
    expect(minutes("failed", 3, 5)).toEqual([]);
    expect(minutes("failed", 4, 5)).toHaveLength(1);
    expect(minutes("reply", 9, 11)).toEqual([]);
    expect(minutes("reply", 10, 10)).toHaveLength(1);
    // At 5-minute steps one hot stretch at the floor is not yet a line; twice the floor is.
    expect(detect([series("failed", "NEAR", "lava", [[100, 100, 19]])]).lines).toEqual([]);
    expect(detect([series("failed", "NEAR", "lava", [[100, 100, 20]])]).lines).toHaveLength(1);
    expect(ERROR_INCIDENT_RULES.minCount).toEqual({ failed: 20, reply: 100 });
  });

  it("keeps a line that reaches into the window, and leaves out one whose last stretch ends as it opens", () => {
    const edge = (lastStretch: number) => detect([series("failed", "NEAR", "lava", [[lastStretch - 1, lastStretch, 40]])], at(200)).lines.length;
    expect(edge(200)).toBe(0);
    expect(edge(201)).toBe(1);
  });

  it("answers the same whatever order the store lists the series in, ties included", () => {
    const input = [
      // node-a errs on two chains as much on each: its main chain is the first by name, NEAR.
      series("failed", "NEAR", "node-a", [[100, 101, 40]]),
      series("failed", "SOLANA", "node-a", [[100, 101, 40]]),
      series("failed", "NEAR", "node-b", [[100, 101, 40]]),
      // Two lines ending together, and two always-present series at one rate.
      series("reply", "BTC", "node-c", [[50, 51, 400]]),
      series("reply", "ETH1", "node-d", [[50, 51, 400]]),
      series("failed", "BASE", "node-e", [], 3),
      series("failed", "BASE", "node-f", [], 3),
    ];
    const want = detect(input);
    expect(want.lines.find((l) => l.shape === "chain-wide")).toMatchObject({ providers: ["node-a", "node-b"], chains: [{ spec: "NEAR", count: 160 }, { spec: "SOLANA", count: 80 }] });
    expect(want.lines.filter((l) => l.kind === "reply").map((l) => l.providers[0])).toEqual(["node-c", "node-d"]);
    expect(want.steady.map((s) => s.provider)).toEqual(["node-e", "node-f"]);
    for (const order of [[...input].reverse(), [...input.slice(3), ...input.slice(0, 3)], [input[2]!, input[1]!, input[0]!, ...input.slice(3).reverse()]]) {
      expect(detect(order)).toEqual(want);
    }
  });

  it("reads points on the read's grid only, and answers nothing for a step that is not one", () => {
    const off = { kind: "failed" as const, spec: "NEAR", provider: "node-a", points: [[at(100) + 7, 500], [at(101) + 7, 500]] as [number, number][] };
    expect(detect([off]).lines).toEqual([]);
    const s = series("failed", "NEAR", "node-a", [[100, 101, 40]]);
    expect(detectErrorIncidents([s], 0, T0, END)).toEqual({ lines: [], steady: [] });
    expect(detectErrorIncidents([s], STEP, END, T0)).toEqual({ lines: [], steady: [] });
  });
});

describe("detectErrorIncidents · the rules' boundaries", () => {
  const R = ERROR_INCIDENT_RULES;
  const one = (s: ErrorIncidentSeries, windowFrom?: number) => detect([s], windowFrom).lines;

  it("is hot from exactly 3x the usual level, and from exactly the floor", () => {
    // Usually 20 a stretch: 60 is three times that, 59 is not.
    expect(one(series("failed", "NEAR", "node-a", [[100, 100, 60]], 20))).toHaveLength(1);
    expect(one(series("failed", "NEAR", "node-a", [[100, 100, 59]], 20))).toEqual([]);
    // Nothing usual: the floor decides, 10 failed tries or 50 error replies a stretch.
    expect(one(series("failed", "NEAR", "node-a", [[100, 101, 10]]))).toHaveLength(1);
    expect(one(series("failed", "NEAR", "node-a", [[100, 101, 9]]))).toEqual([]);
    expect(one(series("reply", "NEAR", "node-a", [[100, 101, 50]]))).toHaveLength(1);
    expect(one(series("reply", "NEAR", "node-a", [[100, 101, 49]]))).toEqual([]);
  });

  it("reads nothing into a series with no errors, or no points, or no series", () => {
    expect(detect([series("failed", "NEAR", "node-a", [])])).toEqual({ lines: [], steady: [] });
    expect(detect([{ kind: "failed", spec: "NEAR", provider: "node-a", points: [] }])).toEqual({ lines: [], steady: [] });
    expect(detect([])).toEqual({ lines: [], steady: [] });
  });

  it("joins two hot stretches up to 15 minutes apart into one wave; 20 minutes apart are two", () => {
    const gapStretches = R.gapSec / STEP; // 3
    const waves = (apart: number) => one(series("failed", "NEAR", "node-a", [[100, 100, 40], [100 + apart, 100 + apart, 40]]))[0]!.waves.length;
    expect(waves(gapStretches)).toBe(1);
    expect(waves(gapStretches + 1)).toBe(2);
  });

  it("keeps a repeat exactly 3 hours after the last wave on its line; a stretch later it is a new line", () => {
    const repeat = R.repeatSec / STEP; // 36 stretches
    const lines = (after: number) => one(series("failed", "NEAR", "node-a", [[10, 11, 40], [11 + after, 12 + after, 40]]));
    expect(lines(repeat).map((l) => l.waves.length)).toEqual([2]);
    expect(lines(repeat + 1).map((l) => l.waves.length)).toEqual([1, 1]);
  });

  it("reads two waves as a burst, three as recurring", () => {
    const shape = (n: number) => one(series("failed", "NEAR", "node-a", Array.from({ length: n }, (_, i) => [10 + 10 * i, 11 + 10 * i, 40] as [number, number, number])))[0]!.shape;
    expect(shape(R.recurringWaves - 1)).toBe("incident");
    expect(shape(R.recurringWaves)).toBe("recurring");
  });

  it("lists a series as always present past half its stretches, not at exactly half", () => {
    // Under the floor all along: background, never a line.
    const steady = (present: number) => detect([series("failed", "BASE", "node-a", [[0, present - 1, 1]])]).steady;
    expect(steady(N / 2)).toEqual([]);
    expect(steady(N / 2 + 1)).toEqual([{ kind: "failed", spec: "BASE", provider: "node-a", perMinute: 0.2, presence: (N / 2 + 1) / N }]);
  });

  it("is still going when its last stretch is the newest one or the one before", () => {
    const ongoing = (last: number) => one(series("failed", "NEAR", "node-a", [[last - 1, last, 40]]))[0]!.ongoing;
    expect(ongoing(N - 1)).toBe(true);
    expect(ongoing(N - 2)).toBe(true);
    expect(ongoing(N - 3)).toBe(false);
  });

  it("keeps a line that began before the window, from where it began", () => {
    const [line] = one(series("failed", "NEAR", "node-a", [[190, 210, 40]]), at(200));
    expect(line).toMatchObject({ start: at(190), end: at(210), count: 21 * 40 });
  });

  it("is chain-wide only for two providers of one chain, of one kind, at the same time", () => {
    const shapes = (s: ErrorIncidentSeries[]) => detect(s).lines.map((l) => [l.shape, l.providers.join()]).sort();
    // Another chain at the same time: two bursts.
    expect(shapes([series("failed", "NEAR", "node-a", [[100, 101, 40]]), series("failed", "BTC", "node-b", [[100, 101, 40]])]))
      .toEqual([["incident", "node-a"], ["incident", "node-b"]]);
    // One chain, an hour apart: two bursts.
    expect(shapes([series("failed", "NEAR", "node-a", [[100, 101, 40]]), series("failed", "NEAR", "node-b", [[113, 114, 40]])]))
      .toEqual([["incident", "node-a"], ["incident", "node-b"]]);
    // One chain at once, but failed tries at one and error replies at the other: two bursts.
    expect(shapes([series("failed", "NEAR", "node-a", [[100, 101, 40]]), series("reply", "NEAR", "node-b", [[100, 101, 400]])]))
      .toEqual([["incident", "node-a"], ["incident", "node-b"]]);
    // A stretch apart still counts as the same time.
    expect(shapes([series("failed", "NEAR", "node-a", [[100, 101, 40]]), series("failed", "NEAR", "node-b", [[102, 103, 40]])]))
      .toEqual([["chain-wide", "node-a,node-b"]]);
  });
});

describe("errorIncidentsRead", () => {
  it("reads at least a day back, at a step that keeps the read small", () => {
    expect(errorIncidentsRead(1800)).toEqual({ stepSec: 60, readSeconds: 86400 });
    expect(errorIncidentsRead(10800)).toEqual({ stepSec: 60, readSeconds: 86400 });
    expect(errorIncidentsRead(86400)).toEqual({ stepSec: 300, readSeconds: 86400 });
    expect(errorIncidentsRead(7 * 86400)).toEqual({ stepSec: 300, readSeconds: 7 * 86400 });
    expect(errorIncidentsRead(30 * 86400)).toEqual({ stepSec: 1800, readSeconds: 30 * 86400 });
  });
});
