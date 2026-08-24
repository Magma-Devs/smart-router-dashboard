import { describe, expect, it } from "vitest";
import { fmtAgo } from "../format";

/** `now` is injectable precisely so this isn't a clock race. */
describe("fmtAgo", () => {
  const now = Date.parse("2026-08-21T12:00:00Z");

  it.each([
    ["2026-08-21T11:59:31Z", "just now"],
    ["2026-08-21T11:57:00Z", "3m ago"],
    ["2026-08-21T09:00:00Z", "3h ago"],
    ["2026-08-19T12:00:00Z", "2d ago"],
  ])("reads %s as %s", (iso, expected) => {
    expect(fmtAgo(iso, now)).toBe(expected);
  });

  it("renders nothing rather than a wrong number for a missing or bad stamp", () => {
    expect(fmtAgo(null, now)).toBe("—");
    expect(fmtAgo(undefined, now)).toBe("—");
    expect(fmtAgo("not a date", now)).toBe("—");
  });

  it("never reads a clock-skewed future stamp as a negative age", () => {
    expect(fmtAgo("2026-08-21T12:05:00Z", now)).toBe("just now");
  });
});
