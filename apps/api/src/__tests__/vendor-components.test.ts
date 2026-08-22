import { describe, expect, it } from "vitest";
import { VENDOR_IDENTITIES, matchVendor, type RouterTopology, type VendorChainComponent } from "@sr/shared";
import {
  REASON_DETAIL_UNREADABLE,
  REASON_NO_FEED,
  REASON_UNMAPPED,
  chainAliases,
  chainVerdict,
  collectVendorChainUse,
  matchChainComponents,
  normalizeComponentStatus,
  splitComponentName,
} from "../services/vendor-components.js";

/** Component names copied from the live status pages of the vendors this
 *  repo's dev topology points at — the matcher is only worth what it does to
 *  the real strings. */
const QUICKNODE: VendorChainComponent[] = [
  { name: "Ethereum · Mainnet — JSON-RPC API", status: "operational" },
  { name: "Ethereum · Mainnet — Websockets API", status: "minor" },
  { name: "Ethereum · Mainnet Beacon — REST API", status: "operational" },
  { name: "Ethereum · Mainnet — Webhooks", status: "operational" },
  { name: "Ethereum · Mainnet — Streams", status: "operational" },
  { name: "Ethereum · Sepolia — JSON-RPC API", status: "major" },
  { name: "Ethereum · Hoodi - JSON-RPC API", status: "major" },
  { name: "Ethereum · Ethereum Mainnet BlockBook", status: "minor" },
  { name: "BNB Smart Chain (BSC) · Mainnet — JSON-RPC API", status: "minor" },
  { name: "BNB Smart Chain (BSC) · Mainnet — WebSocket API", status: "minor" },
  { name: "Ink (Beta) · Mainnet — Websockets API", status: "maintenance" },
  { name: "Starknet · Sepolia — JSON-RPC API", status: "maintenance" },
];

const DRPC: VendorChainComponent[] = [
  { name: "Ethereum · Ethereum Mainnet", status: "operational" },
  { name: "Ethereum · Ethereum Sepolia", status: "major" },
  { name: "Ethereum · Ethereum Holesky", status: "major" },
];

/** Tenderly spends the word "Ethereum" on Boba and files Ethereum mainnet as
 *  plain "Mainnet" (their host is mainnet.gateway.tenderly.co). */
const TENDERLY: VendorChainComponent[] = [
  { name: "Boba Ethereum · Node RPC", status: "major" },
  { name: "Boba Ethereum · Explorer", status: "operational" },
  { name: "Ethereum Classic · Node RPC", status: "major" },
  { name: "Mainnet · Node RPC", status: "operational" },
  { name: "Mainnet · Explorer", status: "major" },
  { name: "Mainnet · Simulator", status: "major" },
  { name: "Mainnet · Virtual Testnet", status: "major" },
];

const ALCHEMY: VendorChainComponent[] = [
  { name: "Ethereum", status: "operational" },
  { name: "Solana", status: "minor" },
  { name: "Bitcoin", status: "operational" },
];

describe("splitComponentName", () => {
  it("splits on the four separators the pages actually use", () => {
    expect(splitComponentName("Ethereum · Mainnet — JSON-RPC API")).toEqual([
      "Ethereum",
      "Mainnet",
      "JSON-RPC API",
    ]);
    expect(splitComponentName("Ethereum · Hoodi - JSON-RPC API")).toEqual([
      "Ethereum",
      "Hoodi",
      "JSON-RPC API",
    ]);
    expect(splitComponentName("Unichain (Beta) · Mainnet – Websockets API")).toEqual([
      "Unichain (Beta)",
      "Mainnet",
      "Websockets API",
    ]);
  });

  it("does NOT tear a hyphenated surface name in half", () => {
    // A bare `-` is part of "JSON-RPC"; only a spaced one separates segments.
    expect(splitComponentName("Ethereum · Mainnet — JSON-RPC API")).toContain("JSON-RPC API");
  });
});

describe("chainAliases", () => {
  it("uses the chain map's own name, plus the aliases pages actually print", () => {
    expect(chainAliases("ETH1")).toEqual(["ethereum"]);
    expect(chainAliases("COSMOSHUB")).toEqual(["cosmos hub", "cosmos"]);
    expect(chainAliases("SOLANA")).toEqual(["solana"]);
  });

  it("adds a vendor's own spelling only for that vendor", () => {
    // Tenderly calls Ethereum mainnet "Mainnet"; on anyone else's page that
    // word could be any chain, so it stays scoped.
    expect(chainAliases("ETH1", "tenderly")).toEqual(["ethereum", "mainnet"]);
    expect(chainAliases("ETH1", "quicknode")).toEqual(["ethereum"]);
  });

  it("does not read a prototype member as an alias table", () => {
    expect(chainAliases("ETH1", "constructor")).toEqual(["ethereum"]);
    expect(chainAliases("constructor")).toEqual(["constructor"]);
  });
});

describe("matchChainComponents", () => {
  it("takes the Ethereum JSON-RPC component and leaves the rest of the page alone", () => {
    const matched = matchChainComponents("ETH1", ["rpc"], QUICKNODE);
    expect(matched.map((c) => c.name)).toEqual(["Ethereum · Mainnet — JSON-RPC API"]);
  });

  it("ignores a vendor's OTHER chains — QuickNode's BSC trouble is not ours", () => {
    // The exact case this whole per-chain rework exists for: the vendor is
    // globally "minor" because of BSC, Ink and a Starknet testnet, and our
    // Ethereum endpoint is green.
    const matched = matchChainComponents("ETH1", ["rpc"], QUICKNODE);
    expect(matched.every((c) => c.status === "operational")).toBe(true);
    expect(matched.some((c) => c.name.includes("BNB"))).toBe(false);
  });

  it("counts Websockets only when the node actually declares a ws endpoint", () => {
    expect(matchChainComponents("ETH1", ["rpc"], QUICKNODE).map((c) => c.name)).not.toContain(
      "Ethereum · Mainnet — Websockets API",
    );
    expect(matchChainComponents("ETH1", ["rpc", "ws"], QUICKNODE).map((c) => c.name)).toContain(
      "Ethereum · Mainnet — Websockets API",
    );
  });

  it("keeps REST and gRPC components only for the interface that dials them", () => {
    expect(matchChainComponents("ETH1", ["rpc"], QUICKNODE).map((c) => c.name)).not.toContain(
      "Ethereum · Mainnet Beacon — REST API",
    );
    expect(matchChainComponents("ETH1", ["rest"], QUICKNODE).map((c) => c.name)).toEqual([
      "Ethereum · Mainnet Beacon — REST API",
    ]);
  });

  it("drops products that are not an endpoint we dial", () => {
    const names = matchChainComponents("ETH1", ["rpc", "ws", "rest"], QUICKNODE).map((c) => c.name);
    expect(names.some((n) => n.includes("Webhooks"))).toBe(false);
    expect(names.some((n) => n.includes("Streams"))).toBe(false);
    expect(names.some((n) => n.includes("BlockBook"))).toBe(false);
  });

  it("drops the vendor's testnets for a mainnet spec", () => {
    const names = matchChainComponents("ETH1", ["rpc"], [...QUICKNODE, ...DRPC]).map((c) => c.name);
    expect(names.some((n) => /Sepolia|Holesky|Hoodi/.test(n))).toBe(false);
  });

  it("matches a page that names the chain twice instead of a surface", () => {
    expect(matchChainComponents("ETH1", ["rpc"], DRPC).map((c) => c.name)).toEqual([
      "Ethereum · Ethereum Mainnet",
    ]);
  });

  it("matches a page whose component IS the bare chain name", () => {
    expect(matchChainComponents("ETH1", ["rpc"], ALCHEMY).map((c) => c.name)).toEqual(["Ethereum"]);
    expect(matchChainComponents("SOLANA", ["rpc"], ALCHEMY).map((c) => c.name)).toEqual(["Solana"]);
  });

  it("never matches a chain whose name merely CONTAINS ours", () => {
    // Tenderly publishes "Boba Ethereum" and "Ethereum Classic"; a substring
    // match would report Boba's outage as Ethereum's. Without their own
    // spelling, nothing on their page maps at all.
    expect(matchChainComponents("ETH1", ["rpc", "ws"], TENDERLY)).toEqual([]);
  });

  it("uses a vendor's own spelling when we have verified it", () => {
    // Tenderly's Ethereum mainnet RPC is "Mainnet · Node RPC"; their Explorer,
    // Simulator and Virtual Testnet under the same name are not endpoints we
    // dial and stay out of the verdict.
    expect(matchChainComponents("ETH1", ["rpc", "ws"], TENDERLY, "tenderly").map((c) => c.name)).toEqual([
      "Mainnet · Node RPC",
    ]);
    // Another vendor's page saying "Mainnet" is not evidence about Ethereum.
    expect(matchChainComponents("ETH1", ["rpc"], TENDERLY, "quicknode")).toEqual([]);
  });
});

describe("chainVerdict", () => {
  const detail = (components: VendorChainComponent[], officialStatus = "minor") => ({
    officialStatus,
    components,
  });

  it("is the worst matched component, not the vendor's headline", () => {
    expect(chainVerdict("ETH1", ["rpc"], detail(QUICKNODE))).toEqual({
      status: "operational",
      components: [{ name: "Ethereum · Mainnet — JSON-RPC API", status: "operational" }],
      reason: null,
    });
  });

  it("takes the worst when several components match", () => {
    const verdict = chainVerdict("ETH1", ["rpc", "ws"], detail(QUICKNODE));
    expect(verdict.status).toBe("minor");
    expect(verdict.components).toHaveLength(2);
  });

  it("ranks maintenance below a real fault and above operational", () => {
    const both = detail([
      { name: "Ethereum · Mainnet — JSON-RPC API", status: "maintenance" },
      { name: "Ethereum · Mainnet — Websockets API", status: "operational" },
    ]);
    expect(chainVerdict("ETH1", ["rpc", "ws"], both).status).toBe("maintenance");
    const worse = detail([
      { name: "Ethereum · Mainnet — JSON-RPC API", status: "maintenance" },
      { name: "Ethereum · Mainnet — Websockets API", status: "major" },
    ]);
    expect(chainVerdict("ETH1", ["rpc", "ws"], worse).status).toBe("major");
  });

  it("says so when nothing on the page maps to the chain", () => {
    expect(chainVerdict("ETH1", ["rpc", "ws"], detail(TENDERLY, "operational"))).toEqual({
      status: "unknown",
      components: [],
      reason: REASON_UNMAPPED,
    });
  });

  it("says so when the vendor publishes no machine-readable feed", () => {
    expect(chainVerdict("ETH1", ["rpc"], detail([], "unavailable"))).toEqual({
      status: "unavailable",
      components: [],
      reason: REASON_NO_FEED,
    });
  });

  it("says so when the index could not be read for that vendor", () => {
    expect(chainVerdict("ETH1", ["rpc"], null)).toEqual({
      status: "unknown",
      components: [],
      reason: REASON_DETAIL_UNREADABLE,
    });
  });
});

describe("normalizeComponentStatus", () => {
  it("translates Statuspage's raw words into the index's vocabulary", () => {
    expect(normalizeComponentStatus("major_outage")).toBe("major");
    expect(normalizeComponentStatus("partial_outage")).toBe("minor");
    expect(normalizeComponentStatus("degraded_performance")).toBe("minor");
    expect(normalizeComponentStatus("under_maintenance")).toBe("maintenance");
    expect(normalizeComponentStatus("Operational")).toBe("operational");
    expect(normalizeComponentStatus(null)).toBe("unknown");
  });
});

describe("collectVendorChainUse", () => {
  const routers: RouterTopology[] = [
    {
      id: "eth-router",
      spec: "ETH1",
      network: "eth1",
      pathBased: false,
      customUrlPrefix: null,
      localPort: 3360,
      localPorts: { jsonrpc: 3360 },
      publicUrls: {},
      interfaces: ["jsonrpc"],
      nodes: [
        {
          name: "eth-quicknode",
          isBackup: false,
          endpoints: [
            { urlHost: "https://lively-multi-leaf.ethereum-mainnet.quiknode.pro", interface: "jsonrpc", addons: [], index: 0, directable: true, internalPath: null },
          ],
        },
        {
          name: "eth-tenderly",
          isBackup: false,
          endpoints: [
            { urlHost: "https://mainnet.gateway.tenderly.co", interface: "jsonrpc", addons: [], index: 0, directable: true, internalPath: null },
            { urlHost: "wss://mainnet.gateway.tenderly.co", interface: "jsonrpc", addons: [], index: 1, directable: true, internalPath: null },
          ],
        },
        {
          name: "eth-publicnode",
          isBackup: false,
          endpoints: [
            { urlHost: "https://ethereum-rpc.publicnode.com", interface: "jsonrpc", addons: [], index: 0, directable: true, internalPath: null },
          ],
        },
      ],
    },
    {
      id: "cosmos-router",
      spec: "COSMOSHUB",
      network: "cosmoshub",
      pathBased: false,
      customUrlPrefix: null,
      localPort: 3364,
      localPorts: { rest: 3364 },
      publicUrls: {},
      interfaces: ["rest", "grpc"],
      nodes: [
        {
          name: "cosmos-getblock",
          isBackup: false,
          endpoints: [
            { urlHost: "https://go.getblock.io", interface: "rest", addons: [], index: 0, directable: true, internalPath: null },
            { urlHost: "grpcs://grpc.getblock.io:443", interface: "grpc", addons: [], index: 1, directable: false, internalPath: null },
          ],
        },
      ],
    },
  ];

  it("reports one entry per (vendor, chain) with the surfaces we dial", () => {
    expect(collectVendorChainUse(routers)).toEqual([
      { slug: "quicknode", spec: "ETH1", surfaces: ["rpc"] },
      { slug: "tenderly", spec: "ETH1", surfaces: ["rpc", "ws"] },
      { slug: "getblock", spec: "COSMOSHUB", surfaces: ["rest", "grpc"] },
    ]);
  });

  it("skips nodes no vendor sells — a public endpoint has no status page", () => {
    expect(collectVendorChainUse(routers).some((u) => u.slug === "publicnode")).toBe(false);
  });

  it("is empty when nothing is mounted", () => {
    expect(collectVendorChainUse([])).toEqual([]);
  });
});

/**
 * The vendor map is only useful where it lines up with the index's own roster:
 * an id we don't carry can never light a chip however loudly that vendor's
 * status page is burning (OnFinality spent a major outage invisible for
 * exactly this reason), and an id the index doesn't know would fetch 404s.
 */
describe("vendor identities ↔ the index's slugs", () => {
  /** `GET /v1/public/provider-status` on the hosted index, 2026-08-21. */
  const SPI_SLUGS = [
    "alchemy",
    "ankr",
    "blockdaemon",
    "blockpi",
    "chainstack",
    "coinbase-developer-platform",
    "drpc",
    "dwellir",
    "getblock",
    "grove",
    "helius",
    "infura",
    "moralis",
    "nodereal",
    "nownodes",
    "onfinality",
    "quicknode",
    "tatum",
    "tenderly",
    "triton-one",
  ];

  it("covers the roster exactly — drift either way is a bug", () => {
    expect([...VENDOR_IDENTITIES.map((v) => v.id)].sort()).toEqual([...SPI_SLUGS].sort());
  });

  it("identifies the vendors by the hosts a values file actually carries", () => {
    const cases: [string, string, string][] = [
      ["eth-quicknode", "https://lively-multi-leaf.ethereum-mainnet.quiknode.pro", "quicknode"],
      ["eth-tenderly", "https://mainnet.gateway.tenderly.co", "tenderly"],
      ["eth-drpc", "https://eth.drpc.org", "drpc"],
      ["sol-helius", "https://mainnet.helius-rpc.com", "helius"],
      ["eth-grove", "https://eth.rpc.grove.city", "grove"],
      ["sol-triton", "https://solana-mainnet.rpcpool.com", "triton-one"],
      ["eth-onfinality", "https://eth.api.onfinality.io", "onfinality"],
      ["eth-moralis", "https://site1.moralis-nodes.com", "moralis"],
    ];
    for (const [node, host, expected] of cases) {
      expect(matchVendor(node, [host])?.id).toBe(expected);
    }
  });

  it("leaves a node no vendor sells unmatched", () => {
    expect(matchVendor("eth-publicnode", ["https://ethereum-rpc.publicnode.com"])).toBeNull();
    expect(matchVendor("eth-mevblocker", ["https://rpc.mevblocker.io"])).toBeNull();
  });
});
