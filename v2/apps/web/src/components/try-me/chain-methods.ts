/**
 * Per-(chain family × interface) catalog of example RPC methods used by the
 * "Try it" drawer. Ported from the lava-connect try-me console
 * (apps/web/src/components/gateway/try-me/chain-methods.ts), adapted for
 * self-hosted reality:
 *
 *  - There is no spec service here, so catalogs are STATIC and keyed by chain
 *    family. The family for a router is derived from its Lava spec label
 *    prefix (`ETH1`, `SOLANA`, `LAVA`, …) via `familyForSpec`.
 *  - The `regular` method lists (ids, params, descriptions) are the
 *    design-blessed lists from SR_Dashboard/magma/tryme.jsx (EVM_METHODS /
 *    SOLANA_METHODS / NEAR_METHODS / STARKNET_METHODS / COSMOS_METHODS /
 *    BITCOIN_METHODS), reshaped into `AddonCommand`s.
 *  - The `archive` lists come from the lava-connect catalog (itself vendored
 *    from smart-router data). Archive is only OFFERED for chains whose
 *    mounted config marks an `archive` addon — callers pass `hasArchive` and
 *    the tier is nulled out otherwise. `debug` / `trace` have no self-hosted
 *    gating concept and stay null everywhere (the type keeps the slots so the
 *    drawer's tier machinery matches the reference).
 *
 * `params` is intentionally a JSON string so the drawer can render it directly
 * in a single editable textarea (preserves the user's edits even when the JSON
 * isn't currently valid). It's parsed at submit time.
 *
 * For REST commands `command.method` is the HTTP verb (GET/POST/...) and
 * `command.params` is the path appended to the local endpoint URL.
 */

export interface AddonCommand {
  /** JSON-RPC method name, or HTTP verb for REST commands. */
  method: string;
  label: string;
  /** JSON string for JSON-RPC params, or path string for REST. */
  params: string;
  /** One-line human description (from the design's method catalogue). */
  desc?: string;
}

export type Tier = "regular" | "archive" | "debug" | "trace";

export interface InterfaceConfig {
  regular: AddonCommand[];
  archive: AddonCommand[] | null;
  debug: AddonCommand[] | null;
  trace: AddonCommand[] | null;
}

/** Chain families the static catalog covers. */
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

/* ── Static method catalogs (regular = tryme.jsx, archive = reference) ──── */

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
export function familyForSpec(spec: string): ChainFamily | null {
  const u = spec.toUpperCase();
  if (
    u.startsWith("ETH1") ||
    u.startsWith("BASE") ||
    u.startsWith("ARB") ||
    u.startsWith("OPT") ||
    u.startsWith("POLYGON") ||
    u.startsWith("BSC") ||
    u.startsWith("HYPERLIQUID")
  ) {
    return "evm";
  }
  if (u.startsWith("SOLANA")) return "solana";
  if (u.startsWith("NEAR")) return "near";
  if (u.startsWith("STRK")) return "starknet";
  if (
    u.startsWith("COSMOS") ||
    u.startsWith("LAVA") ||
    u.startsWith("OSMOSIS") ||
    u.startsWith("AXELAR")
  ) {
    return "cosmos";
  }
  if (u.startsWith("BTC")) return "bitcoin";
  return null;
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
 * Look up the per-tier method catalog for a (spec, iface) pair. Returns null
 * when no catalog exists — caller (`EndpointRow`) hides the Try-it action in
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
  const family = familyForSpec(spec) ?? FALLBACK_FAMILY[key];
  const cfg = FAMILY_METHODS[family][key] ?? null;
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
