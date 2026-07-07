/**
 * Per-(spec × interface) catalog of RPC methods used by the "Try it" drawer.
 *
 * Two sources, in priority order:
 *
 *  1. `chain-methods.generated.json` — full lava-specs coverage, produced by
 *     `scripts/generate-try-me-catalog.mjs` from the spec proposals in
 *     `lava-specs/` (imports resolved transitively, debug/trace add-on
 *     collections mapped to tiers, archive synthesised from the collection
 *     `archive` extension + curated hints). Keyed by exact Lava spec index
 *     (`ETH1`, `COSMOSHUB`, …); a string value is an alias to an identical
 *     entry (testnets mostly alias their mainnet).
 *
 *  2. The hand-curated FAMILY_METHODS below — fallback for spec indices the
 *     generated catalog doesn't know (or interfaces a spec doesn't declare),
 *     resolved by `familyForSpec` prefix matching. This is the pre-generator
 *     catalog, kept so nothing regresses when the JSON lacks an index.
 *
 * The generated JSON is ~590 KB — well over the ~300 KB static-import budget —
 * so it is loaded with a dynamic `import()` (its own async chunk) kicked off
 * at module load. Until it resolves, `getInterfaceConfig` serves the family
 * fallback; components can re-render on arrival via
 * `subscribeCatalog`/`getCatalogVersion` (see `useSyncExternalStore` in
 * `EndpointRow`). Tests should `await catalogReady`.
 *
 * `params` is intentionally a JSON string so the drawer can render it directly
 * in a single editable textarea (preserves the user's edits even when the JSON
 * isn't currently valid). It's parsed at submit time.
 *
 * For REST commands `command.method` is the HTTP verb (GET/POST/...) and
 * `command.params` is the path appended to the local endpoint URL.
 */

import { familyForSpecIndex, isKnownSpecIndex } from "@sr/shared";

export interface AddonCommand {
  /** JSON-RPC method name, or HTTP verb for REST commands. */
  method: string;
  label: string;
  /** JSON string for JSON-RPC params, or path string for REST. */
  params: string;
  /** One-line human description (from the curated hints). */
  desc?: string;
}

export type Tier = "regular" | "archive" | "debug" | "trace";

export interface InterfaceConfig {
  regular: AddonCommand[];
  archive: AddonCommand[] | null;
  debug: AddonCommand[] | null;
  trace: AddonCommand[] | null;
}

/** Chain families the static fallback catalog covers. */
export type ChainFamily =
  | "evm"
  | "solana"
  | "near"
  | "starknet"
  | "cosmos"
  | "bitcoin";

/** Storage key for the methods catalog. WS variants share the catalog of their
 *  HTTP counterpart; `grpc-web` shares with `grpc`. The drawer accepts the
 *  wider `CatalogInterface` and we collapse to a storage key via `storageKey`. */
export type CatalogStorageKey = "jsonrpc" | "tendermintrpc" | "rest" | "grpc";

/** Interface ids the Try-it drawer recognises. Wider than `CatalogStorageKey`
 *  because WS variants and `grpc-web` are valid drawer inputs even though they
 *  read methods from the HTTP/gRPC catalogs. */
export type CatalogInterface =
  | "jsonrpc"
  | "jsonrpc-ws"
  | "tendermintrpc"
  | "tendermintrpc-ws"
  | "rest"
  | "grpc"
  | "grpc-web";

/* ── Generated catalog (full lava-specs coverage) ────────────────────────── */

/** Compact command shape emitted by the generator — see the script header. */
interface GeneratedCmd {
  /** Method name / REST path template / grpc `pkg.Service/Method`. */
  m: string;
  /** HTTP verb for REST when not GET. */
  v?: string;
  /** Curated label when different from `m`. */
  l?: string;
  /** Example params (JSON string / concrete REST path) when curated. */
  p?: string;
  /** Curated one-line description. */
  d?: string;
}

type GeneratedTiers = Partial<Record<Tier, GeneratedCmd[]>>;
type GeneratedEntry = Partial<Record<CatalogStorageKey, GeneratedTiers>>;
/** String values alias another index with an identical catalog. */
type GeneratedCatalog = Record<string, GeneratedEntry | string>;

let generatedCatalog: GeneratedCatalog | null = null;
let catalogVersion = 0;
const catalogListeners = new Set<() => void>();

/**
 * Resolves once the generated catalog chunk has loaded (or failed — the
 * family fallback then stays in effect). Kicked off at module load.
 */
export const catalogReady: Promise<void> = import(
  "./chain-methods.generated.json"
).then(
  (mod) => {
    generatedCatalog = mod.default as unknown as GeneratedCatalog;
    catalogVersion = 1;
    for (const listener of catalogListeners) listener();
  },
  () => {
    /* chunk failed to load — keep serving the family fallback */
  },
);

/** Subscribe to catalog arrival — `useSyncExternalStore`-compatible. */
export function subscribeCatalog(listener: () => void): () => void {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

/** 0 until the generated catalog is loaded, 1 after. */
export function getCatalogVersion(): number {
  return catalogVersion;
}

/** Follow alias strings (`SEP1` → `ETH1`) to the canonical entry. */
function resolveGeneratedEntry(
  spec: string,
): { index: string; entry: GeneratedEntry } | null {
  if (!generatedCatalog) return null;
  let index = spec;
  let entry = generatedCatalog[index];
  for (let hops = 0; typeof entry === "string" && hops < 4; hops++) {
    index = entry;
    entry = generatedCatalog[index];
  }
  return entry !== undefined && typeof entry === "object"
    ? { index, entry }
    : null;
}

function expandCommand(cmd: GeneratedCmd, key: CatalogStorageKey): AddonCommand {
  const method = key === "rest" ? (cmd.v ?? "GET") : cmd.m;
  const params =
    cmd.p ?? (key === "rest" ? cmd.m : key === "grpc" ? "{}" : "[]");
  const out: AddonCommand = { method, label: cmd.l ?? cmd.m, params };
  if (cmd.d) out.desc = cmd.d;
  return out;
}

function expandTier(
  cmds: GeneratedCmd[] | undefined,
  key: CatalogStorageKey,
): AddonCommand[] | null {
  if (!cmds || cmds.length === 0) return null;
  return cmds.map((c) => expandCommand(c, key));
}

/** Expanded `{m,p,d}` → `AddonCommand` configs, memoized per canonical
 *  (index, storage key) so React memos keyed on the object don't churn. */
const EXPANDED_CACHE = new Map<string, InterfaceConfig>();

function generatedInterfaceConfig(
  spec: string,
  key: CatalogStorageKey,
): InterfaceConfig | null {
  const resolved = resolveGeneratedEntry(spec);
  if (!resolved) return null;
  const tiers = resolved.entry[key];
  if (!tiers) return null;
  const cacheKey = `${resolved.index}|${key}`;
  let cfg = EXPANDED_CACHE.get(cacheKey);
  if (!cfg) {
    cfg = {
      regular: expandTier(tiers.regular, key) ?? [],
      archive: expandTier(tiers.archive, key),
      debug: expandTier(tiers.debug, key),
      trace: expandTier(tiers.trace, key),
    };
    EXPANDED_CACHE.set(cacheKey, cfg);
  }
  return cfg;
}

/* ── Static fallback catalogs (family-keyed, pre-generator) ──────────────── */

const EVM_JSONRPC: InterfaceConfig = {
  regular: [
    { method: "eth_blockNumber", label: "eth_blockNumber", params: "[]", desc: "Returns the latest block number." },
    {
      method: "eth_getBalance",
      label: "eth_getBalance",
      params: '["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"]',
      desc: "Returns the Ether balance of an address in wei.",
    },
    {
      method: "eth_getBlockByNumber",
      label: "eth_getBlockByNumber",
      params: '["latest", false]',
      desc: "Returns block info for a given block number.",
    },
    {
      method: "eth_getTransactionByHash",
      label: "eth_getTransactionByHash",
      params: '["0x..."]',
      desc: "Returns a transaction matching the given hash.",
    },
    { method: "eth_gasPrice", label: "eth_gasPrice", params: "[]", desc: "Returns the current gas price in wei." },
    {
      method: "eth_estimateGas",
      label: "eth_estimateGas",
      params: '[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","value":"0x0"}]',
      desc: "Estimates the gas needed for a transaction.",
    },
    {
      method: "eth_call",
      label: "eth_call",
      params: '[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x18160ddd"}, "latest"]',
      desc: "Executes a read-only call — great for reading contract state (e.g. ERC-20 totalSupply).",
    },
    {
      method: "eth_getLogs",
      label: "eth_getLogs",
      params: '[{"address":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","fromBlock":"latest","toBlock":"latest"}]',
      desc: "Returns logs matching a given filter object.",
    },
    {
      method: "eth_getCode",
      label: "eth_getCode",
      params: '["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "latest"]',
      desc: "Returns the bytecode at a given address.",
    },
    { method: "net_version", label: "net_version", params: "[]", desc: "Returns the current network ID as a string." },
    { method: "web3_clientVersion", label: "web3_clientVersion", params: "[]", desc: "Returns the current client version string." },
  ],
  archive: [
    {
      method: "eth_getBalance",
      label: "Get Balance (Archive)",
      params: '["0x0000000000000000000000000000000000000000", "0x2C2A2"]',
    },
    {
      method: "eth_getStorageAt",
      label: "Get Storage At",
      params: '["0x0000000000000000000000000000000000000000", "0x0", "0x2C2A2"]',
    },
    {
      method: "eth_getCode",
      label: "Get Code",
      params: '["0x0000000000000000000000000000000000000000", "0x2C2A2"]',
    },
  ],
  debug: null,
  trace: null,
};

const SOLANA_JSONRPC: InterfaceConfig = {
  regular: [
    { method: "getLatestBlockhash", label: "getLatestBlockhash", params: "[]", desc: "Returns the latest blockhash and last valid block height." },
    { method: "getSlot", label: "getSlot", params: "[]", desc: "Returns the current slot." },
    {
      method: "getBalance",
      label: "getBalance",
      params: '["11111111111111111111111111111111"]',
      desc: "Returns the lamport balance of the account at the provided pubkey.",
    },
    { method: "getBlockHeight", label: "getBlockHeight", params: "[]", desc: "Returns the current block height of the node." },
    {
      method: "getTransaction",
      label: "getTransaction",
      params: '["base58 tx signature…"]',
      desc: "Returns transaction details for a confirmed transaction.",
    },
    {
      method: "getAccountInfo",
      label: "getAccountInfo",
      params: '["11111111111111111111111111111111"]',
      desc: "Returns all information associated with the account.",
    },
    { method: "getEpochInfo", label: "getEpochInfo", params: "[]", desc: "Returns information about the current epoch." },
    { method: "getHealth", label: "getHealth", params: "[]", desc: "Returns the health of the node." },
  ],
  archive: null,
  debug: null,
  trace: null,
};

const NEAR_JSONRPC: InterfaceConfig = {
  regular: [
    { method: "status", label: "status", params: "[]", desc: "Returns the state of the node." },
    { method: "block", label: "block", params: '{"block_id":"latest"}', desc: "Returns details of a specific block." },
    { method: "gas_price", label: "gas_price", params: '{"block_id":"latest"}', desc: "Returns the gas price for a specific block." },
    { method: "network_info", label: "network_info", params: "[]", desc: "Returns network info such as active peers." },
  ],
  archive: [
    {
      method: "query",
      label: "Query (Archive)",
      params: '{"request_type":"view_account","account_id":"example.testnet","block_id":10000000}',
    },
  ],
  debug: null,
  trace: null,
};

const STARKNET_JSONRPC: InterfaceConfig = {
  regular: [
    { method: "starknet_blockNumber", label: "starknet_blockNumber", params: "[]", desc: "Get the most recent accepted block number." },
    {
      method: "starknet_getBlockWithTxs",
      label: "starknet_getBlockWithTxs",
      params: '[{"block_id":"latest"}]',
      desc: "Get block information with full transactions.",
    },
    { method: "starknet_syncing", label: "starknet_syncing", params: "[]", desc: "Returns sync status, or false if not syncing." },
    { method: "starknet_chainId", label: "starknet_chainId", params: "[]", desc: "Return the currently configured StarkNet chain id." },
  ],
  archive: [
    {
      method: "starknet_getStorageAt",
      label: "Get Storage At",
      params: '{"contract_address":"0x0123","key":"0x0","block_id":{"block_number":123456}}',
    },
  ],
  debug: null,
  trace: null,
};

const COSMOS_TENDERMINT: InterfaceConfig = {
  regular: [
    { method: "abci_info", label: "abci_info", params: "[]", desc: "Returns ABCI application data." },
    { method: "net_info", label: "net_info", params: "[]", desc: "Returns active peer network info." },
    { method: "health", label: "health", params: "[]", desc: "Returns node health — empty = healthy." },
  ],
  archive: [{ method: "block", label: "Block (Archive)", params: '{"height":"340801"}' }],
  debug: null,
  trace: null,
};

const COSMOS_REST: InterfaceConfig = {
  regular: [
    {
      method: "GET",
      label: "/blocks/latest",
      params: "/cosmos/base/tendermint/v1beta1/blocks/latest",
      desc: "Returns the latest block.",
    },
    {
      method: "GET",
      label: "/node_info",
      params: "/cosmos/base/tendermint/v1beta1/node_info",
      desc: "Returns connected node info.",
    },
    {
      method: "GET",
      label: "/validators",
      params: "/cosmos/staking/v1beta1/validators",
      desc: "Returns all validators.",
    },
    {
      method: "GET",
      label: "/supply",
      params: "/cosmos/bank/v1beta1/supply",
      desc: "Returns total coin supply.",
    },
  ],
  archive: [
    {
      method: "GET",
      label: "Block (Archive)",
      params: "/cosmos/base/tendermint/v1beta1/blocks/340801",
    },
  ],
  debug: null,
  trace: null,
};

const BITCOIN_JSONRPC: InterfaceConfig = {
  regular: [
    { method: "getblockchaininfo", label: "getblockchaininfo", params: "[]", desc: "Returns blockchain state info." },
    { method: "getblockcount", label: "getblockcount", params: "[]", desc: "Returns the current block height." },
    { method: "getbestblockhash", label: "getbestblockhash", params: "[]", desc: "Returns the hash of the chain tip." },
    { method: "getnetworkinfo", label: "getnetworkinfo", params: "[]", desc: "Returns P2P networking state." },
    { method: "getmempoolinfo", label: "getmempoolinfo", params: "[]", desc: "Returns mempool state info." },
  ],
  archive: [{ method: "getblockhash", label: "Get Block Hash", params: "[800000]" }],
  debug: null,
  trace: null,
};

export const FAMILY_METHODS: Record<
  ChainFamily,
  Partial<Record<CatalogStorageKey, InterfaceConfig>>
> = {
  evm: { jsonrpc: EVM_JSONRPC },
  solana: { jsonrpc: SOLANA_JSONRPC },
  near: { jsonrpc: NEAR_JSONRPC },
  starknet: { jsonrpc: STARKNET_JSONRPC },
  cosmos: { tendermintrpc: COSMOS_TENDERMINT, rest: COSMOS_REST },
  bitcoin: { jsonrpc: BITCOIN_JSONRPC },
};

/**
 * Map a Lava spec label (the Prometheus `spec` label: `ETH1`, `SOLANA`, …) to
 * a catalog family via its uppercase prefix. Returns null when no prefix
 * matches — callers fall back per-interface (jsonrpc → evm, rest /
 * tendermintrpc → cosmos) so unknown chains still get a sensible catalog.
 */
/** The generated chain-map assigns each index one of 19 chain-type families
 *  (from lava-specs + the v1 overlay). The try-me catalog only curates method
 *  sets for these 6; every other family collapses to its closest match so an
 *  unknown index still gets a sensible fallback drawer. (The generated
 *  per-spec catalog is tried first anyway — this only fires for indices the
 *  generator didn't emit.) */
const MAP_FAMILY_TO_CATALOG: Record<string, ChainFamily> = {
  evm: "evm",
  "evm-arbitrum": "evm",
  avalanchep: "evm",
  cosmos: "cosmos",
  solana: "solana",
  near: "near",
  starknet: "starknet",
  bitcoin: "bitcoin",
};

export function familyForSpec(spec: string): ChainFamily | null {
  return MAP_FAMILY_TO_CATALOG[familyForSpecIndex(spec)] ?? null;
}

/** Fallback family per storage key for specs no prefix rule covers. */
const FALLBACK_FAMILY: Record<CatalogStorageKey, ChainFamily> = {
  jsonrpc: "evm",
  rest: "cosmos",
  tendermintrpc: "cosmos",
  grpc: "cosmos",
};

/** Every interface the drawer accepts. The drawer renders snippets for all
 *  of them; whether Send is wired up is decided by `ifaceCanFire` below. */
const SUPPORTED_CATALOG_INTERFACES: CatalogInterface[] = [
  "jsonrpc",
  "jsonrpc-ws",
  "rest",
  "tendermintrpc",
  "tendermintrpc-ws",
  "grpc",
  "grpc-web",
];

/** True when the iface is something the Try-it drawer can handle today. */
export function isCatalogInterface(iface: string): iface is CatalogInterface {
  return (SUPPORTED_CATALOG_INTERFACES as string[]).includes(iface);
}

/** Collapse the drawer-facing iface to the storage key the catalog is keyed by. */
export function storageKey(iface: CatalogInterface): CatalogStorageKey {
  if (iface === "jsonrpc-ws") return "jsonrpc";
  if (iface === "tendermintrpc-ws") return "tendermintrpc";
  if (iface === "grpc-web") return "grpc";
  return iface;
}

/** Whether the drawer's Send button can actually dial this transport from
 *  the browser. gRPC needs HTTP/2 trailers (not exposed to fetch) and
 *  gRPC-Web needs protobuf-encoded payloads — neither is feasible without
 *  generated stubs. Both still get a drawer with copy-pasteable snippets. */
export function ifaceCanFire(iface: CatalogInterface): boolean {
  return iface !== "grpc" && iface !== "grpc-web";
}

/** Identity-stable archive-stripped variants, so React memos keyed on the
 *  config object don't churn when a chain has no archive addon. */
const STRIPPED_CACHE = new Map<InterfaceConfig, InterfaceConfig>();

function withoutArchive(cfg: InterfaceConfig): InterfaceConfig {
  if (cfg.archive === null) return cfg;
  let stripped = STRIPPED_CACHE.get(cfg);
  if (!stripped) {
    stripped = { ...cfg, archive: null };
    STRIPPED_CACHE.set(cfg, stripped);
  }
  return stripped;
}

/**
 * Look up the per-tier method catalog for a (spec, iface) pair. Exact spec
 * index in the generated catalog wins; the family heuristic covers unknown
 * indices and interfaces the spec doesn't declare. Returns null when neither
 * source has a catalog — caller (`EndpointRow`) hides the Try-it action in
 * that case. `hasArchive` reflects whether the chain's mounted config marks
 * an `archive` addon; without it the archive tier is nulled out (never
 * offer methods the deployment can't serve).
 */
export function getInterfaceConfig(
  spec: string,
  iface: string,
  hasArchive: boolean,
): InterfaceConfig | null {
  if (!isCatalogInterface(iface)) return null;
  const key = storageKey(iface);
  let cfg = generatedInterfaceConfig(spec, key);
  if (!cfg) {
    // Fallback catalog for a spec the generator didn't emit. Use the spec's
    // own family; if that family lacks a method set for THIS interface, use
    // the per-interface default family (rest/tendermintrpc/grpc → cosmos) so
    // an unknown chain a router exposes over any interface still gets a
    // drawer. `getKnownFamily` returns null for a genuinely-known spec
    // (already in the map) so we don't invent a rest catalog for an
    // EVM-only chain that merely happens to be missing from the JSON.
    const family = familyForSpec(spec);
    cfg = family ? FAMILY_METHODS[family][key] ?? null : null;
    if (!cfg && !isKnownSpecIndex(spec)) {
      cfg = FAMILY_METHODS[FALLBACK_FAMILY[key]][key] ?? null;
    }
  }
  if (!cfg) return null;
  return hasArchive ? cfg : withoutArchive(cfg);
}

export const TIER_ORDER: Tier[] = ["regular", "archive", "debug", "trace"];

/** Flatten the InterfaceConfig into `[tier, command, indexInTier]` triples in
 *  the order the drawer should render. Used to power the method dropdown. */
export function listMethods(
  cfg: InterfaceConfig,
): { tier: Tier; index: number; command: AddonCommand }[] {
  const out: { tier: Tier; index: number; command: AddonCommand }[] = [];
  for (const tier of TIER_ORDER) {
    const list = cfg[tier];
    if (!list) continue;
    list.forEach((command, index) => out.push({ tier, index, command }));
  }
  return out;
}
