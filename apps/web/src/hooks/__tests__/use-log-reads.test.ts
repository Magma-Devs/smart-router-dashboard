import { describe, expect, it } from "vitest";
import { LIVE_READ_MS, missesAfter, nextReadMs } from "../use-log-reads";

/**
 * How often a log list reads again. Each read of the router's logs scans the
 * stretch it covers, so a live list reads every 30 s, and backs off while the
 * logs don't answer instead of asking a struggling store twice a minute per
 * viewer.
 */
describe("nextReadMs", () => {
  it("a live list every 30 s; a closed one never", () => {
    expect(nextReadMs(true, 0)).toBe(LIVE_READ_MS);
    expect(LIVE_READ_MS).toBe(30_000);
    expect(nextReadMs(false, 0)).toBe(0);
    expect(nextReadMs(false, 3)).toBe(0);
  });

  it("after reads the logs couldn't answer: 60 s, 120 s, 240 s, then 5 minutes", () => {
    expect([1, 2, 3, 4, 5, 9].map((misses) => nextReadMs(true, misses))).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  });
});

describe("missesAfter", () => {
  it("counts each read the logs didn't answer, and starts over once one does", () => {
    expect(missesAfter(0, { data: { available: false } })).toBe(1);
    expect(missesAfter(2, { data: { available: false } })).toBe(3);
    expect(missesAfter(4, { data: { available: true } })).toBe(0);
  });

  it("leaves an API error to SWR's own retries, and a read that brought no answer changes nothing", () => {
    expect(missesAfter(2, { data: { available: false }, error: new Error("502") })).toBe(2);
    expect(missesAfter(2, {})).toBe(2);
  });
});
