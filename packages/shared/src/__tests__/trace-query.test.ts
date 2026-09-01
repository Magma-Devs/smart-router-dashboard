import { describe, it, expect } from "vitest";
import { isValidGuid, buildTraceQuery, TRACE_SEARCH_WINDOWS_SEC } from "../logql/trace-query.js";

describe("isValidGuid", () => {
  it("accepts what the router actually emits", () => {
    // strconv.FormatUint(rand.Uint64(), 10) — decimal, up to 20 digits.
    expect(isValidGuid("1")).toBe(true);
    expect(isValidGuid("8471029384710293")).toBe(true);
    expect(isValidGuid("18446744073709551615")).toBe(true); // uint64 max
  });

  it("rejects a 20-digit value that overflows uint64", () => {
    // Length alone is not enough — this is 20 digits and still not a uint64.
    expect(isValidGuid("99999999999999999999")).toBe(false);
  });

  it("rejects anything that isn't bare decimal digits", () => {
    for (const bad of ["", " ", "12 34", "0x1f", "-1", "1.0", "abc", "12\n34"]) {
      expect(isValidGuid(bad), bad).toBe(false);
    }
  });

  it("rejects the characters that would let a value break out of the query", () => {
    // The query is built by concatenation, so this is the security boundary.
    for (const bad of ['1` or `1', "1`}", '1"', "1|json", "1{a=`b`}", "1`", "${x}"]) {
      expect(isValidGuid(bad), bad).toBe(false);
    }
  });
});

describe("buildTraceQuery", () => {
  const selector = '{service="router"}';

  it("filters the raw line before parsing json", () => {
    const q = buildTraceQuery("8471029384710293", selector);
    // Loki matches bytes far more cheaply than it parses them; getting this
    // order wrong is the difference between fast and a timeout.
    expect(q.indexOf("|=")).toBeLessThan(q.indexOf("| json"));
  });

  it("matches the parsed GUID field, not just the substring", () => {
    // Without the field match, a GUID appearing inside some other field's
    // value would pull an unrelated line into the trail.
    expect(buildTraceQuery("42", selector)).toContain("| json | GUID = `42`");
  });

  it("leads with the caller's stream selector", () => {
    // Which labels a collector attaches is deployment-specific, so the
    // selector is configuration, not a constant.
    const custom = '{job="sr-router",env="staging"}';
    expect(buildTraceQuery("42", custom).startsWith(custom)).toBe(true);
  });

  it("throws rather than building a query from a non-GUID", () => {
    // Belt and braces: the route validates too, but this must never be the
    // place a bad value slips through.
    expect(() => buildTraceQuery("1` or `1", selector)).toThrow(/non-GUID/);
    expect(() => buildTraceQuery("", selector)).toThrow(/non-GUID/);
  });
});

describe("TRACE_SEARCH_WINDOWS_SEC", () => {
  it("widens, and stops at the bundled Loki's retention", () => {
    const w = [...TRACE_SEARCH_WINDOWS_SEC];
    expect(w).toEqual([...w].sort((a, b) => a - b));
    // deploy/loki-config.yml keeps 168h; looking further back finds nothing.
    expect(w.at(-1)).toBe(7 * 24 * 3600);
  });
});
