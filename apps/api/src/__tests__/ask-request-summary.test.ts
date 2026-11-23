import { describe, expect, it } from "vitest";
import {
  CUSTOMER_COUNTERS,
  MAX_COUNT_SECONDS,
  RECORDED_WARN_ERROR,
  requestSummaryInput,
  requestSummaryQueries,
} from "../services/ask/request-summary.js";
import { FAILED_PIPELINE, PARSED_PIPELINE } from "../services/relay-end.js";
import { TX_EVENT_FILTER } from "../services/transactions.js";
import { LOG_PIPELINE } from "../services/transactions-over-time.js";
import { hasBoundedAskQuery, METRICS_LOOKBACK_SECONDS } from "../services/ask/query-bounds.js";

const end = Math.floor(Date.now() / 1000);
const defaults = { start: end - 1800, end };
describe("curated request evidence", () => {
  it("uses the Transactions tab's own recorded family and preserves outcome labels", () => {
    const queries = requestSummaryQueries({ measure: "transactions", chain: "ETH1" }, defaults)!;
    expect(queries.counts).toHaveLength(1);
    expect(queries.counts[0]?.query).toBe(
      'sum by (chain, outcome, tx_status, tx_refused, api_interface) (sum_over_time(smartrouter_transactions:count1m{chain="eth1"}[1800s]))',
    );
    expect(() =>
      queries.counts.forEach((count) => expect(hasBoundedAskQuery(count.query)).toBe(true)),
    ).not.toThrow();
  });
  it("uses the dashboard's recorded outcome families over one exact window", () => {
    const result = requestSummaryQueries({}, defaults)!;
    expect(result).toMatchObject(defaults);
    expect(result.counts.map((count) => count.name)).toEqual(["requests", "failures"]);
    expect(result.counts[0]!.query).toBe(
      "sum by (chain) (sum_over_time(smartrouter_final_requests:count1m[1800s]))",
    );
    expect(result.counts[1]!.query).toBe(
      "sum by (chain) (sum_over_time(smartrouter_final_failures:count1m[1800s]))",
    );
    expect(result.counts.every((count) => hasBoundedAskQuery(count.query))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("vector(0)");
  });
  it("reads the recorded warn and error lines by chain and level, and the most frequent messages", () => {
    const queries = requestSummaryQueries({ measure: "errors", chain: "ETH1" }, defaults)!;
    expect(queries.counts.map((count) => count.name)).toEqual(["errors", "error_messages"]);
    expect(queries.counts[0]!.query).toBe(
      `sum by (chain, level) (sum_over_time(${RECORDED_WARN_ERROR}{chain="eth1"}[1800s]))`,
    );
    expect(queries.counts[1]!.query).toBe(
      `topk(30, sum by (chain, level, message) (sum_over_time(${RECORDED_WARN_ERROR}{chain="eth1"}[1800s])))`,
    );
    expect(queries.counts.every((count) => hasBoundedAskQuery(count.query))).toBe(true);
  });
  it("gives every count the same count over the customer's raw router lines, with the recorded rule's filters", () => {
    const sel = '{service_name=~"acme-.*",component="router",chain="eth1"}';
    const [requests, failures] = requestSummaryQueries({ chain: "ETH1" }, defaults, "acme")!.counts;
    expect(requests!.raw).toBe(
      `sum by (chain) (count_over_time(${sel} |= \`"event":"relay_end"\` ${PARSED_PIPELINE} | selection!="subscription" [1800s]))`,
    );
    expect(failures!.raw).toBe(
      `sum by (chain) (count_over_time(${sel} ${FAILED_PIPELINE} [1800s]))`,
    );
    const [tx] = requestSummaryQueries(
      { measure: "transactions", chain: "ETH1" },
      defaults,
      "acme",
    )!.counts;
    expect(tx!.raw).toBe(
      `sum by (chain, outcome, tx_status, tx_refused, api_interface) (count_over_time(${sel} ${TX_EVENT_FILTER} ${LOG_PIPELINE} [1800s]))`,
    );
    const [errors, messages] = requestSummaryQueries(
      { measure: "errors" },
      defaults,
      "acme",
    )!.counts;
    expect(errors!.raw).toBe(
      'sum by (chain, level) (count_over_time({service_name=~"acme-.*",component="router"} | level=~"warn|error" [1800s]))',
    );
    expect(messages!.raw).toContain(
      '| level=~"warn|error" | json message="message" | __error__=""',
    );
    for (const measure of [undefined, "transactions", "errors"] as const)
      for (const count of requestSummaryQueries({ measure }, defaults, "acme")!.counts)
        expect(hasBoundedAskQuery(count.raw!)).toBe(true);
  });
  it("reads requests and failures per customer, and per customer and method, without the serving probe", () => {
    const queries = requestSummaryQueries({ measure: "customers" }, defaults, "acme")!;
    expect(queries.counts.map((count) => count.name)).toEqual([
      "customer_requests",
      "customer_failures",
      "customer_methods",
    ]);
    const sel = '{customer!="magma-serving-probe"}';
    expect(queries.counts[0]!.query).toBe(
      `topk(50, round(sum by (customer) (increase(${CUSTOMER_COUNTERS.requests}${sel}[1800s]))))`,
    );
    expect(queries.counts[1]!.query).toBe(
      `topk(50, round(sum by (customer) (increase(${CUSTOMER_COUNTERS.failures}${sel}[1800s]))))`,
    );
    expect(queries.counts[2]!.query).toBe(
      `topk(30, round(sum by (customer, method) (increase(${CUSTOMER_COUNTERS.requests}${sel}[1800s]))))`,
    );
    // Prometheus counters: no recorded series behind them, so no log-line fallback.
    for (const count of queries.counts) {
      expect(count.raw).toBeUndefined();
      expect(hasBoundedAskQuery(count.query)).toBe(true);
    }
  });
  it("narrows the customer counts to a chain's spec, one customer and method prefixes", () => {
    const customer = "c0ffee".repeat(10) + "abcd";
    const queries = requestSummaryQueries(
      {
        measure: "customers",
        chain: "eth1",
        customer,
        methodPrefixes: ["debug_", "trace_"],
        start: end - 86400,
        end,
      },
      defaults,
    )!;
    // The recorded series carry the chain lower-cased; these counters carry the spec upper-cased.
    const sel = `{customer!="magma-serving-probe",spec="ETH1",customer="${customer}",method=~"(?:debug_|trace_).*"}`;
    for (const count of queries.counts) {
      expect(count.query).toContain(`${sel}[86400s]`);
      expect(hasBoundedAskQuery(count.query)).toBe(true);
    }
  });
  it.each([
    { measure: "customers", customer: 'acme"} or vector(1)' },
    { measure: "customers", customer: "" },
    { measure: "customers", customer: "a".repeat(129) },
    { measure: "customers", methodPrefixes: [] },
    { measure: "customers", methodPrefixes: [".*"] },
    { measure: "customers", methodPrefixes: ["debug_|eth_"] },
    { measure: "customers", methodPrefixes: Array.from({ length: 9 }, (_, i) => `m${i}_`) },
    { customer: "acme" },
    { measure: "errors", methodPrefixes: ["debug_"] },
  ])(
    "refuses a customer or method filter it cannot quote literally, or outside measure=customers %#",
    (input) => {
      expect(requestSummaryInput.safeParse(input).success).toBe(false);
    },
  );
  it("gives no raw count without a plain customer id", () => {
    for (const id of [undefined, "", "Acme", 'acme"} or {x="y']) {
      for (const count of requestSummaryQueries({}, defaults, id)!.counts)
        expect(count.raw).toBeUndefined();
    }
  });
  it("turns from and to in ISO 8601 into the window, in any zone", () => {
    const queries = requestSummaryQueries(
      { from: "2026-11-13T22:56:00Z", to: "2026-11-14T02:25:00+02:00" },
      defaults,
    )!;
    expect(queries).toMatchObject({ start: 1794610560, end: 1794615900 });
  });
  it("reads a time without a zone as UTC", () => {
    expect(
      requestSummaryQueries({ from: "2026-11-13T22:56:00", to: "2026-11-14T00:25" }, defaults),
    ).toMatchObject({ start: 1794610560, end: 1794615900 });
  });
  it.each([
    { from: "13.11 22:56" },
    { from: "2026-11-13T22:56:00Z", start: 1 },
    { to: "2026-11-13T22:56:00Z", end: 1 },
    { from: "2026-11-14T00:00:00Z", to: "2026-11-13T00:00:00Z" },
  ])("refuses a time without a zone, given twice or out of order %#", (input) => {
    expect(requestSummaryInput.safeParse(input).success).toBe(false);
  });
  it("counts over 30 days from the recorded series, offering no raw scan past a day", () => {
    for (const measure of [undefined, "transactions", "errors"] as const) {
      const queries = requestSummaryQueries(
        { measure, start: end - MAX_COUNT_SECONDS, end },
        defaults,
        "acme",
      )!;
      for (const count of queries.counts) {
        expect(count.raw).toBeUndefined();
        expect(hasBoundedAskQuery(count.query, METRICS_LOOKBACK_SECONDS)).toBe(true);
      }
    }
    for (const count of requestSummaryQueries({ start: end - 86400, end }, defaults, "acme")!
      .counts)
      expect(count.raw).toBeDefined();
  });
  it("reads relays and successes per provider from the recorded pair, and node-error replies raw, without the cache", () => {
    const queries = requestSummaryQueries({ measure: "providers", chain: "eth1" }, defaults)!;
    const sel = '{provider_address!="Cached",spec="ETH1"}';
    expect(queries.counts).toEqual([
      {
        name: "provider_relays",
        query: `round(sum by (spec, provider_address) (sum_over_time(spec_router_provider:smartrouter_requests_total:rate2m15s${sel}[1800s])) * 60)`,
      },
      {
        name: "provider_successes",
        query: `round(sum by (spec, provider_address) (sum_over_time(spec_router_provider:smartrouter_requests_success_total:rate2m15s${sel}[1800s])) * 60)`,
      },
      {
        name: "provider_node_errors",
        query: `round(sum by (spec, provider_address) (increase(smartrouter_node_errors_total${sel}[1800s])))`,
      },
    ]);
    for (const count of queries.counts) expect(hasBoundedAskQuery(count.query)).toBe(true);
  });
  it("narrows both counts to the same normalized chain", () => {
    expect(
      requestSummaryQueries({ chain: "ETH1" }, defaults)!.counts.every((count) =>
        count.query.includes('{chain="eth1"}'),
      ),
    ).toBe(true);
  });
  it("an explicit historical end preserves the default span", () => {
    expect(requestSummaryQueries({ end: end - 86400 }, defaults)).toMatchObject({
      start: end - 88200,
      end: end - 86400,
    });
  });
  it.each([1, 60, 300, 3600, 86400, 7 * 86400, 30 * 86400])(
    "allows a bounded %s second window",
    (seconds) => {
      expect(requestSummaryQueries({ start: end - seconds, end }, defaults)).not.toBeNull();
    },
  );
  it.each([
    { start: end, end },
    { start: end + 1, end },
    { start: end - MAX_COUNT_SECONDS - 1, end },
    { measure: "customers" as const, start: end - 86401, end },
    { start: end - 0.5, end },
    { start: end, end: end + 600 },
  ])("refuses an invalid time window %# before reading", (input) => {
    expect(requestSummaryQueries(input, defaults)).toBeNull();
  });
  it.each([
    { chain: 'ETH1"} or vector(100)' },
    { sourceId: "https://elsewhere.test" },
    { tenantId: "other-customer" },
    { headers: { authorization: "other" } },
    { start: "now" },
  ])("rejects query injection, authorization overrides and wrong types %#", (input) => {
    expect(requestSummaryInput.safeParse(input).success).toBe(false);
  });
});
