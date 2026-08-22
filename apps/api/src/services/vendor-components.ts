/**
 * Which status-page COMPONENT covers the chain we route through a vendor.
 *
 * The vendor's headline status is noise for this question. QuickNode publishes
 * ~500 components and goes "minor" when any of them dips; at the time of
 * writing that was BSC, Ink, Unichain and a Starknet testnet, while
 * "Ethereum · Mainnet — JSON-RPC API" was green — and the only thing this
 * deployment buys from them is that Ethereum endpoint. Reading the headline
 * would have every card and the banner shouting about somebody else's chain.
 *
 * So the verdict is per (vendor, chain-in-use), taken from the components that
 * match, and the matcher is deliberately strict — a false match is worse than
 * no match, because "no match" is a state the UI states honestly:
 *
 *  - the chain segment must EQUAL an alias of the spec, never merely contain
 *    it: Tenderly's "Boba Ethereum · Node RPC" and "Ethereum Classic" are not
 *    Ethereum;
 *  - a network segment must be mainnet-ish for a mainnet spec, which drops
 *    "Ethereum · Sepolia — JSON-RPC API" and "Ethereum · Hoodi - …";
 *  - only the RPC surfaces this deployment actually dials count. Websockets
 *    matter only when the node declares a ws url; Streams, Webhooks, Explorer,
 *    Simulator, Alerts, Debugger and friends are products we don't buy.
 *
 * Nothing matched ⇒ `unknown` with a reason. Never a guess, never a green.
 */

import { buildChainMetaByIndex, matchVendor, type RouterTopology, type VendorChainComponent, type VendorChainStatus } from "@sr/shared";

/** The kinds of endpoint this deployment can dial at a vendor. */
export type SurfaceKind = "rpc" | "ws" | "rest" | "grpc";

/** One (vendor, chain) pair the mounted values file actually routes, with the
 *  surfaces it dials — everything the matcher needs, and nothing else. */
export interface VendorChainUse {
  /** Vendor id / SPI slug. */
  slug: string;
  /** Lava spec index of the chain routed through them. */
  spec: string;
  surfaces: SurfaceKind[];
}

/* ── Reasons a chain has no verdict — user-visible, so worded as answers ── */
export const REASON_NO_FEED = "This vendor publishes no machine-readable status feed.";
export const REASON_DETAIL_UNREADABLE = "The status index could not read this vendor's components.";
export const REASON_UNMAPPED = "No component on their status page maps to this chain.";

/**
 * Extra names a vendor's status page may use for a spec, on top of the chain
 * map's own name (`buildChainMetaByIndex(spec).name`, which is what covers
 * Ethereum / Solana / Bitcoin / Aptos / Hyperliquid already). A spec with no
 * alias a page happens to use simply reports "component not mapped" — an
 * honest miss, not a wrong verdict.
 *
 * Every key must be a REAL spec index (a test pins them against the generated
 * chain map). A typo here is invisible: the entry simply never fires, and the
 * chain it was written for silently keeps reporting "not mapped" — which is
 * how `ARB1` sat here doing nothing while the index is `ARBITRUM`.
 */
export const EXTRA_CHAIN_ALIASES: Record<string, string[]> = {
  COSMOSHUB: ["Cosmos"],
  // Alchemy lists the Hyperliquid EVM chain under its product name.
  HYPERLIQUID: ["HyperEVM"],
  BSC: ["BNB Smart Chain", "BNB Smart Chain (BSC)", "BNB Chain"],
  ARBITRUM: ["Arbitrum", "Arbitrum One"],
  POLYGON: ["Polygon", "Polygon PoS"],
  AVAX: ["Avalanche", "Avalanche C Chain"],
};

/**
 * Aliases ONE vendor's page uses, checked against that page.
 *
 * Tenderly files Ethereum mainnet as plain "Mainnet" — "Mainnet · Node RPC",
 * matching their `mainnet.gateway.tenderly.co` host — and spends the word
 * "Ethereum" on "Boba Ethereum". A GLOBAL alias for a word that bare would be
 * reckless: on another page "Mainnet" could be any chain. Scoped to the vendor
 * whose naming was verified, it is simply their spelling.
 */
export const VENDOR_CHAIN_ALIASES: Record<string, Record<string, string[]>> = {
  tenderly: { ETH1: ["Mainnet"] },
};

/** `hasOwn`, not a bare index: a key called `constructor` would otherwise pull
 *  a function out of the prototype chain. */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Lower-cased names the chain segment may equal, for this spec on this
 *  vendor's page. */
export function chainAliases(spec: string, vendorSlug?: string): string[] {
  const perVendor = vendorSlug === undefined ? undefined : own(VENDOR_CHAIN_ALIASES, vendorSlug);
  const names = [
    buildChainMetaByIndex(spec).name,
    ...(own(EXTRA_CHAIN_ALIASES, spec) ?? []),
    ...(perVendor === undefined ? [] : (own(perVendor, spec) ?? [])),
  ];
  return [...new Set(names.map((n) => n.trim().toLowerCase()))];
}

/**
 * Status-page component names are `Chain · Network — Surface`, with four
 * separators in live use (`·` 1353×, `—` 385×, ` - ` 215×, `–` 2× across the
 * vendors this deployment touches). The plain hyphen counts ONLY when spaced:
 * splitting on a bare `-` would tear "JSON-RPC API" in half.
 */
export function splitComponentName(name: string): string[] {
  return name
    .split(/[·—–]|\s-\s/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/** Products that are not an RPC endpoint. A component naming one is not
 *  evidence about the endpoint we dial, whatever colour it is. */
const EXCLUDED_SURFACE =
  /stream|webhook|explorer|simulator|alert|debugger|dashboard|contract verification|faucet|blockbook|web3 action|graphql/i;

/** Surface words → the kind of endpoint they describe. `\brpc\b` deliberately
 *  does not fire inside "gRPC", which has its own entry. */
const SURFACE_PATTERNS: { kind: SurfaceKind; pattern: RegExp }[] = [
  { kind: "grpc", pattern: /\bgrpcs?\b/i },
  { kind: "ws", pattern: /websockets?|web socket|\bwss?\b/i },
  { kind: "rest", pattern: /\brest\b/i },
  { kind: "rpc", pattern: /json[-\s]?rpc|node rpc|\brpcs?\b/i },
];

const TESTNET_MARKER =
  /\b(testnet|devnet|sepolia|holesky|hoodi|goerli|ropsten|rinkeby|mumbai|amoy|fuji|chiado|preprod|preview)\b/i;

function surfacesNamedIn(segment: string): SurfaceKind[] {
  return SURFACE_PATTERNS.filter((s) => s.pattern.test(segment)).map((s) => s.kind);
}

/** SPI normalizes component states to its own words; a page that leaks
 *  Statuspage's raw vocabulary is translated here so one wording reaches the
 *  UI. Anything unrecognised stays as-is and reads as unknown there. */
export function normalizeComponentStatus(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "unknown";
  const word = raw.trim().toLowerCase();
  if (word === "major_outage") return "major";
  if (word === "partial_outage" || word === "degraded_performance") return "minor";
  if (word === "under_maintenance") return "maintenance";
  if (word === "none") return "operational";
  return word;
}

/** Worst-first. `maintenance` sits BELOW a real fault and above operational:
 *  planned work is worth showing and is not an incident. */
const STATUS_RANK: Record<string, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  degraded: 2,
  maintenance: 3,
  operational: 4,
};

function rank(status: string): number {
  // An unknown word never outranks a known fault.
  return own(STATUS_RANK, status) ?? 5;
}

/**
 * The components of one vendor's page that describe the chain+surfaces we
 * route through them. Order is preserved so the tooltip reads like the page.
 */
export function matchChainComponents(
  spec: string,
  surfaces: SurfaceKind[],
  components: VendorChainComponent[],
  vendorSlug?: string,
): VendorChainComponent[] {
  const aliases = chainAliases(spec, vendorSlug);
  const wantMainnet = buildChainMetaByIndex(spec).mainnet;
  const matched: VendorChainComponent[] = [];

  for (const component of components) {
    const segments = splitComponentName(component.name);
    const chainSegment = segments[0];
    if (chainSegment === undefined) continue;
    // EQUALS, never includes — "Boba Ethereum" is a different chain.
    if (!aliases.includes(chainSegment.toLowerCase())) continue;

    const rest = segments.slice(1);
    if (rest.some((segment) => EXCLUDED_SURFACE.test(segment))) continue;

    const named = rest.flatMap(surfacesNamedIn);
    // A component that names a surface has to name one we dial. One that names
    // none covers the chain as a whole (dRPC's "Ethereum · Ethereum Mainnet",
    // Alchemy's bare "Ethereum") and counts for every surface.
    if (named.length > 0 && !named.some((kind) => surfaces.includes(kind))) continue;

    const networkSegments = rest.filter((segment) => surfacesNamedIn(segment).length === 0);
    const testnetNamed = networkSegments.some((segment) => TESTNET_MARKER.test(segment));
    if (wantMainnet) {
      if (testnetNamed) continue;
      // A named network must be the mainnet one; no network segment at all
      // means the component covers the chain, which is fine.
      const mainnetNamed = networkSegments.some(
        (segment) => /\bmainnet\b/i.test(segment) || aliases.includes(segment.toLowerCase()),
      );
      if (networkSegments.length > 0 && !mainnetNamed) continue;
    } else if (!testnetNamed) {
      // A testnet spec needs the page to say which testnet; a bare chain
      // component would otherwise be read as covering it.
      continue;
    }

    matched.push({ name: component.name, status: normalizeComponentStatus(component.status) });
  }

  return matched;
}

/** The chain's verdict: the worst matched component, or an honest nothing. */
export function chainVerdict(
  spec: string,
  surfaces: SurfaceKind[],
  detail: { officialStatus: string; components: VendorChainComponent[] } | null,
  vendorSlug?: string,
): VendorChainStatus {
  if (detail === null) {
    return { status: "unknown", components: [], reason: REASON_DETAIL_UNREADABLE };
  }
  if (detail.officialStatus === "unavailable") {
    // SPI's word for "this vendor publishes nothing machine-readable" — the
    // components list is empty for a reason, not by accident.
    return { status: "unavailable", components: [], reason: REASON_NO_FEED };
  }
  const matched = matchChainComponents(spec, surfaces, detail.components, vendorSlug);
  if (matched.length === 0) {
    return { status: "unknown", components: [], reason: REASON_UNMAPPED };
  }
  const worst = matched.reduce((a, b) => (rank(a.status) <= rank(b.status) ? a : b));
  return { status: worst.status, components: matched, reason: null };
}

/** Which surface a configured endpoint is. A ws url is a ws surface whatever
 *  interface it is filed under — that is how the values file spells it. */
function surfaceOf(urlHost: string, iface: string): SurfaceKind | null {
  if (urlHost.startsWith("ws://") || urlHost.startsWith("wss://") || iface.endsWith("-ws")) return "ws";
  if (iface === "") return null; // placeholder row for a node with no endpoints
  if (iface.startsWith("grpc")) return "grpc";
  if (iface.startsWith("rest")) return "rest";
  return "rpc";
}

/**
 * Read the mounted topology for the (vendor, chain) pairs it routes through —
 * the api's own answer to "whose status page do we care about, and for what".
 * Derived here rather than taken from the browser: the values file is the
 * only authority, and the same `matchVendor` runs on both sides.
 */
export function collectVendorChainUse(routers: RouterTopology[]): VendorChainUse[] {
  const byKey = new Map<string, VendorChainUse>();
  for (const router of routers) {
    for (const node of router.nodes) {
      const vendor = matchVendor(node.name, node.endpoints.map((e) => e.urlHost));
      if (vendor === null) continue;
      const key = `${vendor.id} ${router.spec}`;
      let use = byKey.get(key);
      if (use === undefined) {
        use = { slug: vendor.id, spec: router.spec, surfaces: [] };
        byKey.set(key, use);
      }
      for (const endpoint of node.endpoints) {
        const kind = surfaceOf(endpoint.urlHost, endpoint.interface);
        if (kind !== null && !use.surfaces.includes(kind)) use.surfaces.push(kind);
      }
    }
  }
  return [...byKey.values()];
}
