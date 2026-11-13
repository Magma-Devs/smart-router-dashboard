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
    const one = (v: number) => detectErrorIncidents([{ kind: "failed", spec: "X", provider: "p", points: Array.from({ length: 600 }, (_, k) => [T0 + k * 60, k >= 300 && k < 303 ? v : 0] as [number, number]) }], 60, T0, T0 + 599 * 60);
    expect(one(2).lines).toHaveLength(1);
    expect(one(1).lines).toHaveLength(0);
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
