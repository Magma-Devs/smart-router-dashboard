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
  it("splits each chain's requests and failures into the serving probe's and the customer's own", () => {
    const table = summaryTable("requests", [
      { name: "requests", rows: [row({ chain: "eth1" }, 900), row({ chain: "sol" }, 50)] },
      { name: "failures", rows: [row({ chain: "eth1" }, 4), row({ chain: "sol" }, 7)] },
      // sol's probe sent more than was counted, so it is capped.
      { name: "probe_requests", rows: [row({ chain: "eth1" }, 60), row({ chain: "sol" }, 80)] },
      { name: "probe_failures", rows: [row({ chain: "sol" }, 7)] },
    ]);
    expect(table.rows).toEqual([
      {
        chain: "sol",
        requests: 50,
        failures: 7,
        probeRequests: 50,
        probeFailures: 7,
        customerRequests: 0,
        customerFailures: 0,
      },
      {
        chain: "eth1",
        requests: 900,
        failures: 4,
        probeRequests: 60,
        probeFailures: 0,
        customerRequests: 840,
        customerFailures: 4,
      },
    ]);
    expect(table.totals).toMatchObject({ customerRequests: 840, probeRequests: 110 });
  });
  it("leaves the split out when the probe's share could not be read", () => {
    const table = summaryTable("requests", [
      { name: "requests", rows: [row({ chain: "eth1" }, 900)] },
      { name: "failures", rows: [] },
      { name: "probe_requests", rows: null },
      { name: "probe_failures", rows: [] },
    ]);
    expect(table.rows).toEqual([{ chain: "eth1", requests: 900, failures: 0 }]);
    expect(table.unavailable).toEqual(["probe_requests"]);
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

describe("block table", () => {
  const tip = (router: string, spec: string, apiInterface: string, endpoint_id: string) => ({
    router,
    spec,
    apiInterface,
    endpoint_id,
  });
  const counts = (over: Partial<Record<string, CountRow[] | null>> = {}) =>
    [
      {
        name: "block_heights",
        rows: [
          row(tip("cosmos-hub", "COSMOSHUB", "tendermintrpc", "nodeworks"), 976),
          row(tip("cosmos-hub", "COSMOSHUB", "tendermintrpc", "blockdaemon"), 1000),
          row(tip("cosmos-hub", "COSMOSHUB", "rest", "nodeworks"), 1000),
          // GraphQL counts checkpoints its own way: measured against GraphQL only.
          row(tip("sui", "SUI", "graphql", "foundation"), 410_494_211),
          row(tip("sui", "SUI", "grpc", "foundation"), 410_493_961),
          row(tip("sui", "SUI", "grpc", "mysten"), 410_493_960),
          row(tip("eth", "ETH1", "jsonrpc", "frozen"), 500),
          row(tip("eth", "ETH1", "jsonrpc", "fresh"), 500),
        ],
      },
      {
        name: "block_pace",
        rows: [
          row(tip("cosmos-hub", "COSMOSHUB", "tendermintrpc", ""), 600),
          row(tip("cosmos-hub", "COSMOSHUB", "rest", ""), 600),
          row(tip("sui", "SUI", "grpc", ""), 14_400),
          row(tip("sui", "SUI", "graphql", ""), 14_400),
          row(tip("eth", "ETH1", "jsonrpc", ""), 300),
        ],
      },
      {
        name: "block_moves",
        rows: [
          row(tip("cosmos-hub", "COSMOSHUB", "tendermintrpc", "nodeworks"), 140),
          row(tip("cosmos-hub", "COSMOSHUB", "tendermintrpc", "blockdaemon"), 150),
          row(tip("eth", "ETH1", "jsonrpc", "frozen"), 0),
          row(tip("eth", "ETH1", "jsonrpc", "fresh"), 70),
        ],
      },
      { name: "head_stalled_urls", rows: [row(tip("eth", "ETH1", "jsonrpc", "frozen"), 1)] },
    ].map((count) => (count.name in over ? { ...count, rows: over[count.name]! } : count));

  it("measures each provider against the best of its router's providers on that chain and interface", () => {
    const table = summaryTable("blocks", counts());
    const find = (router: string, iface: string, provider: string) =>
      table.rows.find(
        (r) => r.router === router && r.interface === iface && r.provider === provider,
      );
    expect(find("cosmos-hub", "tendermintrpc", "nodeworks")).toEqual({
      router: "cosmos-hub",
      chain: "COSMOSHUB",
      interface: "tendermintrpc",
      provider: "nodeworks",
      latestBlock: 976,
      blocksBehind: 24,
      secondsBehind: 144,
      notMoving: "no",
    });
    expect(find("cosmos-hub", "rest", "nodeworks")).toMatchObject({
      blocksBehind: 0,
      secondsBehind: 0,
    });
    expect(find("sui", "graphql", "foundation")).toMatchObject({ blocksBehind: 0 });
    expect(find("sui", "grpc", "foundation")).toMatchObject({ blocksBehind: 0 });
    expect(find("sui", "grpc", "mysten")).toMatchObject({ blocksBehind: 1, secondsBehind: 0 });
  });

  it("marks a block that stood still while the chain moved, with its stalled urls, and puts the flagged rows first", () => {
    const table = summaryTable("blocks", counts());
    expect(table.rows[0]).toMatchObject({
      provider: "frozen",
      notMoving: "yes",
      headStalledUrls: 1,
    });
    expect(table.rows[1]).toMatchObject({ provider: "nodeworks", interface: "tendermintrpc" });
    expect(table.rows.find((r) => r.provider === "fresh")).toMatchObject({ notMoving: "no" });
    expect(table.totals).toEqual({
      providers: 8,
      atBestBlock: 6,
      behind30sOrMore: 1,
      notMoving: 1,
      headStalledUrls: 1,
    });
  });

  it("calls nothing stuck on a chain that made under two blocks in the window", () => {
    const table = summaryTable(
      "blocks",
      counts({ block_pace: [row(tip("eth", "ETH1", "jsonrpc", ""), 7)] }),
    );
    expect(table.rows.find((r) => r.provider === "frozen")).toMatchObject({ notMoving: "no" });
  });

  it("leaves out what a failed read would have said, and names it", () => {
    const table = summaryTable("blocks", counts({ block_pace: null, block_moves: null }));
    expect(table.unavailable).toEqual(["block_pace", "block_moves"]);
    const lagging = table.rows.find(
      (r) => r.provider === "nodeworks" && r.interface === "tendermintrpc",
    )!;
    expect(lagging).toMatchObject({ blocksBehind: 24 });
    expect(lagging).not.toHaveProperty("secondsBehind");
    expect(lagging).not.toHaveProperty("notMoving");
    expect(table.totals).not.toHaveProperty("notMoving");
    expect(table.totals.behind30sOrMore).toBe(2);
  });

  it("caps the rows and counts every provider in the totals", () => {
    const table = summaryTable("blocks", counts(), 2);
    expect(table.rows).toHaveLength(2);
    expect(table.omittedRows).toBe(6);
    expect(table.totals.providers).toBe(8);
  });
});
