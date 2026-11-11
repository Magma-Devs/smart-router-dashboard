import { describe, expect, it } from "vitest";
import { looksLikeNodeName, providerOf } from "../constants/providers.js";

describe("providerOf", () => {
  it.each([
    ["tatum", "tatum", "Tatum", null],
    ["blockdaemon", "blockdaemon", "Blockdaemon", null],
    ["blockdaemon-2", "blockdaemon", "Blockdaemon", "2"],
    ["alchemy", "alchemy", "Alchemy", null],
    ["quicknode", "quicknode", "QuickNode", null],
    ["lava", "lava", "Lava", null],
    ["lavanet", "lava", "Lava", null],
    ["eth-lava", "lava", "Lava", null],
    ["blockfrost", "blockfrost", "Blockfrost", null],
    ["casper", "casper", "casper", null],
  ])("groups %s under %s", (name, id, display, account) => {
    expect(providerOf({ name })).toEqual({ id, name: display, account });
  });

  it("a URL host match beats the node name", () => {
    expect(providerOf({ name: "eth-main", urlHosts: ["eth-mainnet.gateway.tatum.io"] }).id).toBe("tatum");
    expect(providerOf({ name: "lava", urlHosts: ["x.quiknode.pro"] }).id).toBe("quicknode");
    expect(providerOf({ name: "eth-public", urlHosts: ["rpc.ankr.com"] }).id).toBe("ankr");
    expect(providerOf({ name: "bsc-x", urlHosts: ["bsc.blockpi.io"] }).id).toBe("blockpi");
  });

  it("the values file's group-label beats both", () => {
    expect(providerOf({ name: "lava", urlHosts: ["x.quiknode.pro"], groupLabel: "publicnode" })).toEqual({
      id: "publicnode",
      name: "PublicNode",
      account: null,
    });
    expect(providerOf({ name: "eth-x", groupLabel: "Acme Nodes" })).toEqual({
      id: "acme nodes",
      name: "Acme Nodes",
      account: null,
    });
  });
});

describe("looksLikeNodeName", () => {
  it.each(["tatum", "blockdaemon-2", "eth-lava", "node_1", "Polymesh"])("accepts %s", (n) => {
    expect(looksLikeNodeName(n)).toBe(true);
  });
  it.each(["d644d", "0c539", "gzip,", "https", '{"sch', "", "Cached"])("rejects %s", (n) => {
    expect(looksLikeNodeName(n)).toBe(false);
  });
});
