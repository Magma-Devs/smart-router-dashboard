/* Upstream catalogue + chain-hint helpers — ported verbatim from the design
 * prototype (page-providers.jsx: UPSTREAM_DOMAINS/COLORS/CATALOG,
 * CHAIN_URL_HINTS/parseUrlChain, EVM_CHAINS/CHAIN_IFACES/IFACE_LABEL,
 * parseJwtExpiry, PROBE_CAPS) plus the DESIGN_CHAINS palette from data.jsx.
 *
 * Self-hosted reality: upstreams come from the read-only mounted values
 * file. Catalog entries drive presentation only (logos, "looks like X"
 * hints) — never data. */

import type { UpstreamMetrics, RouterTopology } from "@sr/shared";

/** The honest-state copy for every config-mutating commit button. */
export const READONLY_MSG = "Config is a read-only mount on self-hosted — edit the values file";
/** The honest-state copy for JWT reissue/revoke/reveal controls. */
export const JWT_CLOUD_MSG = "JWT management is a Magma Cloud feature — no tokens exist on this self-hosted deployment";

/* ─────────────────────────────────────────────
   Upstream logos — Clearbit with SVG fallback
───────────────────────────────────────────── */
export const UPSTREAM_DOMAINS: Record<string, string> = {
  alchemy:     "alchemy.com",
  infura:      "infura.io",
  quicknode:   "quicknode.com",
  ankr:        "ankr.com",
  chainstack:  "chainstack.com",
  drpc:        "drpc.org",
  getblock:    "getblock.io",
  blockpi:     "blockpi.io",
  nodereal:    "nodereal.io",
  tatum:       "tatum.io",
  blockdaemon: "blockdaemon.com",
};

/* Fallback brand colors when Clearbit fails */
export const UPSTREAM_COLORS: Record<string, string> = {
  alchemy: "#0C4EFF", infura: "#FF6B2B", quicknode: "#0070F3",
  ankr: "#2563EB", chainstack: "#16A34A", drpc: "#7C3AED",
  getblock: "#D97706", blockpi: "#DB2777", nodereal: "#0EA5E9",
  tatum: "#EF4444", blockdaemon: "#1A56DB",
};

/* ─────────────────────────────────────────────
   Upstream catalogue — no chain assumptions
───────────────────────────────────────────── */
export interface UpstreamCatalogEntry {
  id: string;
  name: string;
  flow: "A" | "B";
  color: string;
  supportsJWT: boolean;
  domainPattern?: RegExp;
}

export const UPSTREAM_CATALOG: UpstreamCatalogEntry[] = [
  { id: "alchemy",     name: "Alchemy",     flow: "A", color: "#0C4EFF", supportsJWT: true  },
  { id: "infura",      name: "Infura",      flow: "A", color: "#FF6B2B", supportsJWT: true  },
  { id: "quicknode",   name: "QuickNode",   flow: "B", color: "#0070F3", supportsJWT: true,  domainPattern: /\.quiknode\.pro/ },
  { id: "ankr",        name: "Ankr",        flow: "A", color: "#2563EB", supportsJWT: true  },
  { id: "chainstack",  name: "Chainstack",  flow: "B", color: "#16A34A", supportsJWT: false, domainPattern: /\.p2pify\.com|chainstack/ },
  { id: "drpc",        name: "dRPC",        flow: "A", color: "#7C3AED", supportsJWT: false },
  { id: "getblock",    name: "GetBlock",    flow: "B", color: "#D97706", supportsJWT: false, domainPattern: /getblock\.io/ },
  { id: "blockpi",     name: "BlockPI",     flow: "B", color: "#DB2777", supportsJWT: false, domainPattern: /blockpi\.network/ },
  { id: "nodereal",    name: "NodeReal",    flow: "A", color: "#0EA5E9", supportsJWT: false },
  { id: "tatum",       name: "Tatum",       flow: "B", color: "#EF4444", supportsJWT: false, domainPattern: /gateway\.tatum\.io/ },
  { id: "blockdaemon", name: "Blockdaemon", flow: "B", color: "#1A56DB", supportsJWT: false, domainPattern: /blockdaemon\.com/ },
];

export const CHAIN_URL_HINTS: { chain: string; patterns: RegExp[] }[] = [
  { chain: "btc",  patterns: [/bitcoin[^-]|btc/i] },
  { chain: "bch",  patterns: [/bitcoin-cash|bitcoincash|bch/i] },
  { chain: "xrp",  patterns: [/ripple|xrp/i] },
  { chain: "eth",  patterns: [/eth|mainnet|ethereum/i] },
  { chain: "arb",  patterns: [/arb|arbitrum/i] },
  { chain: "base", patterns: [/base/i] },
  { chain: "bsc",  patterns: [/bsc|bnb|binance/i] },
  { chain: "optm", patterns: [/opt|optimism/i] },
  { chain: "poly", patterns: [/poly|matic/i] },
  { chain: "avax", patterns: [/avax|avalanche/i] },
  { chain: "sol",  patterns: [/sol|solana/i] },
];

export function parseUrlChain(url: string): string | null {
  for (const h of CHAIN_URL_HINTS) if (h.patterns.some((p) => p.test(url))) return h.chain;
  return null;
}

/* ── Chain → supported interfaces (design ids) ── */
export const EVM_CHAINS = new Set(["eth","arb","base","bsc","optm","poly","avax","zksync","scroll","linea","mantle","celo","ftm"]);

export const CHAIN_IFACES: Record<string, string[]> = {
  eth: ["jsonrpc","websocket"], arb: ["jsonrpc","websocket"], base: ["jsonrpc","websocket"],
  bsc: ["jsonrpc","websocket"], optm: ["jsonrpc","websocket"], poly: ["jsonrpc","websocket"],
  avax: ["jsonrpc","websocket"], zksync: ["jsonrpc","websocket"], scroll: ["jsonrpc","websocket"],
  linea: ["jsonrpc","websocket"], mantle: ["jsonrpc","websocket"], celo: ["jsonrpc","websocket"],
  ftm: ["jsonrpc","websocket"], strk: ["jsonrpc","websocket"],
  sol: ["jsonrpc","websocket"], near: ["jsonrpc"],
  cosmos: ["rpc","rest","grpc"], axl: ["rpc","rest"],
  apt: ["rest"], sui: ["jsonrpc"],
  btc: ["jsonrpc"], bch: ["jsonrpc"], xrp: ["jsonrpc"],
};

export const IFACE_LABEL: Record<string, string> = {
  jsonrpc: "JSON-RPC", websocket: "WebSocket",
  rpc: "RPC", rest: "REST", grpc: "gRPC",
  /* real config interface on self-hosted (not in the design's mock set) */
  tendermintrpc: "Tendermint RPC",
};

export function parseJwtExpiry(token: string): Date | null {
  try {
    const payload = JSON.parse(atob((token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch { return null; }
}

/* ─────────────────────────────────────────────
   Probe capability matrix — design parity only.
   The self-hosted ProbeStep NEVER fabricates results from this table
   (kept so the catalog port is complete).
───────────────────────────────────────────── */
export const PROBE_CAPS: Record<string, { archive: boolean; debug: boolean; trace: boolean }> = {
  alchemy:    { archive: true,  debug: true,  trace: true  },
  infura:     { archive: true,  debug: false, trace: false },
  quicknode:  { archive: true,  debug: false, trace: true  },
  ankr:       { archive: true,  debug: false, trace: false },
  chainstack: { archive: true,  debug: true,  trace: true  },
  drpc:       { archive: true,  debug: false, trace: false },
  getblock:   { archive: false, debug: false, trace: false },
  blockpi:    { archive: true,  debug: false, trace: false },
  nodereal:   { archive: true,  debug: false, trace: false },
  tatum:      { archive: false, debug: false, trace: false },
};

/* ─────────────────────────────────────────────
   Design chain palette (data.jsx CHAINS, id/name/color only) —
   resolves parseUrlChain hits in UrlParserPreview.
───────────────────────────────────────────── */
export interface DesignChain { id: string; name: string; color: string }

export const DESIGN_CHAINS: DesignChain[] = [
  { id: "eth",    name: "Ethereum",     color: "#627EEA" },
  { id: "arb",    name: "Arbitrum One", color: "#28A0F0" },
  { id: "base",   name: "Base",         color: "#0052FF" },
  { id: "bsc",    name: "BNB Chain",    color: "#F0B90B" },
  { id: "optm",   name: "Optimism",     color: "#FF0420" },
  { id: "poly",   name: "Polygon",      color: "#8247E5" },
  { id: "avax",   name: "Avalanche",    color: "#E84142" },
  { id: "sol",    name: "Solana",       color: "#14F195" },
  { id: "strk",   name: "Starknet",     color: "#EC796B" },
  { id: "near",   name: "NEAR",         color: "#00C08B" },
  { id: "cosmos", name: "Cosmos Hub",   color: "#6F7390" },
  { id: "ftm",    name: "Fantom",       color: "#1969FF" },
  { id: "axl",    name: "Axelar",       color: "#4B2AE0" },
  { id: "zksync", name: "zkSync Era",   color: "#8C8DFC" },
  { id: "scroll", name: "Scroll",       color: "#FFEEDA" },
  { id: "linea",  name: "Linea",        color: "#61DFFF" },
  { id: "mantle", name: "Mantle",       color: "#000000" },
  { id: "celo",   name: "Celo",         color: "#FBCC5C" },
  { id: "apt",    name: "Aptos",        color: "#00C2FF" },
  { id: "sui",    name: "Sui",          color: "#4DA2FF" },
  { id: "btc",    name: "Bitcoin",      color: "#F7931A" },
  { id: "bch",    name: "Bitcoin Cash", color: "#8DC351" },
  { id: "xrp",    name: "XRP Ledger",   color: "#346AA9" },
];

export function designChainById(id: string | null | undefined): DesignChain | null {
  if (!id) return null;
  return DESIGN_CHAINS.find((c) => c.id === id) ?? null;
}

/** Bridge a live Prometheus `spec` label onto the design's chain ids (for
 *  EVM-capability + interface-catalogue lookups). */
export function specToDesignChainId(spec: string): string | null {
  const u = spec.toUpperCase();
  if (u.startsWith("ETH")) return "eth";
  if (u.startsWith("ARB")) return "arb";
  if (u.startsWith("BASE")) return "base";
  if (u.startsWith("BSC") || u.startsWith("BNB")) return "bsc";
  if (u.startsWith("OPTM") || u.startsWith("OPTIMISM")) return "optm";
  if (u.startsWith("POLYGON") || u.startsWith("MATIC")) return "poly";
  if (u.startsWith("AVAX") || u.startsWith("AVALANCHE")) return "avax";
  if (u.startsWith("SOL")) return "sol";
  if (u.startsWith("STRK") || u.startsWith("STARK")) return "strk";
  if (u.startsWith("NEAR")) return "near";
  if (u.startsWith("COSMOS")) return "cosmos";
  if (u.startsWith("FTM") || u.startsWith("FANTOM")) return "ftm";
  if (u.startsWith("AXELAR") || u.startsWith("AXL")) return "axl";
  if (u.startsWith("ZKSYNC")) return "zksync";
  if (u.startsWith("SCROLL")) return "scroll";
  if (u.startsWith("LINEA")) return "linea";
  if (u.startsWith("MANTLE")) return "mantle";
  if (u.startsWith("CELO")) return "celo";
  if (u.startsWith("APT")) return "apt";
  if (u.startsWith("SUI")) return "sui";
  if (u.startsWith("BTC") || u.startsWith("BITCOIN")) return "btc";
  if (u.startsWith("BCH")) return "bch";
  if (u.startsWith("XRP")) return "xrp";
  return null;
}

export function isEvmSpec(spec: string): boolean {
  const id = specToDesignChainId(spec);
  return id !== null && EVM_CHAINS.has(id);
}

/* ─────────────────────────────────────────────
   Upstream identity — catalog match by urlHost domain (preferred),
   falling back to the node name (the design matched by name).
───────────────────────────────────────────── */
export function matchCatalog(name: string, urlHosts: string[]): UpstreamCatalogEntry | null {
  for (const cat of UPSTREAM_CATALOG) {
    const domain = UPSTREAM_DOMAINS[cat.id];
    for (const host of urlHosts) {
      if (domain && host.includes(domain)) return cat;
      if (cat.domainPattern && cat.domainPattern.test(host)) return cat;
    }
  }
  const lower = name.toLowerCase();
  return UPSTREAM_CATALOG.find((c) => lower.includes(c.name.toLowerCase()) || lower.includes(c.id)) ?? null;
}

/* ─────────────────────────────────────────────
   Upstream view-model — one row per config node (grouped by node name
   across routers), stats joined from /api/metrics/upstreams where
   endpointId === node name. All numbers real or null; never invented.
───────────────────────────────────────────── */
export interface UpstreamChainRow {
  spec: string;
  network: string;
  role: "primary" | "backup";
  urlHost: string;
  iface: string;
  addons: string[];
  routerId: string;
}

export interface UpstreamRow {
  /** Node name — unique per values file. */
  id: string;
  name: string;
  /** First upstream urlHost (for identity/head rows). */
  url: string;
  chainRows: UpstreamChainRow[];
  /** Unique spec labels served. */
  chains: string[];
  networks: string[];
  interfaces: string[];
  catalogId: string | null;
  /** "—" = no metrics reported in the window (unknown, not "down"). */
  status: "healthy" | "degraded" | "—";
  /** Worst (max) p95 across served specs. */
  latencyMs: number | null;
  /** Most conservative (min) uptime across served specs, 0..1. */
  uptime: number | null;
  /** Sum of requests across served specs; null when no metrics at all. */
  requests: number | null;
  role: "primary" | "backup";
}

export function buildUpstreamRows(
  routers: RouterTopology[],
  metrics: UpstreamMetrics[] | undefined,
): UpstreamRow[] {
  const byName = new Map<string, UpstreamChainRow[]>();
  const order: string[] = [];
  for (const r of routers) {
    for (const n of r.nodes) {
      let rows = byName.get(n.name);
      if (!rows) { rows = []; byName.set(n.name, rows); order.push(n.name); }
      const role: "primary" | "backup" = n.isBackup ? "backup" : "primary";
      if (n.endpoints.length === 0) {
        rows.push({ spec: r.spec, network: r.network, role, urlHost: "", iface: "", addons: [], routerId: r.id });
      }
      for (const ep of n.endpoints) {
        rows.push({ spec: r.spec, network: r.network, role, urlHost: ep.urlHost, iface: ep.interface, addons: ep.addons, routerId: r.id });
      }
    }
  }

  const metricsByName = new Map<string, UpstreamMetrics[]>();
  for (const m of metrics ?? []) {
    const arr = metricsByName.get(m.endpointId);
    if (arr) arr.push(m);
    else metricsByName.set(m.endpointId, [m]);
  }

  return order.map((name) => {
    const chainRows = byName.get(name) ?? [];
    const ms = metricsByName.get(name) ?? [];
    const latVals = ms.map((m) => m.p95Ms).filter((v): v is number => v !== null);
    const upVals = ms.map((m) => m.uptime).filter((v): v is number => v !== null);
    const status: UpstreamRow["status"] = ms.some((m) => m.health === "unhealthy")
      ? "degraded"
      : ms.some((m) => m.health === "operational")
        ? "healthy"
        : "—";
    const hosts = [...new Set(chainRows.map((c) => c.urlHost).filter(Boolean))];
    const catalog = matchCatalog(name, hosts);
    return {
      id: name,
      name,
      url: hosts[0] ?? "",
      chainRows,
      chains: [...new Set(chainRows.map((c) => c.spec))],
      networks: [...new Set(chainRows.map((c) => c.network))],
      interfaces: [...new Set(chainRows.map((c) => c.iface).filter(Boolean))],
      catalogId: catalog?.id ?? null,
      status,
      latencyMs: latVals.length ? Math.max(...latVals) : null,
      uptime: upVals.length ? Math.min(...upVals) : null,
      requests: ms.length ? ms.reduce((s, m) => s + m.requests, 0) : null,
      role: chainRows[0]?.role ?? "primary",
    };
  });
}
