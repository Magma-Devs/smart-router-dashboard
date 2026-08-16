import { describe, expect, it } from "vitest";
import {
  COMMON_METHODS,
  friendlyName,
  humanizeMethod,
  isCommonMethod,
} from "../method-label";
import type { AddonCommand } from "../chain-methods";

const cmd = (over: Partial<AddonCommand> & { method: string }): AddonCommand => ({
  label: over.method,
  params: "[]",
  ...over,
});

describe("humanizeMethod", () => {
  it("drops the namespace and splits camelCase", () => {
    expect(humanizeMethod("eth_getBlockByNumber")).toBe("Get Block By Number");
    expect(humanizeMethod("debug_getRawReceipts")).toBe("Get Raw Receipts");
    expect(humanizeMethod("debug_storageRangeAt")).toBe("Storage Range At");
    expect(humanizeMethod("trace_replayBlockTransactions")).toBe("Replay Block Transactions");
    expect(humanizeMethod("starknet_getEvents")).toBe("Get Events");
    expect(humanizeMethod("chain_getBlockHash")).toBe("Get Block Hash");
    expect(humanizeMethod("Filecoin.ChainHead")).toBe("Chain Head");
  });

  it("names the gRPC method, not its package path", () => {
    expect(humanizeMethod("cosmos.base.tendermint.v1beta1.Service/GetLatestBlock")).toBe(
      "Get Latest Block",
    );
    expect(humanizeMethod("concordium.v2.Queries/GetConsensusInfo")).toBe(
      "Get Consensus Info",
    );
  });

  it("splits run-together ids through the vocabulary", () => {
    expect(humanizeMethod("getblockcount")).toBe("Get Block Count");
    expect(humanizeMethod("getbestblockhash")).toBe("Get Best Block Hash");
    // "blockchain" has to beat "block" at the front, and the tail still fits.
    expect(humanizeMethod("getblockchaininfo")).toBe("Get Blockchain Info");
    expect(humanizeMethod("getnowblock")).toBe("Get Now Block");
  });

  it("keeps acronyms uppercase", () => {
    expect(humanizeMethod("abci_info")).toBe("ABCI Info");
    expect(humanizeMethod("eth_getBlockRlp")).toBe("Get Block RLP");
    // An all-caps run in the id is an acronym of its own — "Lll" reads as a typo.
    expect(humanizeMethod("eth_compileLLL")).toBe("Compile LLL");
  });

  it("returns null rather than a name that adds nothing", () => {
    // No namespace to drop and no words to separate.
    expect(humanizeMethod("status")).toBeNull();
    expect(humanizeMethod("health")).toBeNull();
    expect(humanizeMethod("validators")).toBeNull();
  });

  it("returns null rather than mangling an unsplittable compound", () => {
    // Starts with a vocabulary word, so it IS a compound — but "template"
    // isn't in the vocabulary, and "Getblocktemplate" would be worse than the
    // id itself.
    expect(humanizeMethod("getblocktemplate")).toBeNull();
    expect(humanizeMethod("")).toBeNull();
  });
});

describe("friendlyName", () => {
  it("prefers the catalog's own label — archive commands carry one", () => {
    expect(
      friendlyName("jsonrpc", cmd({ method: "eth_getBalance", label: "Get Balance (Archive)" })),
    ).toBe("Get Balance (Archive)");
  });

  it("falls back to the curated name, then to a derived one", () => {
    expect(friendlyName("jsonrpc", cmd({ method: "eth_blockNumber" }))).toBe("Block Number");
    expect(friendlyName("jsonrpc", cmd({ method: "debug_getRawHeader" }))).toBe("Raw Header");
    // Nothing curated, nothing derivable → the caller renders the bare id.
    expect(friendlyName("tendermintrpc", cmd({ method: "genesis" }))).toBeNull();
  });

  it("names every debug and trace method the curated map carries", () => {
    for (const [method, label] of Object.entries(COMMON_METHODS.jsonrpc ?? {})) {
      if (!/^(debug|trace|arbtrace)_/.test(method)) continue;
      expect(friendlyName("jsonrpc", cmd({ method })), method).toBe(label);
      expect(isCommonMethod("jsonrpc", cmd({ method })), method).toBe(true);
    }
  });
});
