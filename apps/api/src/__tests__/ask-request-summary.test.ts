import { describe, expect, it } from "vitest";
import { RECORDED_WARN_ERROR, requestSummaryInput, requestSummaryQueries } from "../services/ask/request-summary.js";
import { FAILED_PIPELINE, PARSED_PIPELINE } from "../services/relay-end.js";
import { TX_EVENT_FILTER } from "../services/transactions.js";
import { LOG_PIPELINE } from "../services/transactions-over-time.js";
import { hasBoundedAskQuery } from "../services/ask/query-bounds.js";

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
    expect(failures!.raw).toBe(`sum by (chain) (count_over_time(${sel} ${FAILED_PIPELINE} [1800s]))`);
    const [tx] = requestSummaryQueries({ measure: "transactions", chain: "ETH1" }, defaults, "acme")!.counts;
    expect(tx!.raw).toBe(
      `sum by (chain, outcome, tx_status, tx_refused, api_interface) (count_over_time(${sel} ${TX_EVENT_FILTER} ${LOG_PIPELINE} [1800s]))`,
    );
    const [errors, messages] = requestSummaryQueries({ measure: "errors" }, defaults, "acme")!.counts;
    expect(errors!.raw).toBe(
      'sum by (chain, level) (count_over_time({service_name=~"acme-.*",component="router"} | level=~"warn|error" [1800s]))',
    );
    expect(messages!.raw).toContain('| level=~"warn|error" | json message="message" | __error__=""');
    for (const measure of [undefined, "transactions", "errors"] as const)
      for (const count of requestSummaryQueries({ measure }, defaults, "acme")!.counts)
        expect(hasBoundedAskQuery(count.raw!)).toBe(true);
  });
  it("gives no raw count without a plain customer id", () => {
    for (const id of [undefined, "", "Acme", 'acme"} or {x="y']) {
      for (const count of requestSummaryQueries({}, defaults, id)!.counts) expect(count.raw).toBeUndefined();
    }
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
  it.each([1, 60, 300, 3600, 86400])("allows a bounded %s second window", (seconds) => {
    expect(requestSummaryQueries({ start: end - seconds, end }, defaults)).not.toBeNull();
  });
  it.each([
    { start: end, end },
    { start: end + 1, end },
    { start: end - 86401, end },
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
