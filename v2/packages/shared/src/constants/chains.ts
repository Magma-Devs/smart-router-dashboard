import chainMap from "./chain-map.generated.json";

/**
 * Chain metadata keyed by Lava spec index (the `spec` Prometheus label /
 * values-file `chain-id`: `ETH1`, `HYPERLIQUID`, `COSMOSHUB`, …) — NOT a
 * human chain id. Every metric series and every mounted endpoint carries the
 * index, so the dashboard resolves display metadata through this map.
 *
 * The map is GENERATED from the Magma-Devs/lava-specs repo — one entry per
 * index with the real name, chain-type family, a locally-vendored icon
 * (public/chains/<icon>.svg), and the served interfaces. It mirrors the v1
 * chains.ts model (whose curated icon/family overlay seeds the generator).
 * Regenerate: `node apps/web/scripts/generate-chain-map.mjs`.
 *
 * A spec not in the map (should only be a brand-new chain the mounted values
 * file references before the map is regenerated) falls back to the raw index
 * for the name and the default icon — never a crash.
 */

/** Chain-type family — selects the try-me method catalog + groups chains. */
export type ChainFamily =
  | "evm"
  | "evm-arbitrum"
  | "cosmos"
  | "solana"
  | "near"
  | "starknet"
  | "bitcoin"
  | "aptos"
  | "tron"
  | "ton"
  | "xlm"
  | "xrp"
  | "hedera"
  | "cardano"
  | "casper"
  | "tezos"
  | "iota"
  | "avalanchep"
  | "polkadotassethub";

interface ChainMapEntry {
  name: string;
  family: string;
  icon: string;
  interfaces: string[];
  mainnet: boolean;
}

export interface ChainMeta {
  /** The Lava spec index — the `spec` label value. */
  spec: string;
  /** Display name (from the spec's `name`, "Mainnet" trimmed). */
  name: string;
  /** Chain-type family. */
  family: ChainFamily;
  /** Icon basename in public/chains/ (no extension); "default" when none. */
  icon: string;
  /** Absolute public path to the icon SVG. */
  iconUrl: string;
  /** Interfaces the spec serves (jsonrpc, rest, tendermintrpc, grpc). */
  interfaces: string[];
  /** Hex color for the icon-fallback letter tint. */
  color: string;
}

const MAP = chainMap as Record<string, ChainMapEntry>;

/** Brand colors — used ONLY as the fallback-letter background when a chain's
 *  icon SVG is missing/fails to load. Icons carry their own brand color. */
const COLORS: Record<string, string> = {
  ETH1: "#627EEA",
  BASE: "#0052FF",
  ARBITRUM: "#28A0F0",
  POLYGON: "#8247E5",
  OPTM: "#FF0420",
  LAVA: "#FF3900",
  COSMOSHUB: "#2E3148",
  SOLANA: "#14F195",
  BTC: "#F7931A",
  HYPERLIQUID: "#97FCE4",
  APT1: "#06F7C7",
};

const FALLBACK_COLOR = "#6B7280";

/**
 * Resolve display metadata for a `spec` label. Everything comes from the
 * generated lava-specs map; an unknown index degrades to the raw index name
 * + default icon (the user-visible contract: "if you can't render the image
 * or name, use the index from the mounted values file + a default image").
 */
export function buildChainMetaByIndex(spec: string): ChainMeta {
  const e = MAP[spec];
  const icon = e?.icon ?? "default";
  return {
    spec,
    name: e?.name ?? spec,
    family: (e?.family as ChainFamily) ?? "evm",
    icon,
    iconUrl: `/chains/${icon}.svg`,
    interfaces: e?.interfaces ?? [],
    color: COLORS[spec] ?? FALLBACK_COLOR,
  };
}

/** Family for a spec index — the try-me catalog resolves its method set from
 *  this (falls back to "evm" for an unknown index). */
export function familyForSpecIndex(spec: string): ChainFamily {
  return (MAP[spec]?.family as ChainFamily) ?? "evm";
}

/** True when the spec index is in the generated chain map. */
export function isKnownSpecIndex(spec: string): boolean {
  return spec in MAP;
}

/** Every chain the map defines, as ChainMeta — for lists/pickers. */
export const KNOWN_CHAINS: ChainMeta[] = Object.keys(MAP).map(
  buildChainMetaByIndex,
);
