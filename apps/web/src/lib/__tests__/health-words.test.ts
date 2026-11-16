import { describe, expect, it } from "vitest";
import { CAUSE_SHORT, durationWords, sinceWords } from "../health";

describe("durationWords", () => {
  it("says a length of time in the largest units that matter", () => {
    expect(durationWords(20)).toBe("under a minute");
    expect(durationWords(12 * 60)).toBe("12 min");
    expect(durationWords(2 * 3600 + 10 * 60)).toBe("2 h 10 min");
    expect(durationWords(13 * 3600 + 10 * 60)).toBe("13 h");
    expect(durationWords(3 * 86_400)).toBe("3 days");
  });
});

describe("sinceWords", () => {
  const NOW = Date.UTC(2026, 10, 16, 14, 34);

  it("names the time and how long ago; the day too once it isn't today's", () => {
    expect(sinceWords(NOW / 1000 - 130 * 60, false, NOW)).toMatch(/^since \d{2}:\d{2} \(2 h 10 min\)$/);
    expect(sinceWords(NOW / 1000 - 30 * 3600, false, NOW)).toMatch(/^since \w+ \d+, \d{2}:\d{2} \(30 h\)$/);
  });

  it("a start at the edge of the day read is only a lower bound", () => {
    expect(sinceWords(NOW / 1000 - 86_400, true, NOW)).toBe("for over 24 h");
  });

  it("is silent when not known", () => {
    expect(sinceWords(null, false, NOW)).toBeNull();
    expect(sinceWords(undefined, undefined, NOW)).toBeNull();
  });
});

describe("the words for a cause", () => {
  it("names every cause but ok in a few words", () => {
    expect(CAUSE_SHORT.ok).toBeNull();
    for (const c of ["blocked", "checks-failing", "no-checks", "no-data"] as const) expect(CAUSE_SHORT[c]).toBeTruthy();
  });
});
