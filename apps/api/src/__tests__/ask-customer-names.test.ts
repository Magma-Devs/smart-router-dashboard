import { describe, expect, it } from "vitest";
import { MAX_NAMES_PER_READ, namesIn } from "../services/ask/customer-names.js";
import { requestSummaryInput, resolveSummaryCustomer } from "../services/ask/request-summary.js";
import { summaryTable, type CountRow } from "../services/ask/summary-tables.js";

const ACME = "a1".repeat(32);
const BETA = "b2".repeat(32);
const NAMES = new Map([
  [ACME, "Acme Wallet"],
  ["team/eu", "Team EU"],
]);
const row = (labels: Record<string, string>, value: number): CountRow => ({ labels, value });

describe("resolveSummaryCustomer", () => {
  it("reads a named id as itself, before any name", () => {
    expect(resolveSummaryCustomer(ACME, NAMES)).toEqual({ customer: ACME });
    expect(resolveSummaryCustomer("team/eu", NAMES)).toEqual({ customer: "team/eu" });
  });

  it("reads a name, in any case and spacing, as its id", () => {
    expect(resolveSummaryCustomer("acme  WALLET ", NAMES)).toEqual({ customer: ACME });
  });

  it("reads an unnamed id as itself", () => {
    expect(resolveSummaryCustomer(BETA, NAMES)).toEqual({ customer: BETA });
  });

  it("answers anything else with the names it knows", () => {
    const result = resolveSummaryCustomer("Nobody Inc", NAMES);
    expect(result).toEqual({ error: expect.stringContaining('No customer is named "Nobody Inc"') });
    expect((result as { error: string }).error).toContain("Acme Wallet, Team EU");
    expect(resolveSummaryCustomer("a b", new Map())).toEqual({
      error: expect.stringContaining("No customer has a name."),
    });
  });

  it("lets the tool input carry a name the id pattern would refuse", () => {
    expect(
      requestSummaryInput.safeParse({ measure: "customers", customer: "Acme Wallet" }).success,
    ).toBe(true);
    expect(
      requestSummaryInput.safeParse({ measure: "customers", customer: "x".repeat(129) }).success,
    ).toBe(false);
  });
});

describe("namesIn", () => {
  it("names the ids a result holds as whole values: a label, or a field inside a log line", () => {
    const labels = JSON.stringify({ metric: { customer: ACME } });
    expect(namesIn(labels, NAMES)).toEqual({ [ACME]: "Acme Wallet" });
    const logLine = JSON.stringify({ values: [["1", JSON.stringify({ customer: "team/eu" })]] });
    expect(namesIn(logLine, NAMES)).toEqual({ "team/eu": "Team EU" });
  });

  it("does not match an id inside a longer value, or under another key", () => {
    expect(namesIn(JSON.stringify({ customer: `${ACME}0` }), NAMES)).toBeUndefined();
    expect(namesIn(JSON.stringify({ path: "team/eu/2" }), NAMES)).toBeUndefined();
    // A short or numeric id is a common sample value; only the customer key names it.
    const short = new Map([["42", "Forty Two"]]);
    expect(
      namesIn(JSON.stringify({ metric: { spec: "ETH1" }, value: [1, "42"] }), short),
    ).toBeUndefined();
    expect(namesIn(JSON.stringify({ metric: { customer: "42" } }), short)).toEqual({
      "42": "Forty Two",
    });
  });

  it("adds names only while they fit the bytes it is given", () => {
    const payload = JSON.stringify([{ customer: ACME }, { customer: "team/eu" }]);
    expect(namesIn(payload, NAMES, 10)).toBeUndefined();
    const one = namesIn(payload, NAMES, 110)!;
    expect(Object.keys(one)).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify({ customerNames: one }))).toBeLessThanOrEqual(110);
    expect(Object.keys(namesIn(payload, NAMES)!)).toHaveLength(2);
  });

  it("carries at most MAX_NAMES_PER_READ names", () => {
    const many = new Map(Array.from({ length: 80 }, (_, i) => [`id-${i}`, `Name ${i}`]));
    const payload = JSON.stringify([...many.keys()].map((customer) => ({ customer })));
    expect(Object.keys(namesIn(payload, many)!)).toHaveLength(MAX_NAMES_PER_READ);
  });
});

describe("the customers table", () => {
  it("puts a named customer's name beside its id, in rows and method detail", () => {
    const table = summaryTable(
      "customers",
      [
        {
          name: "customer_requests",
          rows: [row({ customer: ACME }, 40), row({ customer: BETA }, 9)],
        },
        { name: "customer_failures", rows: [row({ customer: ACME }, 2)] },
        {
          name: "customer_methods",
          rows: [row({ customer: ACME, method: "debug_traceTransaction" }, 30)],
        },
      ],
      undefined,
      NAMES,
    );
    expect(table.rows).toEqual([
      { name: "Acme Wallet", customer: ACME, requests: 40, failures: 2 },
      { customer: BETA, requests: 9, failures: 0 },
    ]);
    expect(table.detail).toEqual([
      { name: "Acme Wallet", customer: ACME, method: "debug_traceTransaction", requests: 30 },
    ]);
  });

  it("is the bare ids without names", () => {
    const table = summaryTable("customers", [
      { name: "customer_requests", rows: [row({ customer: ACME }, 40)] },
    ]);
    expect(table.rows).toEqual([{ customer: ACME, requests: 40 }]);
  });
});
