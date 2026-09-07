import { describe, expect, it } from "vitest";
import {
  attributeToImports,
  diffMethodEntry,
  importClosure,
  summarizeMethodDrift,
} from "../lib/drift-summary.mjs";

const specIndex = new Map([
  ["ETH1", { file: "ethereum.json", imports: [] }],
  ["ARBITRUM", { file: "arbitrum.json", imports: ["ETH1"] }],
  ["ARBITRUMS", { file: "arbitrum.json", imports: ["ARBITRUM"] }],
  ["SDN", { file: "sdn.json", imports: ["ETH1"] }],
  ["OSMOSIS", { file: "osmosis.json", imports: ["COSMOSSDK50"] }],
  ["COSMOSSDK50", { file: "cosmossdkv50.json", imports: ["COSMOSSDK"] }],
  ["COSMOSSDK", { file: "cosmossdk.json", imports: [] }],
  ["XRT", { file: "xrt.json", imports: [] }],
]);

describe("importClosure", () => {
  it("walks imports transitively and excludes the spec itself", () => {
    expect([...importClosure("ARBITRUMS", specIndex)].sort()).toEqual(["ARBITRUM", "ETH1"]);
    expect([...importClosure("OSMOSIS", specIndex)].sort()).toEqual(["COSMOSSDK", "COSMOSSDK50"]);
    expect(importClosure("XRT", specIndex).size).toBe(0);
  });

  it("survives a cycle", () => {
    const cyclic = new Map([
      ["A", { file: "a.json", imports: ["B"] }],
      ["B", { file: "b.json", imports: ["A"] }],
    ]);
    expect([...importClosure("A", cyclic)].sort()).toEqual(["A", "B"]);
  });
});

describe("diffMethodEntry", () => {
  const before = {
    jsonrpc: {
      regular: [{ m: "eth_blockNumber", d: "latest" }, { m: "eth_chainId" }],
      debug: [{ m: "debug_traceBlock" }],
    },
  };
  it("counts added, removed and changed methods across tiers", () => {
    const after = {
      jsonrpc: {
        regular: [{ m: "eth_blockNumber", d: "the latest block" }, { m: "eth_gasPrice" }],
        debug: [{ m: "debug_traceBlock" }],
        trace: [{ m: "trace_block" }],
      },
    };
    expect(diffMethodEntry(before, after)).toEqual({ added: 2, removed: 1, changed: 1 });
  });
  it("is zero for an identical entry and tolerates a missing side", () => {
    expect(diffMethodEntry(before, before)).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(diffMethodEntry(undefined, before)).toEqual({ added: 3, removed: 0, changed: 0 });
  });
});

describe("attributeToImports", () => {
  it("names the base every changed spec imports", () => {
    const { shared, covered } = attributeToImports(["ARBITRUM", "ARBITRUMS", "SDN"], specIndex);
    expect(shared.map((s) => s.index)).toEqual(["ETH1"]);
    expect(covered).toBe(3);
  });
  it("counts a base that changed alongside its importers as its own cause", () => {
    const { shared } = attributeToImports(["ETH1", "ARBITRUM", "SDN"], specIndex);
    expect(shared.map((s) => s.index)).toEqual(["ETH1"]);
  });
  it("names the most specific shared ancestor first", () => {
    const { shared } = attributeToImports(["OSMOSIS", "COSMOSSDK50"], specIndex);
    expect(shared.map((s) => s.index)).toEqual(["COSMOSSDK50", "COSMOSSDK"]);
  });
  it("finds nothing in common for unrelated specs", () => {
    expect(attributeToImports(["SDN", "XRT"], specIndex).shared).toEqual([]);
    expect(attributeToImports([], specIndex)).toEqual({ shared: [], covered: 0 });
  });
  it("treats a single changed spec as its own cause", () => {
    expect(attributeToImports(["XRT"], specIndex).shared.map((s) => s.index)).toEqual(["XRT"]);
  });
});

describe("summarizeMethodDrift", () => {
  const before = {
    ETH1: { jsonrpc: { regular: [{ m: "eth_blockNumber" }] } },
    SDN: { jsonrpc: { regular: [{ m: "eth_blockNumber" }] } },
    XRT: { jsonrpc: { regular: [{ m: "chain_getBlock" }] } },
  };
  const bump = (e) => ({ jsonrpc: { regular: [...e.jsonrpc.regular, { m: "eth_new" }] } });

  it("is empty when nothing changed", () => {
    expect(summarizeMethodDrift(before, before, specIndex)).toEqual([]);
  });
  it("prints per-spec counts and attributes a shared base", () => {
    const after = { ...before, ETH1: bump(before.ETH1), SDN: bump(before.SDN) };
    const lines = summarizeMethodDrift(before, after, specIndex);
    expect(lines[0]).toBe("  methods changed (2):");
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}ETH1 +\+1 -0 ~0$/));
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}SDN +\+1 -0 ~0$/));
    expect(lines.join("\n")).toContain("every changed spec is, or imports, ETH1 (ethereum.json)");
    expect(lines.join("\n")).toContain("one base-spec change, not 2 unrelated ones");
  });
  it("says so when the changed specs share no import", () => {
    const after = { ...before, SDN: bump(before.SDN), XRT: { jsonrpc: { regular: [] } } };
    expect(summarizeMethodDrift(before, after, specIndex).join("\n")).toContain(
      "no import in common",
    );
  });
  it("names the file when a single spec changed on its own", () => {
    const after = { ...before, XRT: { jsonrpc: { regular: [] } } };
    expect(summarizeMethodDrift(before, after, specIndex).join("\n")).toContain(
      "XRT changed in its own file (xrt.json)",
    );
  });
  it("skips attribution without a spec index and caps the list", () => {
    const after = { ...before, SDN: bump(before.SDN), ETH1: bump(before.ETH1) };
    const lines = summarizeMethodDrift(before, after, null, { max: 1 });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("    … and 1 more");
  });
});
