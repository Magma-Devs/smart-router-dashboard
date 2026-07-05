import { describe, expect, it } from "vitest";
import {
  FAMILY_METHODS,
  familyForSpec,
  getInterfaceConfig,
  ifaceCanFire,
  isCatalogInterface,
  listMethods,
  storageKey,
  TIER_ORDER,
} from "../chain-methods";

describe("FAMILY_METHODS catalog", () => {
  it("each family has a non-empty regular list for at least one interface", () => {
    for (const [family, interfaces] of Object.entries(FAMILY_METHODS)) {
      const ifaces = Object.values(interfaces).filter(Boolean);
      expect(ifaces.length).toBeGreaterThan(0);
      const someRegular = ifaces.some((i) => (i?.regular?.length ?? 0) > 0);
      expect(someRegular, `${family} has no regular methods`).toBe(true);
    }
  });

  it("every params string is a valid JSON document or a /path (REST)", () => {
    for (const interfaces of Object.values(FAMILY_METHODS)) {
      for (const [key, cfg] of Object.entries(interfaces)) {
        if (!cfg) continue;
        for (const tier of TIER_ORDER) {
          for (const cmd of cfg[tier] ?? []) {
            if (key === "rest") {
              expect(cmd.params.startsWith("/"), `${cmd.label} path`).toBe(true);
            } else {
              expect(() => JSON.parse(cmd.params), `${cmd.method} params`).not.toThrow();
            }
          }
        }
      }
    }
  });
});

describe("familyForSpec", () => {
  it("maps spec label prefixes onto catalog families", () => {
    expect(familyForSpec("ETH1")).toBe("evm");
    expect(familyForSpec("BASE")).toBe("evm");
    expect(familyForSpec("ARBITRUM")).toBe("evm");
    expect(familyForSpec("OPTM")).toBe("evm");
    expect(familyForSpec("POLYGON1")).toBe("evm");
    expect(familyForSpec("BSC")).toBe("evm");
    expect(familyForSpec("HYPERLIQUID")).toBe("evm");
    expect(familyForSpec("SOLANA")).toBe("solana");
    expect(familyForSpec("NEAR")).toBe("near");
    expect(familyForSpec("STRK")).toBe("starknet");
    expect(familyForSpec("COSMOSHUB")).toBe("cosmos");
    expect(familyForSpec("LAVA")).toBe("cosmos");
    expect(familyForSpec("OSMOSIS")).toBe("cosmos");
    expect(familyForSpec("AXELAR")).toBe("cosmos");
    expect(familyForSpec("BTC")).toBe("bitcoin");
  });

  it("is case-insensitive on the spec label", () => {
    expect(familyForSpec("eth1")).toBe("evm");
    expect(familyForSpec("lava")).toBe("cosmos");
  });

  it("returns null for specs no prefix rule covers", () => {
    expect(familyForSpec("FVM")).toBeNull();
    expect(familyForSpec("")).toBeNull();
  });
});

describe("isCatalogInterface", () => {
  it("admits every transport the drawer recognises", () => {
    expect(isCatalogInterface("jsonrpc")).toBe(true);
    expect(isCatalogInterface("jsonrpc-ws")).toBe(true);
    expect(isCatalogInterface("rest")).toBe(true);
    expect(isCatalogInterface("tendermintrpc")).toBe(true);
    expect(isCatalogInterface("tendermintrpc-ws")).toBe(true);
    expect(isCatalogInterface("grpc")).toBe(true);
    expect(isCatalogInterface("grpc-web")).toBe(true);
  });

  it("rejects raw config ids that aren't drawer transports", () => {
    expect(isCatalogInterface("websocket")).toBe(false);
    expect(isCatalogInterface("")).toBe(false);
  });
});

describe("storageKey", () => {
  it("collapses WS variants to their HTTP counterpart", () => {
    expect(storageKey("jsonrpc-ws")).toBe("jsonrpc");
    expect(storageKey("tendermintrpc-ws")).toBe("tendermintrpc");
  });
  it("collapses grpc-web to grpc", () => {
    expect(storageKey("grpc-web")).toBe("grpc");
  });
  it("is identity for HTTP catalog keys", () => {
    expect(storageKey("jsonrpc")).toBe("jsonrpc");
    expect(storageKey("rest")).toBe("rest");
    expect(storageKey("tendermintrpc")).toBe("tendermintrpc");
    expect(storageKey("grpc")).toBe("grpc");
  });
});

describe("ifaceCanFire", () => {
  it("returns true for HTTP and WS transports", () => {
    expect(ifaceCanFire("jsonrpc")).toBe(true);
    expect(ifaceCanFire("jsonrpc-ws")).toBe(true);
    expect(ifaceCanFire("rest")).toBe(true);
    expect(ifaceCanFire("tendermintrpc")).toBe(true);
    expect(ifaceCanFire("tendermintrpc-ws")).toBe(true);
  });
  it("returns false for gRPC variants the browser can't dial", () => {
    expect(ifaceCanFire("grpc")).toBe(false);
    expect(ifaceCanFire("grpc-web")).toBe(false);
  });
});

describe("getInterfaceConfig", () => {
  it.each([
    { spec: "ETH1", iface: "jsonrpc" },
    { spec: "ETH1", iface: "jsonrpc-ws" },
    { spec: "BASE", iface: "jsonrpc" },
    { spec: "SOLANA", iface: "jsonrpc" },
    { spec: "NEAR", iface: "jsonrpc" },
    { spec: "STRK", iface: "jsonrpc" },
    { spec: "BTC", iface: "jsonrpc" },
    { spec: "LAVA", iface: "tendermintrpc" },
    { spec: "LAVA", iface: "tendermintrpc-ws" },
    { spec: "COSMOSHUB", iface: "rest" },
  ])("returns a non-null config for $spec / $iface", ({ spec, iface }) => {
    const cfg = getInterfaceConfig(spec, iface, false);
    expect(cfg).not.toBeNull();
    expect(cfg?.regular.length).toBeGreaterThan(0);
  });

  it("returns null for interfaces with no catalog", () => {
    // Cosmos family carries rest + tendermintrpc only (rule: no grpc catalog).
    expect(getInterfaceConfig("LAVA", "grpc", false)).toBeNull();
    // Raw config ids that aren't drawer transports never resolve.
    expect(getInterfaceConfig("ETH1", "websocket", false)).toBeNull();
  });

  it("falls back per-interface for unknown specs (jsonrpc→evm, rest/tendermintrpc→cosmos)", () => {
    const jsonrpc = getInterfaceConfig("FVM", "jsonrpc", false);
    expect(jsonrpc?.regular[0]?.method).toBe("eth_blockNumber");
    const rest = getInterfaceConfig("FVM", "rest", false);
    expect(rest?.regular[0]?.params).toBe("/cosmos/base/tendermint/v1beta1/blocks/latest");
    const tm = getInterfaceConfig("FVM", "tendermintrpc", false);
    expect(tm?.regular[0]?.method).toBe("abci_info");
  });

  it("WS variants reuse the catalog of their HTTP counterpart", () => {
    const http = getInterfaceConfig("ETH1", "jsonrpc", true);
    const ws = getInterfaceConfig("ETH1", "jsonrpc-ws", true);
    expect(ws).not.toBeNull();
    expect(ws).toBe(http);
  });

  it("offers the archive tier only when the config marks the archive addon", () => {
    const without = getInterfaceConfig("ETH1", "jsonrpc", false);
    expect(without?.archive).toBeNull();
    const withArchive = getInterfaceConfig("ETH1", "jsonrpc", true);
    expect(withArchive?.archive?.length).toBeGreaterThan(0);
    // Regular methods are identical either way.
    expect(without?.regular).toEqual(withArchive?.regular);
  });

  it("keeps archive-stripped configs identity-stable across calls", () => {
    const a = getInterfaceConfig("ETH1", "jsonrpc", false);
    const b = getInterfaceConfig("ETH1", "jsonrpc", false);
    expect(a).toBe(b);
  });

  it("families with no archive list stay archive-null even with the addon", () => {
    const cfg = getInterfaceConfig("SOLANA", "jsonrpc", true);
    expect(cfg?.archive).toBeNull();
  });
});

describe("listMethods", () => {
  it("flattens tiers in TIER_ORDER and exposes (tier, index, command)", () => {
    const cfg = getInterfaceConfig("ETH1", "jsonrpc", true);
    expect(cfg).not.toBeNull();
    if (!cfg) return;
    const methods = listMethods(cfg);
    const tiers = [...new Set(methods.map((m) => m.tier))];
    // Tiers preserve TIER_ORDER (regular first, etc.).
    const expected = TIER_ORDER.filter((t) => (cfg[t]?.length ?? 0) > 0);
    expect(tiers).toEqual(expected);
    // First entry is regular index 0.
    expect(methods[0]?.tier).toBe("regular");
    expect(methods[0]?.index).toBe(0);
  });

  it("skips nulled tiers (no archive addon → regular only)", () => {
    const cfg = getInterfaceConfig("ETH1", "jsonrpc", false);
    expect(cfg).not.toBeNull();
    if (!cfg) return;
    const tiers = [...new Set(listMethods(cfg).map((m) => m.tier))];
    expect(tiers).toEqual(["regular"]);
  });
});
