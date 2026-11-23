import { describe, expect, it } from "vitest";
import {
  countRows,
  MAX_TABLE_ROWS,
  summaryTable,
  type CountRow,
} from "../services/ask/summary-tables.js";

const vector = (result: { metric: Record<string, string>; value: [number, string] }[]) => ({
  status: "success",
  data: { resultType: "vector", result },
});
const row = (labels: Record<string, string>, value: number): CountRow => ({ labels, value });

describe("count rows", () => {
  it("reads an instant vector as labelled whole counts", () => {
    expect(
      countRows(vector([{ metric: { chain: "eth1", __name__: "x" }, value: [1, "4.6"] }])),
    ).toEqual([row({ chain: "eth1" }, 5)]);
    expect(countRows(vector([]))).toEqual([]);
  });
  it.each([
    { status: "success", data: { resultType: "matrix", result: [] } },
    vector([{ metric: {}, value: [1, "NaN"] }]),
    { error: "Source unavailable" },
  ])("returns null for anything but a vector of numbers %#", (data) => {
    expect(countRows(data)).toBeNull();
  });
});

describe("summary tables", () => {
  it("classifies transactions by the Transactions tab's rules and totals them per chain", () => {
    const table = summaryTable("transactions", [
      {
        name: "transactions",
        rows: [
          row({ chain: "eth1", outcome: "ok" }, 10),
          row({ chain: "eth1", outcome: "ok", tx_status: "failure" }, 2),
          row({ chain: "eth1", outcome: "rejected_before_dispatch" }, 1),
          row({ chain: "eth1", outcome: "no_answer" }, 3),
          row({ chain: "cosmoshub", outcome: "ok", api_interface: "grpc" }, 4),
          row({ chain: "cosmoshub", outcome: "ok", tx_refused: "true" }, 5),
        ],
      },
    ]);
    expect(table.rows).toEqual([
      {
        chain: "eth1",
        accepted: 10,
        rejected: 0,
        failedNeverSent: 1,
        failedOnChain: 2,
        unknown: 3,
        total: 16,
      },
      {
        chain: "cosmoshub",
        accepted: 0,
        rejected: 5,
        failedNeverSent: 0,
        failedOnChain: 0,
        unknown: 4,
        total: 9,
      },
    ]);
    expect(table.totals).toEqual({
      accepted: 10,
      rejected: 5,
      failedNeverSent: 1,
      failedOnChain: 2,
      unknown: 7,
      total: 25,
    });
  });
  it("merges requests and failures per chain, failures first", () => {
    const table = summaryTable("requests", [
      { name: "requests", rows: [row({ chain: "eth1" }, 900), row({ chain: "sol" }, 50)] },
      { name: "failures", rows: [row({ chain: "sol" }, 7)] },
    ]);
    expect(table.rows).toEqual([
      { chain: "sol", requests: 50, failures: 7 },
      { chain: "eth1", requests: 900, failures: 0 },
    ]);
    expect(table.totals).toEqual({ requests: 950, failures: 7 });
  });
  it("gives each provider its failed relays and node-error replies, most errors first", () => {
    const table = summaryTable("providers", [
      {
        name: "provider_relays",
        rows: [
          row({ spec: "ETH1", provider_address: "node-a" }, 1000),
          row({ spec: "ETH1", provider_address: "node-b" }, 500),
        ],
      },
      {
        name: "provider_successes",
        rows: [
          row({ spec: "ETH1", provider_address: "node-a" }, 1000),
          row({ spec: "ETH1", provider_address: "node-b" }, 480),
        ],
      },
      {
        name: "provider_node_errors",
        rows: [row({ spec: "ETH1", provider_address: "node-a" }, 40)],
      },
    ]);
    expect(table.rows).toEqual([
      { chain: "ETH1", provider: "node-a", relays: 1000, failedRelays: 0, nodeErrorReplies: 40 },
      { chain: "ETH1", provider: "node-b", relays: 500, failedRelays: 20, nodeErrorReplies: 0 },
    ]);
    expect(table.totals).toEqual({ relays: 1500, failedRelays: 20, nodeErrorReplies: 40 });
  });
  it("names a count it could not read and leaves its column out", () => {
    const table = summaryTable("providers", [
      { name: "provider_relays", rows: [row({ spec: "ETH1", provider_address: "node-a" }, 10)] },
      { name: "provider_successes", rows: null },
      { name: "provider_node_errors", rows: [] },
    ]);
    expect(table.unavailable).toEqual(["provider_successes"]);
    expect(table.rows).toEqual([
      { chain: "ETH1", provider: "node-a", relays: 10, nodeErrorReplies: 0 },
    ]);
  });
  it("leaves out a label a sample does not carry, never an empty value", () => {
    const table = summaryTable("errors", [
      { name: "errors", rows: [row({ chain: "eth1" }, 3)] },
      { name: "error_messages", rows: [row({ chain: "eth1" }, 3)] },
    ]);
    expect(table.rows).toEqual([{ chain: "eth1", lines: 3 }]);
    expect(table.detail).toEqual([{ chain: "eth1", lines: 3 }]);
  });
  it("keeps the most frequent messages and the per-method customer counts as detail", () => {
    const errors = summaryTable("errors", [
      { name: "errors", rows: [row({ chain: "eth1", level: "warn" }, 8)] },
      {
        name: "error_messages",
        rows: [row({ chain: "eth1", level: "warn", message: "slow N" }, 8)],
      },
    ]);
    expect(errors.rows).toEqual([{ chain: "eth1", level: "warn", lines: 8 }]);
    expect(errors.detail).toEqual([{ chain: "eth1", level: "warn", message: "slow N", lines: 8 }]);
    const customers = summaryTable("customers", [
      { name: "customer_requests", rows: [row({ customer: "a" }, 9)] },
      { name: "customer_failures", rows: [] },
      { name: "customer_methods", rows: [row({ customer: "a", method: "eth_call" }, 9)] },
    ]);
    expect(customers.rows).toEqual([{ customer: "a", requests: 9, failures: 0 }]);
    expect(customers.detail).toEqual([{ customer: "a", method: "eth_call", requests: 9 }]);
  });
  it("caps the rows, largest first, and still totals every row", () => {
    const relays = Array.from({ length: 130 }, (_, i) =>
      row({ spec: "ETH1", provider_address: `node-${i}` }, i + 1),
    );
    const table = summaryTable("providers", [
      { name: "provider_relays", rows: relays },
      { name: "provider_successes", rows: [] },
      { name: "provider_node_errors", rows: [] },
    ]);
    expect(table.rows).toHaveLength(MAX_TABLE_ROWS);
    expect(table.omittedRows).toBe(130 - MAX_TABLE_ROWS);
    expect(table.rows[0]).toMatchObject({ provider: "node-129", failedRelays: 130 });
    expect(table.totals.relays).toBe((130 * 131) / 2);
  });
});
