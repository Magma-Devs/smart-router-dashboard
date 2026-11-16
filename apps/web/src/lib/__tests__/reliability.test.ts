import { describe, expect, it } from "vitest";
import { answeredWords, incidentsWords, spanWords } from "../reliability";

describe("answeredWords", () => {
  it("never reads 100% while a request failed", () => {
    // 2,397 failed of 215.46M: two decimals would say 100.00%.
    expect(answeredWords(215_462_876, 2_397)).toEqual({ value: "99.9989%", sub: "of 215.47M requests" });
    expect(answeredWords(1_000, 10)).toEqual({ value: "99.01%", sub: "of 1.0K requests" });
    expect(answeredWords(51_380_000, 3)?.value).toBe("99.99999%");
    expect(answeredWords(900_000_000, 3)?.value).toBe("under 100%");
    expect(answeredWords(900_000_000, 3)?.sub).toBe("of 900.00M requests");
  });

  it("says 100% only when none failed, and nothing with no requests", () => {
    expect(answeredWords(5_000, 0)).toEqual({ value: "100%", sub: "of 5.0K requests" });
    expect(answeredWords(0, 0)).toBeNull();
  });
});

describe("spanWords", () => {
  it("says a length of time in the two largest units", () => {
    expect(spanWords(0)).toBe("0 min");
    expect(spanWords(12 * 60)).toBe("12 min");
    expect(spanWords(1_180 * 60)).toBe("19 h 40 min");
    expect(spanWords(2 * 3600)).toBe("2 h");
    expect(spanWords(76 * 3600)).toBe("3 days 4 h");
    expect(spanWords(72 * 3600)).toBe("3 days");
  });
});

describe("incidentsWords", () => {
  it("counts incidents and chains, singular where it is one", () => {
    expect(incidentsWords(38, 11)).toBe("38 incidents on 11 chains");
    expect(incidentsWords(1, 1)).toBe("1 incident on 1 chain");
  });
});
