import { describe, expect, it } from "vitest";
import { routerLogsInput, routerLogQuery } from "../services/ask/router-logs.js";
import { assertAskRead } from "../services/ask/mcp.js";
import { askQueryLookbackSeconds } from "../services/ask/query-bounds.js";
const end = Math.floor(Date.now() / 1000);
const defaults = { start: end - 1800, end };
describe("bounded router event sampling", () => {
  it("reads the customer's own request events with a small backwards sample", () => {
    const parameters = routerLogQuery("nimrod-test", {}, defaults)!;
    expect(parameters).toMatchObject({ ...defaults, limit: 20, direction: "backward" });
    const [selector, filter] = parameters.query.split(" |= ");
    expect(selector).toBe('{service_name=~"nimrod-test-.*"}');
    expect(JSON.parse(filter!)).toBe('"event":"relay_end"');
    expect(() => assertAskRead("logs.query_range", parameters)).not.toThrow();
  });
  it("reads a named historical window given in ISO 8601", () => {
    const parameters = routerLogQuery(
      "nimrod-test",
      routerLogsInput.parse({ from: "2026-11-13T22:56:00Z", to: "2026-11-14T00:25:00Z" }),
      defaults,
    )!;
    expect(parameters).toMatchObject({ start: 1794610560, end: 1794615900 });
    expect(() => assertAskRead("logs.query_range", parameters)).not.toThrow();
  });
  it("narrows the stream selector to the normalized chain", () => {
    expect(routerLogQuery("nimrod-test", { chain: "ETH1" }, defaults)?.query).toContain(
      'chain="eth1"',
    );
  });
  it.each([
    { chain: 'ETH1"}' },
    { sourceId: "https://other.test" },
    { limit: 101 },
    { tenantId: "other" },
    { headers: {} },
  ])("denies malformed scope/limits %#", (input) => {
    expect(routerLogsInput.safeParse(input).success).toBe(false);
  });
  it("does not allow a foreign customer selector or an unbounded window", () => {
    expect(routerLogQuery("other.*", {}, defaults)).toBeNull();
    expect(routerLogQuery("nimrod-test", { start: end - 86401, end }, defaults)).toBeNull();
    // A count may run 30 days; a sample of raw lines stays at a day.
    expect(routerLogQuery("nimrod-test", { start: end - 7 * 86400, end }, defaults)).toBeNull();
  });
});
describe("query provenance uses the audited literal-range parser", () => {
  it.each([
    ["up", 0],
    ["rate(up[5m])", 300],
    ["sum(rate(up[1h])) + sum(rate(other[2h]))", 7200],
    ['up{note="[9d]"}', 0],
    ["up[5m] offset 1d", null],
    ["up[25h]", null],
    ["up[30d]", null],
    ["up[1h:5m]", null],
  ])("reports the actual lookback for %s", (query, expected) => {
    expect(askQueryLookbackSeconds(String(query))).toBe(expected);
  });
});
describe("metrics and logs carry their own lookback", () => {
  it("lets a metrics query sum 30 days and keeps a log query at 24 hours", () => {
    expect(() =>
      assertAskRead("metrics.query", { query: "sum(sum_over_time(x:count1m[30d]))" }),
    ).not.toThrow();
    expect(() =>
      assertAskRead("metrics.query", { query: "sum(sum_over_time(x:count1m[31d]))" }),
    ).toThrow();
    expect(() =>
      assertAskRead("logs.query", { query: 'count_over_time({app="r"}[25h])' }),
    ).toThrow();
    expect(() =>
      assertAskRead("logs.query", { query: 'count_over_time({app="r"}[24h])' }),
    ).not.toThrow();
  });
});
