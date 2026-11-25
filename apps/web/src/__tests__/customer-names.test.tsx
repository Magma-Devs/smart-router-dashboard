import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { customerOptions, NO_CUSTOMER, WhenCell } from "@/components/metrics/request-log";

const ACME = "a1".repeat(32);
const BETA = "b2".repeat(32);
const NAMES = new Map([[ACME, "Zeta Wallet"]]);

vi.mock("@/hooks/use-customer-names", () => ({ useCustomerNames: () => NAMES }));

describe("the request lists' customers", () => {
  it("labels a named id by its name, an unnamed one by itself, in label order", () => {
    const rows = [{ customer: ACME }, { customer: BETA }, { customer: ACME }, {}];
    expect(customerOptions(rows, NAMES)).toEqual([
      { key: BETA, label: BETA, count: 1 },
      { key: ACME, label: "Zeta Wallet", count: 2 },
      { key: NO_CUSTOMER, label: "No customer", count: 1 },
    ]);
  });

  it("is the bare ids without names", () => {
    expect(customerOptions([{ customer: ACME }]).map((o) => o.label)).toEqual([ACME]);
  });

  it("shows a row's name, with the id it stands for on hover", () => {
    const named = renderToStaticMarkup(createElement(WhenCell, { time: 0, customer: ACME }));
    expect(named).toContain(" · Zeta Wallet");
    expect(named).toContain(`the customer-id header the caller sent: ${ACME}`);
    const unnamed = renderToStaticMarkup(createElement(WhenCell, { time: 0, customer: BETA }));
    expect(unnamed).toContain(` · ${BETA}`);
  });
});
