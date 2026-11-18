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
    ["up[1h:5m]", null],
  ])("reports the actual lookback for %s", (query, expected) => {
    expect(askQueryLookbackSeconds(String(query))).toBe(expected);
  });
});
