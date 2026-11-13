import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A time axis's ticks, in two zones, across each of their 2026 DST changes.
 *
 * `timeTicks` reads the zone the way a browser does - from the environment -
 * and labels through `@/lib/datetime`, whose formatters keep the zone they
 * were built in. So each zone sets `TZ` and imports fresh copies of both, as
 * `datetime.test.ts` does.
 */

type ChartTime = typeof import("@/lib/chart-time");

const savedTz = process.env.TZ;
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

async function inZone(zone: string): Promise<ChartTime> {
  process.env.TZ = zone;
  vi.resetModules();
  return import("@/lib/chart-time");
}

const sec = (iso: string) => Date.parse(iso) / 1000;
const DAY = 86400;

/** A window of `days` ending at `end`. */
const windowTo = (end: string, days: number): [number, number] => [sec(end) - days * DAY, sec(end)];

/** The reader's wall clock at a tick: `14:00` (the zone is the process's). */
function wallClock(at: number): string {
  const d = new Date(at * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Change {
  /** The instant the clocks change. */
  at: string;
  /** A 7-day window across it: a tick at each local midnight, one label a date. */
  week: { end: string; labels: string[] };
  /** A 3-day window across it: ticks at 00:00 and 12:00, midnight labelled by its date. */
  threeDays: { end: string; labels: string[] };
  /** A 12-hour window across it: ticks every two hours on the clock. */
  halfDay: { end: string; labels: string[] };
}

interface ZoneCase {
  zone: string;
  forward: Change;
  back: Change;
}

const CASES: ZoneCase[] = [
  {
    zone: "Asia/Jerusalem",
    // Friday Mar 27 2026, 02:00 → 03:00 (GMT+2 → GMT+3).
    forward: {
      at: "2026-03-27T00:00:00.000Z",
      week: { end: "2026-03-30T12:00:00.000Z", labels: ["Mar 24", "Mar 25", "Mar 26", "Mar 27", "Mar 28", "Mar 29", "Mar 30"] },
      threeDays: { end: "2026-03-28T12:00:00.000Z", labels: ["Mar 26", "12:00", "Mar 27", "12:00", "Mar 28", "12:00"] },
      // 20:00 the evening before to 09:00: 02:00 never shows on the clock, so it has no tick.
      halfDay: { end: "2026-03-27T06:00:00.000Z", labels: ["20:00", "22:00", "00:00", "04:00", "06:00", "08:00"] },
    },
    // Sunday Oct 25 2026, 02:00 → 01:00 (GMT+3 → GMT+2).
    back: {
      at: "2026-10-24T23:00:00.000Z",
      week: { end: "2026-10-28T12:00:00.000Z", labels: ["Oct 22", "Oct 23", "Oct 24", "Oct 25", "Oct 26", "Oct 27", "Oct 28"] },
      threeDays: { end: "2026-10-26T12:00:00.000Z", labels: ["Oct 24", "12:00", "Oct 25", "12:00", "Oct 26", "12:00"] },
      // 21:00 the evening before to 08:00.
      halfDay: { end: "2026-10-25T06:00:00.000Z", labels: ["22:00", "00:00", "02:00", "04:00", "06:00", "08:00"] },
    },
  },
  {
    zone: "America/New_York",
    // Sunday Mar 8 2026, 02:00 → 03:00 (GMT-5 → GMT-4).
    forward: {
      at: "2026-03-08T07:00:00.000Z",
      week: { end: "2026-03-11T17:00:00.000Z", labels: ["Mar 5", "Mar 6", "Mar 7", "Mar 8", "Mar 9", "Mar 10", "Mar 11"] },
      threeDays: { end: "2026-03-09T18:00:00.000Z", labels: ["Mar 7", "12:00", "Mar 8", "12:00", "Mar 9", "12:00"] },
      // 20:00 the evening before to 09:00: 02:00 never shows on the clock, so it has no tick.
      halfDay: { end: "2026-03-08T13:00:00.000Z", labels: ["20:00", "22:00", "00:00", "04:00", "06:00", "08:00"] },
    },
    // Sunday Nov 1 2026, 02:00 → 01:00 (GMT-4 → GMT-5).
    back: {
      at: "2026-11-01T06:00:00.000Z",
      week: { end: "2026-11-04T17:00:00.000Z", labels: ["Oct 29", "Oct 30", "Oct 31", "Nov 1", "Nov 2", "Nov 3", "Nov 4"] },
      threeDays: { end: "2026-11-02T17:00:00.000Z", labels: ["Oct 31", "12:00", "Nov 1", "12:00", "Nov 2", "12:00"] },
      // 21:00 the evening before to 08:00.
      halfDay: { end: "2026-11-01T13:00:00.000Z", labels: ["22:00", "00:00", "02:00", "04:00", "06:00", "08:00"] },
    },
  },
];

describe.each(CASES)("in $zone", (c) => {
  let ct: ChartTime;
  beforeAll(async () => {
    ct = await inZone(c.zone);
  });

  it("is really in that zone, the way a browser would be", () => {
    // Guards the rest: were TZ ignored, every case below would test the host's zone.
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(c.zone);
  });

  describe.each([
    ["forward", c.forward],
    ["back", c.back],
  ] as const)("across the change %s", (_dir, ch) => {
    const change = sec(ch.at);

    /** Ticks on both sides of the change, so a case can't pass on one side alone. */
    const spansIt = (ticks: { at: number }[]) => {
      expect(ticks.some((t) => t.at < change)).toBe(true);
      expect(ticks.some((t) => t.at >= change)).toBe(true);
    };

    it("puts a 7-day axis's ticks on each local midnight, a date on every day", () => {
      const ticks = ct.timeTicks(windowTo(ch.week.end, 7))!;
      spansIt(ticks);
      expect(ticks.map((t) => wallClock(t.at))).toEqual(ch.week.labels.map(() => "00:00"));
      expect(ticks.map((t) => t.label)).toEqual(ch.week.labels);
    });

    it("puts a 3-day axis's ticks at 00:00 and 12:00 on each side", () => {
      const ticks = ct.timeTicks(windowTo(ch.threeDays.end, 3))!;
      spansIt(ticks);
      expect(ticks.map((t) => wallClock(t.at))).toEqual(ch.threeDays.labels.map((_, i) => (i % 2 ? "12:00" : "00:00")));
      expect(ticks.map((t) => t.label)).toEqual(ch.threeDays.labels);
    });

    it("puts a 12-hour axis's ticks on even hours of the clock, and none on an hour it skips", () => {
      const ticks = ct.timeTicks([sec(ch.halfDay.end) - DAY / 2, sec(ch.halfDay.end)])!;
      spansIt(ticks);
      expect(ticks.map((t) => wallClock(t.at))).toEqual(ch.halfDay.labels);
      expect(ticks.map((t) => t.label)).toEqual(ch.halfDay.labels);
    });
  });

  it("keeps a window with no change on round times, as before", () => {
    // Mid-January, far from either change.
    const ticks = ct.timeTicks(windowTo("2026-01-15T12:34:00.000Z", 1))!;
    expect(ticks.map((t) => wallClock(t.at)).every((w) => ["00:00", "06:00", "12:00", "18:00"].includes(w))).toBe(true);
    expect(ticks).toHaveLength(4);
  });
});

describe("whatever the zone", () => {
  it("aligns to the reader's clock where its offset isn't whole hours", async () => {
    const ct = await inZone("Asia/Kathmandu"); // GMT+5:45, no DST
    const ticks = ct.timeTicks([sec("2026-11-12T12:00:00.000Z"), sec("2026-11-12T13:00:00.000Z")])!;
    expect(ticks.map((t) => t.label)).toEqual(["17:50", "18:00", "18:10", "18:20", "18:30", "18:40"]);
  });

  it("has no ticks without a window", async () => {
    const ct = await inZone("Asia/Jerusalem");
    expect(ct.timeTicks(undefined)).toBeUndefined();
  });
});
