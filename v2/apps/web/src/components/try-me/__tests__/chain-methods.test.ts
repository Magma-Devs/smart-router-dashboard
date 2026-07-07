import { beforeAll, describe, expect, it } from "vitest";
import {
  catalogReady,
  FAMILY_METHODS,
  familyForSpec,
  getInterfaceConfig,
  ifaceCanFire,
  isCatalogInterface,
  listMethods,
  storageKey,
  TIER_ORDER,
} from "../chain-methods";

// The full spec-index catalog is dynamically imported — make sure it's in
// place before any getInterfaceConfig assertion runs.
beforeAll(() => catalogReady);

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
  it("maps each spec index onto a catalog family via the generated chain map", () => {
    expect(familyForSpec("ETH1")).toBe("evm");
    expect(familyForSpec("BASE")).toBe("evm");
    expect(familyForSpec("ARBITRUM")).toBe("evm"); // evm-arbitrum collapses to evm
    expect(familyForSpec("OPTM")).toBe("evm");
    expect(familyForSpec("POLYGON")).toBe("evm");
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

  it("defaults an unknown index to evm (the map's fallback family)", () => {
    // The generated per-spec catalog is tried before this fallback ever
    // fires, so a coarse default is safe here.
    expect(familyForSpec("TOTALLY_UNKNOWN")).toBe("evm");
    expect(familyForSpec("")).toBe("evm");
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
    // Raw config ids that aren't drawer transports never resolve.
    expect(getInterfaceConfig("ETH1", "websocket", false)).toBeNull();
    // A known spec with no such interface anywhere: ETH1 declares jsonrpc
    // only, and the evm fallback family has no rest either.
    expect(getInterfaceConfig("ETH1", "rest", false)).toBeNull();
  });

  it("serves grpc for cosmos-family specs from the generated catalog", () => {
    // Pre-generator the cosmos family had no grpc catalog; the lava-specs
    // grpc collections now provide one.
    const cfg = getInterfaceConfig("LAVA", "grpc", false);
    expect(cfg?.regular.length).toBeGreaterThan(0);
    expect(cfg?.regular[0]?.method).toContain("/");
  });

  it("falls back per-interface for unknown specs (jsonrpc→evm, rest/tendermintrpc→cosmos)", () => {
    // "NOPE" is in no spec file and matches no family prefix.
    const jsonrpc = getInterfaceConfig("NOPE", "jsonrpc", false);
    expect(jsonrpc?.regular[0]?.method).toBe("eth_blockNumber");
    const rest = getInterfaceConfig("NOPE", "rest", false);
    expect(rest?.regular[0]?.params).toBe("/cosmos/base/tendermint/v1beta1/blocks/latest");
    const tm = getInterfaceConfig("NOPE", "tendermintrpc", false);
    expect(tm?.regular[0]?.method).toBe("abci_info");
  });

  it("does NOT invent a catalog for an interface a KNOWN spec doesn't serve", () => {
    // FVM (Filecoin) is in the chain map as jsonrpc-only. A router wouldn't
    // expose it over rest/tendermintrpc, so those return null rather than a
    // bogus cosmos catalog (the per-interface fallback is for UNKNOWN specs).
    expect(getInterfaceConfig("FVM", "rest", false)).toBeNull();
    expect(getInterfaceConfig("FVM", "tendermintrpc", false)).toBeNull();
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

  it("skips nulled tiers (no archive addon → regular, debug, trace)", () => {
    const cfg = getInterfaceConfig("ETH1", "jsonrpc", false);
    expect(cfg).not.toBeNull();
    if (!cfg) return;
    const tiers = [...new Set(listMethods(cfg).map((m) => m.tier))];
    expect(tiers).toEqual(["regular", "debug", "trace"]);
  });
});

describe("generated lava-specs catalog", () => {
  it("ETH1 jsonrpc regular includes eth_blockNumber with empty params", () => {
    const cfg = getInterfaceConfig("ETH1", "jsonrpc", false);
    const blockNumber = cfg?.regular.find((c) => c.method === "eth_blockNumber");
    expect(blockNumber).toBeDefined();
    expect(blockNumber?.params).toBe("[]");
    // Full spec coverage — way beyond the 11-method curated fallback list.
    expect(cfg?.regular.length).toBeGreaterThan(20);
  });

  it("ETH1 exposes debug and trace tiers from the spec's add_on collections", () => {
    const cfg = getInterfaceConfig("ETH1", "jsonrpc", false);
    expect(cfg?.debug?.length).toBeGreaterThan(0);
    expect(cfg?.debug?.some((c) => c.method === "debug_traceTransaction")).toBe(true);
    expect(cfg?.trace?.length).toBeGreaterThan(0);
    expect(cfg?.trace?.some((c) => c.method === "trace_block")).toBe(true);
  });

  it("ETH1 archive tier is synthesised from the archive extension when offered", () => {
    const cfg = getInterfaceConfig("ETH1", "jsonrpc", true);
    expect(cfg?.archive?.length).toBeGreaterThan(0);
    expect(cfg?.archive?.[0]?.method).toBe("eth_getBalance");
  });

  it("COSMOSHUB inherits rest + tendermintrpc + grpc through transitive imports", () => {
    // COSMOSHUB → COSMOSSDK50 → COSMOSSDK → IBC/TENDERMINT: none of these
    // methods are declared on the COSMOSHUB spec itself.
    const rest = getInterfaceConfig("COSMOSHUB", "rest", false);
    expect(
      rest?.regular.some(
        (c) => c.params === "/cosmos/base/tendermint/v1beta1/blocks/latest",
      ),
    ).toBe(true);
    const tm = getInterfaceConfig("COSMOSHUB", "tendermintrpc", false);
    expect(tm?.regular.some((c) => c.method === "status")).toBe(true);
    const grpc = getInterfaceConfig("COSMOSHUB", "grpc", false);
    expect(
      grpc?.regular.some(
        (c) => c.method === "cosmos.base.tendermint.v1beta1.Service/GetLatestBlock",
      ),
    ).toBe(true);
  });

  it("SOLANA jsonrpc regular contains getSlot", () => {
    const cfg = getInterfaceConfig("SOLANA", "jsonrpc", false);
    expect(cfg?.regular.some((c) => c.method === "getSlot")).toBe(true);
  });

  it("unknown indices fall back to the family heuristic", () => {
    const cfg = getInterfaceConfig("NOPE", "jsonrpc", false);
    expect(cfg).not.toBeNull();
    expect(cfg?.regular[0]?.method).toBe("eth_blockNumber");
    // Identical to the evm fallback config (identity via the stripped cache).
    expect(cfg).toBe(getInterfaceConfig("NOPE2", "jsonrpc", false));
  });

  it("REST commands expand with the HTTP verb as method and the path as params", () => {
    const cfg = getInterfaceConfig("COSMOSHUB", "rest", false);
    const first = cfg?.regular[0];
    expect(first?.method).toBe("GET");
    expect(first?.params.startsWith("/")).toBe(true);
    expect(first?.label.startsWith("/")).toBe(true);
  });

  it("expanded configs are identity-stable across calls (memoized)", () => {
    const a = getInterfaceConfig("COSMOSHUB", "rest", false);
    const b = getInterfaceConfig("COSMOSHUB", "rest", false);
    expect(a).toBe(b);
    // Alias entries (testnet → mainnet) share the canonical expansion.
    const hub = getInterfaceConfig("COSMOSHUB", "rest", true);
    const hubT = getInterfaceConfig("COSMOSHUBT", "rest", true);
    expect(hubT).toBe(hub);
  });
});
