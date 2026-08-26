import { beforeAll, describe, expect, it } from "vitest";
import { catalogReady, getInterfaceConfig, type AddonCommand } from "../chain-methods";
import {
  matchRank,
  partitionByRunnability,
  prepareQuery,
  runnabilityOf,
  searchCommands,
  RUNNABILITY_LABEL,
  RUNNABILITY_ORDER,
} from "../method-search";

const cmd = (over: Partial<AddonCommand> & { method: string }): AddonCommand => ({
  label: over.method,
  params: "[]",
  ...over,
});

/** `searchCommands` ranks rows shaped `{ cmd }` — the picker's row shape. */
const row = (over: Partial<AddonCommand> & { method: string }) => ({ cmd: cmd(over) });
const ids = (rows: { cmd: AddonCommand }[]) => rows.map((r) => r.cmd.method);

describe("runnabilityOf", () => {
  it("names the three states the catalog can be in", () => {
    expect(runnabilityOf(cmd({ method: "a", ready: true }))).toBe("ready");
    expect(runnabilityOf(cmd({ method: "b", needsInput: true }))).toBe("needs-input");
    // Neither flag is the catalog admitting it has not checked. It must not
    // collapse into either claim — that is what made eth_getBlockByHash look
    // like a method that takes no arguments.
    expect(runnabilityOf(cmd({ method: "c" }))).toBe("unverified");
  });

  it("prefers the proven claim when a command somehow carries both", () => {
    expect(runnabilityOf(cmd({ method: "a", ready: true, needsInput: true }))).toBe("ready");
  });
});

describe("partitionByRunnability", () => {
  it("splits into the three sections and keeps catalog order", () => {
    const rows = [
      row({ method: "r1", ready: true }),
      row({ method: "n1", needsInput: true }),
      row({ method: "u1" }),
      row({ method: "r2", ready: true }),
      row({ method: "u2" }),
    ];
    const parts = partitionByRunnability(rows);
    expect(ids(parts.ready)).toEqual(["r1", "r2"]);
    expect(ids(parts["needs-input"])).toEqual(["n1"]);
    expect(ids(parts.unverified)).toEqual(["u1", "u2"]);
  });

  it("covers every section the picker stacks, and words each one", () => {
    const parts = partitionByRunnability([]);
    for (const kind of RUNNABILITY_ORDER) {
      expect(parts[kind]).toEqual([]);
      expect(RUNNABILITY_LABEL[kind]).toBeTruthy();
    }
    expect(RUNNABILITY_ORDER).toHaveLength(3);
  });
});

describe("searchCommands", () => {
  const evm = [
    row({ method: "eth_blockNumber", ready: true }),
    row({ method: "eth_getBlockByNumber", ready: true }),
    row({ method: "eth_getBlockByHash" }),
    row({ method: "eth_getBlockTransactionCountByHash" }),
    row({ method: "eth_getTransactionByHash", needsInput: true }),
  ];

  it("returns the rows untouched for an empty query", () => {
    expect(searchCommands(evm, "", "jsonrpc")).toBe(evm);
    expect(searchCommands(evm, "   ", "jsonrpc")).toBe(evm);
  });

  it("finds the method the customer could not find", () => {
    expect(ids(searchCommands(evm, "getBlockByHash", "jsonrpc"))[0]).toBe("eth_getBlockByHash");
  });

  it("ignores the separators and the case a caller types it with", () => {
    for (const query of ["getblockbyhash", "get block by hash", "GET_BLOCK_BY_HASH", "eth_getblockby"]) {
      expect(ids(searchCommands(evm, query, "jsonrpc")), query).toContain("eth_getBlockByHash");
    }
  });

  it("puts an exact id first", () => {
    const found = ids(searchCommands(evm, "eth_getBlockByHash", "jsonrpc"));
    expect(found[0]).toBe("eth_getBlockByHash");
  });

  it("matches every word anywhere in the id, not just a contiguous run", () => {
    // "block hash" is not a substring of `ethgetblockbyhash` — the `by` is in
    // the way. Both words are in there, which is what the caller meant.
    const found = ids(searchCommands(evm, "block hash", "jsonrpc"));
    expect(found).toContain("eth_getBlockByHash");
    expect(found).toContain("eth_getBlockTransactionCountByHash");
    expect(found).not.toContain("eth_blockNumber");
  });

  it("ranks a contiguous match above a scattered one", () => {
    const found = ids(searchCommands(evm, "block by hash", "jsonrpc"));
    expect(found[0]).toBe("eth_getBlockByHash");
  });

  it("ranks a prefix above a mid-string match", () => {
    const found = ids(searchCommands(evm, "eth_getBlock", "jsonrpc"));
    expect(found.indexOf("eth_getBlockByNumber")).toBeLessThan(
      found.indexOf("eth_getBlockTransactionCountByHash"),
    );
  });

  it("leads with what runs as-is when the rank is otherwise a tie", () => {
    const rows = [
      row({ method: "aaa_probe" }),
      row({ method: "aaa_ready", ready: true }),
    ];
    expect(ids(searchCommands(rows, "aaa", "jsonrpc"))).toEqual(["aaa_ready", "aaa_probe"]);
  });

  it("reads the description too, so a caller can search by what it does", () => {
    const rows = [row({ method: "web3_clientVersion", desc: "Returns the current client version string." })];
    expect(ids(searchCommands(rows, "version string", "jsonrpc"))).toEqual(["web3_clientVersion"]);
    // The id itself is nowhere near that query — this is the description path.
    expect(matchRank("jsonrpc", rows[0]!.cmd, prepareQuery("version string"))).toBe(5);
  });

  it("returns nothing rather than everything when a query matches nothing", () => {
    expect(searchCommands(evm, "solana", "jsonrpc")).toEqual([]);
  });

  it("treats a query of pure separators as no match, not as a match on all", () => {
    // `startsWith("")` is true for every id — the guard on an empty folded
    // query is what stops "___" from quietly listing the whole catalog as if
    // each entry had been matched.
    expect(searchCommands(evm, "___", "jsonrpc")).toEqual([]);
    expect(prepareQuery("___").tokens).toEqual([]);
  });

  it("matches a REST command on its path, which is what identifies it", () => {
    const rest = [
      { cmd: cmd({ method: "GET", label: "/cosmos/bank/v1beta1/balances", params: "/cosmos/bank/v1beta1/balances" }) },
      { cmd: cmd({ method: "GET", label: "/cosmos/staking/v1beta1/validators", params: "/cosmos/staking/v1beta1/validators" }) },
    ];
    const found = searchCommands(rest, "bank balances", "rest");
    expect(found).toHaveLength(1);
    expect(found[0]?.cmd.label).toBe("/cosmos/bank/v1beta1/balances");
  });
});

describe("against the real catalog", () => {
  beforeAll(() => catalogReady);

  it("finds eth_getBlockByHash on ETH1 — the search this was built for", () => {
    const cfg = getInterfaceConfig("ETH1", "jsonrpc", []);
    const rows = (cfg?.regular ?? []).map((c) => ({ cmd: c }));
    expect(rows.length).toBeGreaterThan(12);
    const found = searchCommands(rows, "getblockbyhash", "jsonrpc");
    expect(found[0]?.cmd.method).toBe("eth_getBlockByHash");
  });

  it("still classifies it as unverified, so the picker says so", () => {
    const cfg = getInterfaceConfig("ETH1", "jsonrpc", []);
    const found = cfg?.regular.find((c) => c.method === "eth_getBlockByHash");
    expect(found).toBeDefined();
    // Until the catalog ticket lands this is the honest answer — and it is
    // exactly what the picker's "Not verified" section is for.
    expect(runnabilityOf(found!)).toBe("unverified");
  });

  it("splits a real tier into sections that add up to the whole tier", () => {
    const cfg = getInterfaceConfig("ETH1", "jsonrpc", []);
    const rows = (cfg?.regular ?? []).map((c) => ({ cmd: c }));
    const parts = partitionByRunnability(rows);
    const total = RUNNABILITY_ORDER.reduce((n, kind) => n + parts[kind].length, 0);
    expect(total).toBe(rows.length);
    expect(parts.ready.length).toBeGreaterThan(0);
    expect(parts.unverified.length).toBeGreaterThan(0);
  });
});
