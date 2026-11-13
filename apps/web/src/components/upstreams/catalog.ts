/* Upstream catalogue (UPSTREAM_DOMAINS/COLORS/CATALOG, from the design
 * prototype's page-providers.jsx) and the Upstreams page's view-model.
 *
 * Self-hosted reality: upstreams come from the read-only mounted values
 * file. Catalog entries drive presentation only (an upstream's logo) —
 * never data. */

import { buildChainMetaByIndex, type HealthState, type UpstreamMetrics, type RouterTopology } from "@sr/shared";
import type { DirectTarget } from "@/components/try-me/direct-request";

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
  color: string;
  domainPattern?: RegExp;
}

export const UPSTREAM_CATALOG: UpstreamCatalogEntry[] = [
  { id: "alchemy",     name: "Alchemy",     color: "#0C4EFF" },
  { id: "infura",      name: "Infura",      color: "#FF6B2B" },
  { id: "quicknode",   name: "QuickNode",   color: "#0070F3", domainPattern: /\.quiknode\.pro/ },
  { id: "ankr",        name: "Ankr",        color: "#2563EB" },
  { id: "chainstack",  name: "Chainstack",  color: "#16A34A", domainPattern: /\.p2pify\.com|chainstack/ },
  { id: "drpc",        name: "dRPC",        color: "#7C3AED" },
  { id: "getblock",    name: "GetBlock",    color: "#D97706", domainPattern: /getblock\.io/ },
  { id: "blockpi",     name: "BlockPI",     color: "#DB2777", domainPattern: /blockpi\.network/ },
  { id: "nodereal",    name: "NodeReal",    color: "#0EA5E9" },
  { id: "tatum",       name: "Tatum",       color: "#EF4444", domainPattern: /gateway\.tatum\.io/ },
  { id: "blockdaemon", name: "Blockdaemon", color: "#1A56DB", domainPattern: /blockdaemon\.com/ },
];

/** True for a `ws://` / `wss://` masked host. */
function isWsHost(urlHost: string): boolean {
  return urlHost.startsWith("ws://") || urlHost.startsWith("wss://");
}

/**
 * The direct-relay identity behind one endpoint row: this endpoint plus its
 * opposite-transport sibling on the same node, because the Try-me drawer's
 * HTTP/WS toggle has to switch upstream endpoints (they are separate
 * `node-urls` entries), not just the request envelope.
 *
 * Null when the row is the placeholder for a node with no endpoints at all,
 * or when the api marked the endpoint undialable (a `grpcs://` url).
 */
export function directTargetFor(
  upstream: UpstreamRow,
  row: UpstreamChainRow,
): DirectTarget | null {
  if (row.endpointIndex < 0 || !row.directable) return null;
  const siblings = upstream.chainRows.filter(
    (r) => r.routerId === row.routerId && r.endpointIndex >= 0 && r.directable,
  );
  const rowIsWs = isWsHost(row.urlHost);
  const opposite = siblings.find(
    (r) => r.endpointIndex !== row.endpointIndex && isWsHost(r.urlHost) !== rowIsWs,
  );
  const ws = rowIsWs ? row : opposite && isWsHost(opposite.urlHost) ? opposite : null;
  const http = rowIsWs ? (opposite ?? null) : row;
  return {
    routerId: row.routerId,
    node: upstream.name,
    httpIndex: http?.endpointIndex ?? null,
    wsIndex: ws?.endpointIndex ?? null,
    httpHost: http?.urlHost ?? null,
    wsHost: ws?.urlHost ?? null,
    // A node serving one chain over several versioned urls (TON's /v2 + /v3)
    // has one row per url; the drawer needs to know which one it is aimed at
    // before it composes a path. See `resolveDirectPath`.
    httpInternalPath: http?.internalPath ?? null,
    wsInternalPath: ws?.internalPath ?? null,
  };
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
  /** `internal-path` this node-url is pinned to, or null for the root path.
   *  `urlHost` is masked to scheme+host, so two node-urls that differ only by
   *  internal path are otherwise identical on screen. */
  internalPath: string | null;
  routerId: string;
  /** Position in the owning node's endpoint list — the handle the direct
   *  relay resolves back to a full url server-side. -1 for the placeholder
   *  row a node with no endpoints gets. */
  endpointIndex: number;
  /** Whether the api can dial this endpoint directly (http/ws, not grpc). */
  directable: boolean;
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
  /** `unknown` = no metrics reported in the window (not "down"). The shared
   *  vocabulary — see `lib/health.ts`; rendered by `<HealthTag>`. */
  health: HealthState;
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
        rows.push({ spec: r.spec, network: r.network, role, urlHost: "", iface: "", addons: [], internalPath: null, routerId: r.id, endpointIndex: -1, directable: false });
      }
      for (const ep of n.endpoints) {
        rows.push({ spec: r.spec, network: r.network, role, urlHost: ep.urlHost, iface: ep.interface, addons: ep.addons, internalPath: ep.internalPath ?? null, routerId: r.id, endpointIndex: ep.index, directable: ep.directable });
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
    /* Worst wins: one unhealthy endpoint makes the upstream unhealthy, and an
       upstream nothing reported on is `unknown`, never "down". */
    const health: HealthState = ms.some((m) => m.health === "unhealthy")
      ? "unhealthy"
      : ms.some((m) => m.health === "operational")
        ? "operational"
        : "unknown";
    const hosts = [...new Set(chainRows.map((c) => c.urlHost).filter(Boolean))];
    const catalog = matchCatalog(name, hosts);
    return {
      id: name,
      name,
      url: hosts[0] ?? "",
      chainRows,
      chains: [...new Set(chainRows.map((c) => c.spec))],
      // mainnet/testnet classification (for the net filter) derived from each
      // served chain's spec metadata — NOT c.network, which is the chain slug.
      networks: [...new Set(chainRows.map((c) => (buildChainMetaByIndex(c.spec).mainnet ? "mainnet" : "testnet")))],
      interfaces: [...new Set(chainRows.map((c) => c.iface).filter(Boolean))],
      catalogId: catalog?.id ?? null,
      health,
      latencyMs: latVals.length ? Math.max(...latVals) : null,
      uptime: upVals.length ? Math.min(...upVals) : null,
      requests: ms.length ? ms.reduce((s, m) => s + m.requests, 0) : null,
      role: chainRows[0]?.role ?? "primary",
    };
  });
}

/* ─────────────────────────────────────────────
   Chain-first view of the same rows. The roster is built per upstream (one
   card per config node); grouping it by the chain each endpoint serves
   answers the other question this page gets asked — "who serves Ethereum?"
   — off exactly the same data, so the groupings can never disagree.
───────────────────────────────────────────── */

/** One upstream endpoint carrying the upstream it belongs to: a chain card's
 *  rows can't read that off their header the way upstream rows can. */
export interface ChainUpstreamRow {
  upstream: UpstreamRow;
  row: UpstreamChainRow;
}

export interface ChainGroup {
  /** Lava spec index — `ETH1`, `COSMOSHUB`, … */
  spec: string;
  rows: ChainUpstreamRow[];
  /** Distinct upstreams serving the chain. `rows` counts ENDPOINTS — one
   *  upstream serving http + ws is two rows but one upstream. */
  upstreams: number;
}

/**
 * Group upstream endpoints by the chain they serve, in the order the chains
 * first appear in the upstream list — the order the values file declares
 * them, which is the ordering rule the upstream grouping already follows.
 */
export function groupByChain(upstreams: UpstreamRow[]): ChainGroup[] {
  const bySpec = new Map<string, ChainUpstreamRow[]>();
  const order: string[] = [];
  for (const upstream of upstreams) {
    for (const row of upstream.chainRows) {
      let rows = bySpec.get(row.spec);
      if (!rows) {
        rows = [];
        bySpec.set(row.spec, rows);
        order.push(row.spec);
      }
      rows.push({ upstream, row });
    }
  }
  return order.map((spec) => {
    const rows = bySpec.get(spec) ?? [];
    return { spec, rows, upstreams: new Set(rows.map((r) => r.upstream.id)).size };
  });
}
