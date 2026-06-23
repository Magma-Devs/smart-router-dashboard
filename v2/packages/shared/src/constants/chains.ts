/**
 * Chain metadata keyed by Lava spec index (the `spec` Prometheus label:
 * `ETH1`, `BASE`, `LAVA`, …) — NOT a human chain id. All metric series carry
 * `spec`, so the dashboard resolves display metadata via this map.
 */
export interface ChainMeta {
  /** The Lava spec index — the `spec` label value. */
  spec: string;
  name: string;
  color: string;
  icon?: string;
}

const CHAIN_LIST: ChainMeta[] = [
  { spec: "ETH1", name: "Ethereum", color: "#627EEA" },
  { spec: "BASE", name: "Base", color: "#0052FF" },
  { spec: "ARBITRUM", name: "Arbitrum", color: "#28A0F0" },
  { spec: "POLYGON1", name: "Polygon", color: "#8247E5" },
  { spec: "OPTM", name: "Optimism", color: "#FF0420" },
  { spec: "LAVA", name: "Lava", color: "#FF3900" },
  { spec: "COSMOSHUB", name: "Cosmos Hub", color: "#2E3148" },
  { spec: "SOLANA", name: "Solana", color: "#14F195" },
];

const BY_SPEC = new Map<string, ChainMeta>(CHAIN_LIST.map((c) => [c.spec, c]));

/**
 * Resolve display metadata for a `spec` label, synthesising a neutral fallback
 * for any spec not in the static list (so unknown chains still render).
 */
export function buildChainMetaByIndex(spec: string): ChainMeta {
  return BY_SPEC.get(spec) ?? { spec, name: spec, color: "#6B7280" };
}

export const KNOWN_CHAINS = CHAIN_LIST;
