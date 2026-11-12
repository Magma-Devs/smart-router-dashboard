import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The formats, in two zones, a DST change in each.
 *
 * The module reads the zone the way a browser does - from the environment, no
 * `timeZone` named - so each zone sets `TZ` and imports a fresh copy: a
 * formatter keeps the zone it was built in.
 */

type Datetime = typeof import("@/lib/datetime");

const savedTz = process.env.TZ;
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

async function inZone(zone: string): Promise<Datetime> {
  process.env.TZ = zone;
  vi.resetModules();
  return import("@/lib/datetime");
}

const NOV_12 = "2026-11-12T12:22:07.000Z";
/** Late on Aug 9 in UTC: already Aug 10 east of it, still Aug 9 west of it. */
const AUG_9_LATE = "2026-08-09T23:30:00.000Z";

interface ZoneCase {
  zone: string;
  nov12: { time: string; timeSec: string; day: string; date: string; dayTime: string; dateTime: string; zone: string; input: string };
  aug9Late: { day: string; time: string };
  /** An instant five minutes past local midnight. */
  midnight: string;
  /** The last second before the clocks go forward, and the first after. */
  dstBefore: { t: string; dateTime: string; zone: string };
  dstAfter: { t: string; dateTime: string; zone: string };
  /** A day the change makes 23 hours long: its first and last millisecond, in UTC. */
  shortDay: { day: string; start: string; end: string };
  /** A day the change back makes 25 hours long. */
  longDay: { day: string; start: string; end: string };
}

const CASES: ZoneCase[] = [
  {
    zone: "Asia/Jerusalem",
    nov12: {
      time: "14:22", timeSec: "14:22:07", day: "Nov 12", date: "Nov 12, 2026", dayTime: "Nov 12, 14:22",
      dateTime: "Nov 12, 2026, 14:22:07 GMT+2", zone: "GMT+2", input: "2026-11-12T14:22",
    },
    aug9Late: { day: "Aug 10", time: "02:30" },
    midnight: "2026-01-01T22:05:00.000Z",
    // Israel goes forward on Friday Mar 27 2026 at 02:00, to 03:00.
    dstBefore: { t: "2026-03-26T23:59:59.000Z", dateTime: "Mar 27, 2026, 01:59:59 GMT+2", zone: "GMT+2" },
    dstAfter: { t: "2026-03-27T00:00:00.000Z", dateTime: "Mar 27, 2026, 03:00:00 GMT+3", zone: "GMT+3" },
    shortDay: { day: "2026-03-27", start: "2026-03-26T22:00:00.000Z", end: "2026-03-27T20:59:59.999Z" },
    // And back on Sunday Oct 25 at 02:00, to 01:00.
    longDay: { day: "2026-10-25", start: "2026-10-24T21:00:00.000Z", end: "2026-10-25T21:59:59.999Z" },
  },
  {
    zone: "America/New_York",
    nov12: {
      time: "07:22", timeSec: "07:22:07", day: "Nov 12", date: "Nov 12, 2026", dayTime: "Nov 12, 07:22",
      dateTime: "Nov 12, 2026, 07:22:07 GMT-5", zone: "GMT-5", input: "2026-11-12T07:22",
    },
    aug9Late: { day: "Aug 9", time: "19:30" },
    midnight: "2026-01-01T05:05:00.000Z",
    // New York goes forward on Sunday Mar 8 2026 at 02:00, to 03:00.
    dstBefore: { t: "2026-03-08T06:59:59.000Z", dateTime: "Mar 8, 2026, 01:59:59 GMT-5", zone: "GMT-5" },
    dstAfter: { t: "2026-03-08T07:00:00.000Z", dateTime: "Mar 8, 2026, 03:00:00 GMT-4", zone: "GMT-4" },
    shortDay: { day: "2026-03-08", start: "2026-03-08T05:00:00.000Z", end: "2026-03-09T03:59:59.999Z" },
    // And back on Sunday Nov 1 at 02:00, to 01:00.
    longDay: { day: "2026-11-01", start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T04:59:59.999Z" },
  },
];

describe.each(CASES)("in $zone", (c) => {
  let dt: Datetime;
  beforeAll(async () => {
    dt = await inZone(c.zone);
  });

  it("is really in that zone, the way a browser would be", () => {
    // Guards the rest: were TZ ignored, every case below would test the host's zone.
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(c.zone);
    expect(dt.zoneName()).toBe(c.zone);
  });

  it("renders every format on the reader's clock", () => {
    expect(dt.fmtTime(NOV_12)).toBe(c.nov12.time);
    expect(dt.fmtTimeSec(NOV_12)).toBe(c.nov12.timeSec);
    expect(dt.fmtDay(NOV_12)).toBe(c.nov12.day);
    expect(dt.fmtDate(NOV_12)).toBe(c.nov12.date);
    expect(dt.fmtDayTime(NOV_12)).toBe(c.nov12.dayTime);
    expect(dt.fmtDateTime(NOV_12)).toBe(c.nov12.dateTime);
    expect(dt.zoneLabel(NOV_12)).toBe(c.nov12.zone);
  });

  it("puts a late-UTC instant on the reader's own day", () => {
    expect(dt.fmtDay(AUG_9_LATE)).toBe(c.aug9Late.day);
    expect(dt.fmtTime(AUG_9_LATE)).toBe(c.aug9Late.time);
  });

  it("reads midnight as 00, never 24", () => {
    expect(dt.fmtTime(c.midnight)).toBe("00:05");
    expect(dt.fmtTimeSec(c.midnight)).toBe("00:05:00");
  });

  it("follows the clocks across a DST change, with the zone each side was in", () => {
    expect(dt.fmtDateTime(c.dstBefore.t)).toBe(c.dstBefore.dateTime);
    expect(dt.zoneLabel(c.dstBefore.t)).toBe(c.dstBefore.zone);
    expect(dt.fmtDateTime(c.dstAfter.t)).toBe(c.dstAfter.dateTime);
    expect(dt.zoneLabel(c.dstAfter.t)).toBe(c.dstAfter.zone);
  });

  it("gives a calendar day's ends where the reader is, 23 or 25 hours apart on a DST day", () => {
    expect(dt.localDayStartIso(c.shortDay.day)).toBe(c.shortDay.start);
    expect(dt.localDayEndIso(c.shortDay.day)).toBe(c.shortDay.end);
    expect(dt.localDayStartIso(c.longDay.day)).toBe(c.longDay.start);
    expect(dt.localDayEndIso(c.longDay.day)).toBe(c.longDay.end);
  });

  it("fills a datetime-local input with the reader's wall clock", () => {
    expect(dt.toLocalInputValue(NOV_12)).toBe(c.nov12.input);
    // And reading it back lands on the same minute.
    expect(new Date(dt.toLocalInputValue(NOV_12)).toISOString()).toBe("2026-11-12T12:22:00.000Z");
  });

  it("keeps the ISO value in UTC, whatever the zone", () => {
    expect(dt.isoUtc(NOV_12)).toBe(NOV_12);
    expect(dt.timeTitle(NOV_12)).toBe(`${c.nov12.dateTime}\n${NOV_12} (UTC)`);
  });

  it("dates a time over 30 days old on the reader's calendar", () => {
    const now = Date.parse(AUG_9_LATE) + 45 * 86_400_000;
    expect(dt.fmtRelative(AUG_9_LATE, now)).toBe(`${c.aug9Late.day}, 2026`);
  });
});

describe("whatever the zone", () => {
  let dt: Datetime;
  beforeAll(async () => {
    dt = await inZone("Asia/Jerusalem");
  });

  it("takes unix ms, an ISO string or a Date for the same instant", () => {
    const ms = Date.parse(NOV_12);
    expect(dt.fmtDateTime(ms)).toBe(dt.fmtDateTime(NOV_12));
    expect(dt.fmtDateTime(new Date(ms))).toBe(dt.fmtDateTime(NOV_12));
  });

  it("shows an em dash, never 'Invalid Date', for a value that is not a time", () => {
    expect(dt.fmtDateTime("not a time")).toBe("—");
    expect(dt.fmtTime(Number.NaN)).toBe("—");
    expect(dt.isoUtc("not a time")).toBe("");
    expect(dt.timeTitle("not a time")).toBe("");
    expect(dt.zoneLabel("not a time")).toBe("");
  });

  it("splits out the ISO UTC instants an audit note carries, and nothing else", () => {
    const note = "as requester, expires 2026-11-13T19:47:56.239Z; link shown to the admin";
    expect(dt.splitInstants(note)).toEqual(["as requester, expires ", "2026-11-13T19:47:56.239Z", "; link shown to the admin"]);
    expect(dt.splitInstants("at 2026-11-13T19:47:56Z")).toEqual(["at ", "2026-11-13T19:47:56Z", ""]);
    // A date alone, or a time with no zone, says nothing about the instant: left as written.
    expect(dt.splitInstants("on 2026-11-13, 19:47, 2026-11-13T19:47:56")).toHaveLength(1);
  });

  describe("fmtRelative", () => {
    const now = Date.parse(NOV_12);
    const ago = (ms: number) => dt.fmtRelative(now - ms, now);

    it("is a dash for someone who has never signed in", () => {
      expect(dt.fmtRelative(null, now)).toBe("—");
      expect(dt.fmtRelative(undefined, now)).toBe("—");
    });

    it("counts minutes, then hours, then days", () => {
      expect(ago(30_000)).toBe("just now");
      expect(ago(3 * 60_000)).toBe("3 min ago");
      expect(ago(60 * 60_000)).toBe("1 hour ago");
      expect(ago(5 * 3_600_000)).toBe("5 hours ago");
      expect(ago(86_400_000)).toBe("1 day ago");
      expect(ago(29 * 86_400_000)).toBe("29 days ago");
    });

    it("reads a time a little ahead of the clock as just now", () => {
      expect(ago(-90_000)).toBe("just now");
    });
  });
});
