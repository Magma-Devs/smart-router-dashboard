import { describe, expect, it } from "vitest";
import { STUCK_HOLD_SEC, stuckAfterSec, stuckStretches, stuckWindowSec } from "../constants/stuck.js";

describe("stuckWindowSec - the alert's quiet window per chain", () => {
  it("is five minutes for a chain the alert doesn't list", () => {
    expect(stuckWindowSec("ETH1")).toBe(300);
    expect(stuckWindowSec("SOLANA")).toBe(300);
  });

  it("is the alert's longer window for a slow chain, whatever the case", () => {
    expect(stuckWindowSec("PLASMAT")).toBe(15 * 60);
    expect(stuckWindowSec("DOGE")).toBe(30 * 60);
    expect(stuckWindowSec("LTC")).toBe(45 * 60);
    expect(stuckWindowSec("MINA")).toBe(2 * 3600);
    expect(stuckWindowSec("BTC")).toBe(3 * 3600);
    expect(stuckWindowSec("btct")).toBe(3 * 3600);
  });

  it("stuckAfterSec adds the alert's five-minute hold", () => {
    expect(STUCK_HOLD_SEC).toBe(300);
    expect(stuckAfterSec("ETH1")).toBe(600);
    expect(stuckAfterSec("BTC")).toBe(3 * 3600 + 300);
  });
});

describe("stuckStretches - where the alert would have fired", () => {
  // A point a minute; the alert fires after 10 minutes on one block.
  const STEP = 60, AFTER = 600;
  const climbing = (n: number, from = 100) => Array.from({ length: n }, (_, k) => from + k);

  it("finds a provider that stayed on one block while the chain moved on", () => {
    const ref = climbing(20);
    const tips = [100, 101, 102, ...new Array(12).fill(103), 115, 116, 117, 118, 119];
    expect(stuckStretches(tips, ref, STEP, AFTER)).toEqual([{ from: 3, to: 14, block: 103 }]);
  });

  it("ignores a pause shorter than the alert's time", () => {
    const ref = climbing(20);
    const tips = [100, 101, ...new Array(8).fill(102), ...climbing(10, 110)];
    expect(stuckStretches(tips, ref, STEP, AFTER)).toEqual([]);
  });

  it("ignores a provider that is flat because the whole chain is", () => {
    const flat = new Array(20).fill(500);
    expect(stuckStretches(flat, flat, STEP, AFTER)).toEqual([]);
  });

  it("a missing point ends a stretch - no data is not a frozen tip", () => {
    const ref = climbing(20);
    const tips = [...new Array(7).fill(100), NaN, ...new Array(7).fill(100), 115, 116, 117, 118, 119];
    expect(stuckStretches(tips, ref, STEP, AFTER)).toEqual([]);
  });

  it("finds a provider still stuck at the end of the window, and two stretches of one provider", () => {
    const ref = climbing(40);
    const tips = [...new Array(12).fill(100), 112, 113, ...new Array(26).fill(114)];
    expect(stuckStretches(tips, ref, STEP, AFTER)).toEqual([
      { from: 0, to: 11, block: 100 },
      { from: 14, to: 39, block: 114 },
    ]);
  });

  it("on a coarse grid, two points on one block are already longer than the alert's time", () => {
    // A point every 4 hours (a 30-day chart): one repeat is 4 hours on a block.
    expect(stuckStretches([10, 10, 50], [10, 30, 50], 4 * 3600, AFTER)).toEqual([{ from: 0, to: 1, block: 10 }]);
  });

  it("answers nothing for an unusable step", () => {
    expect(stuckStretches([1, 1, 1], [1, 2, 3], 0, AFTER)).toEqual([]);
  });
});
