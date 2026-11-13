import { afterEach, describe, expect, it } from "vitest";
import { emailTime } from "../services/email-time.js";

/**
 * How an email states a time. Every time an email prints goes through
 * `emailTime`, so these pin the one format they all share.
 */

const savedTz = process.env.TZ;
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("emailTime", () => {
  it.each([
    ["2026-11-13T09:14:59.999Z", "Nov 13, 2026, 09:14 UTC"],
    ["2026-11-11T14:05:42.000Z", "Nov 11, 2026, 14:05 UTC"],
    // Midnight is 00, never 24; a single-digit day has no leading zero.
    ["2027-01-01T00:03:00.000Z", "Jan 1, 2027, 00:03 UTC"],
    ["2026-09-30T23:59:00.000Z", "Sep 30, 2026, 23:59 UTC"],
    ["2026-03-06T04:59:00.000Z", "Mar 6, 2026, 04:59 UTC"],
  ])("writes %s as %s", (iso, expected) => {
    expect(emailTime(new Date(iso))).toBe(expected);
  });

  it("names every month as the dashboard does", () => {
    const months = Array.from({ length: 12 }, (_, m) => emailTime(new Date(Date.UTC(2026, m, 15, 12))).slice(0, 3));
    expect(months).toEqual(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
  });

  it("reads as the dashboard's date and 24-hour clock would in UTC, with the zone named", () => {
    // The dashboard's format (apps/web/src/lib/datetime.ts), pinned to UTC.
    const dashboard = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    });
    for (const iso of ["2026-11-13T09:14:00Z", "2027-01-01T00:03:00Z", "2026-07-04T18:30:00Z", "2026-12-31T23:59:00Z"]) {
      const at = new Date(iso);
      expect(emailTime(at)).toBe(`${dashboard.format(at)} UTC`);
    }
  });

  it.each(["Pacific/Kiritimati", "America/New_York", "Asia/Jerusalem"])(
    "states UTC whatever zone the server runs in (%s)",
    (zone) => {
      // 23:59 in New York on Mar 5 is 04:59 UTC on the 6th; a local clock
      // would read the 5th in New York, or the 6th at 18:59 at UTC+14.
      process.env.TZ = zone;
      expect(emailTime(new Date("2026-03-05T23:59:00-05:00"))).toBe("Mar 6, 2026, 04:59 UTC");
    },
  );

  it("writes an em dash, never 'NaN', for a Date that is not a time", () => {
    expect(emailTime(new Date("not a time"))).toBe("—");
  });
});
