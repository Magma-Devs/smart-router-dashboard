/**
 * Display names for Try-it commands.
 *
 * Two sources, in priority order:
 *
 *  1. `COMMON_METHODS` — curated per (interface, method id). Doubles as the
 *     "common methods" subset the Command dropdown opens on, so a curated
 *     entry is both a better name AND a promotion out of the long tail.
 *  2. `humanizeMethod` — derived from the method id itself, for everything
 *     else. The generated catalog carries 1174 distinct JSON-RPC method ids
 *     across 110 specs; curating them all is not on, but their ids are
 *     mechanical enough to read a name out of (`debug_getRawReceipts` →
 *     "Raw Receipts"), which is what the "Show all N methods" list needs.
 *
 * The derivation is deliberately allowed to FAIL (returns null → the dropdown
 * shows the bare id, as it always did). Printing "Getblockcount" for
 * `getblockcount` would be worse than printing the id, so a token that can't
 * be split into real words is left alone rather than title-cased blindly.
 */

import { storageKey } from "./chain-methods";
import type {
  AddonCommand,
  CatalogInterface,
  CatalogStorageKey,
} from "./chain-methods";

/** Curated common methods per interface, method → friendly label. The generated
 *  catalog lists 50+ methods with no friendly names, so the Command dropdown
 *  defaults to this short curated set (labels like lava-connect: "Block Number ·
 *  eth_blockNumber") with a "show all" escape hatch. Order here is the display
 *  order; anything not listed is hidden until the user expands.
 *
 *  Keys are matched against a command's `commandKey` — the method id, or the
 *  path for REST — so ALL FOUR tiers read from this one map: the debug/trace
 *  entries only ever match commands in the debug/trace tiers (their method ids
 *  are namespaced), which is what gives those tiers the same "Friendly Name ·
 *  method_id" dropdown and the same curated-subset + "show all" behaviour the
 *  regular tier has.
 *
 *  Keyed by STORAGE key, not by drawer interface: a `-ws` transport serves the
 *  same methods as its HTTP twin and reads the same curated names. */
export const COMMON_METHODS: Partial<
  Record<CatalogStorageKey, Record<string, string>>
> = {
  jsonrpc: {
    // EVM
    eth_blockNumber: "Block Number",
    eth_chainId: "Chain ID",
    eth_gasPrice: "Gas Price",
    eth_getBalance: "Get Balance",
    eth_getBlockByNumber: "Get Block",
    eth_getTransactionByHash: "Get Transaction",
    eth_getTransactionReceipt: "Get Receipt",
    eth_call: "Call",
    net_version: "Network Version",
    eth_syncing: "Syncing Status",
    // Solana
    getLatestBlockhash: "Latest Blockhash",
    getSlot: "Slot",
    getBlockHeight: "Block Height",
    getEpochInfo: "Epoch Info",
    getHealth: "Health",
    getVersion: "Version",
    // Bitcoin
    getblockcount: "Block Count",
    getblockchaininfo: "Blockchain Info",
    getbestblockhash: "Best Block Hash",
    // EVM debug add-on (the `debug` tier) — same treatment as the regular
    // tier: the add-on tiers were the only ones landing in the dropdown as
    // bare method ids.
    debug_traceTransaction: "Trace Transaction",
    debug_traceBlockByNumber: "Trace Block by Number",
    debug_traceBlockByHash: "Trace Block by Hash",
    debug_traceBlock: "Trace Block (RLP)",
    debug_traceCall: "Trace Call",
    debug_getRawTransaction: "Raw Transaction",
    debug_getRawReceipts: "Raw Receipts",
    debug_getRawBlock: "Raw Block",
    debug_getRawHeader: "Raw Header",
    debug_storageRangeAt: "Storage Range",
    debug_getBadBlocks: "Bad Blocks",
    // EVM trace add-on (OpenEthereum-style) + Arbitrum's arbtrace_* twin
    trace_block: "Block Traces",
    trace_transaction: "Transaction Traces",
    trace_call: "Trace Call",
    trace_callMany: "Trace Calls (batch)",
    trace_filter: "Filter Traces",
    trace_get: "Get Trace",
    trace_rawTransaction: "Trace Raw Transaction",
    trace_replayTransaction: "Replay Transaction",
    trace_replayBlockTransactions: "Replay Block",
    arbtrace_block: "Block Traces",
    arbtrace_transaction: "Transaction Traces",
    arbtrace_call: "Trace Call",
    arbtrace_callMany: "Trace Calls (batch)",
    arbtrace_filter: "Filter Traces",
    arbtrace_replayTransaction: "Replay Transaction",
    arbtrace_replayBlockTransactions: "Replay Block",
    // Starknet's trace tier
    starknet_traceTransaction: "Trace Transaction",
    starknet_traceBlockTransactions: "Trace Block",
    starknet_simulateTransactions: "Simulate Transactions",
  },
  // REST keys are PATHS — a REST command's `method` is its HTTP verb, so the
  // path is the only thing that identifies it.
  rest: {
    // Cosmos SDK
    "/cosmos/base/tendermint/v1beta1/blocks/latest": "Latest Block",
    "/cosmos/base/tendermint/v1beta1/node_info": "Node Info",
    "/cosmos/base/tendermint/v1beta1/syncing": "Syncing",
    "/cosmos/base/tendermint/v1beta1/blocks/{height}": "Block by Height",
    "/cosmos/staking/v1beta1/validators": "Validators",
    "/cosmos/bank/v1beta1/supply": "Total Supply",
    // Aptos / Movement
    "/": "Ledger Info",
    "/blocks/by_height/{height}": "Block by Height",
    "/blocks/by_height/{block_height}": "Block by Height",
    "/estimate_gas_price": "Estimate Gas Price",
    // Tron
    "/wallet/getnowblock": "Latest Block",
    "/wallet/getnodeinfo": "Node Info",
    "/wallet/getblockbynum": "Block by Number",
    "/wallet/getchainparameters": "Chain Parameters",
    "/wallet/getaccount": "Get Account",
    "/wallet/gettransactionbyid": "Get Transaction",
    // Ethereum Beacon API
    "/eth/v1/node/health": "Node Health",
    "/eth/v1/node/version": "Node Version",
    "/eth/v1/beacon/genesis": "Genesis",
    "/eth/v1/beacon/headers": "Latest Headers",
    // TON
    "/v2/getMasterchainInfo": "Masterchain Info",
    "/v3/masterchainInfo": "Masterchain Info",
    // EOS
    "/v1/chain/get_info": "Chain Info",
  },
  tendermintrpc: {
    status: "Status",
    health: "Health",
    block: "Block",
    abci_info: "ABCI Info",
    net_info: "Net Info",
  },
  // gRPC keys are `pkg.Service/Method`. A Cosmos SDK chain serves 215 of them;
  // these are the ones worth opening on.
  grpc: {
    "cosmos.base.tendermint.v1beta1.Service/GetLatestBlock": "Latest Block",
    "cosmos.base.tendermint.v1beta1.Service/GetNodeInfo": "Node Info",
    "cosmos.base.tendermint.v1beta1.Service/GetSyncing": "Syncing",
    "cosmos.base.tendermint.v1beta1.Service/GetBlockByHeight": "Block by Height",
    "cosmos.bank.v1beta1.Query/TotalSupply": "Total Supply",
    "cosmos.staking.v1beta1.Query/Validators": "Validators",
    "cosmos.auth.v1beta1.Query/Accounts": "Accounts",
    "cosmos.gov.v1.Query/Proposals": "Proposals",
    // Concordium runs its own service, not the Cosmos one.
    "concordium.v2.Queries/GetConsensusInfo": "Consensus Info",
    "concordium.v2.Queries/GetBlockInfo": "Block Info",
  },
};

/* ── Derivation ─────────────────────────────────────────────────────────── */

/** Method-id namespaces dropped before naming: they repeat the tier or the
 *  chain family the drawer already shows in its header, and the full id stays
 *  next to the name anyway. Only a leading `<ns>_` / `<ns>.` segment matches. */
const NAMESPACES = new Set([
  // EVM + its add-on tiers
  "eth", "debug", "trace", "arbtrace", "net", "web3", "txpool", "admin",
  "miner", "personal", "engine", "les", "clique", "parity", "erigon", "ots",
  "bor", "zks", "zkevm", "shh", "rpc", "db", "beacon",
  // non-EVM families whose ids carry a namespace of their own
  "starknet", "filecoin", "sui", "iota", "near", "solana", "ton", "tron",
  // substrate / polkadot
  "chain", "system", "state", "author", "childstate", "offchain", "payment",
  "grandpa", "babe", "beefy", "mmr", "dev",
  // casper
  "info",
]);

/** Words that read wrong in Title Case — rendered as-is instead. */
const ACRONYMS: Record<string, string> = {
  abci: "ABCI", api: "API", cpu: "CPU", db: "DB", dns: "DNS", eth: "ETH",
  evm: "EVM", gc: "GC", http: "HTTP", ibc: "IBC", id: "ID", ip: "IP",
  json: "JSON", jwt: "JWT", lcd: "LCD", nft: "NFT", os: "OS", p2p: "P2P",
  rlp: "RLP", rpc: "RPC", sdk: "SDK", ss58: "SS58", ssl: "SSL", tls: "TLS",
  uri: "URI", url: "URL", uuid: "UUID", vm: "VM", ws: "WS",
};

/**
 * Vocabulary for splitting run-together lowercase ids (`getblockcount`,
 * `/wallet/getnowblock`) — bitcoin-family JSON-RPC and Tron's REST surface,
 * where the id carries no camelCase or `_` to split on. Kept to words that
 * actually appear in the shipped catalog: an over-broad list starts inventing
 * splits ("cancel" + "all" is right, "can" + "cel" + "lall" is not), and a
 * word missing here only means the id renders as-is.
 */
const VOCAB = [
  "account", "address", "all", "any", "approve",
  "asset", "at", "available", "balance", "bandwidth", "best",
  "best", "block", "blockchain", "broadcast", "brokerage",
  "burn", "by", "cancel", "chain", "check", "clear", "code", "coin", "coinbase",
  "committee", "config", "confirm", "connection", "connections", "constant",
  "contract", "count", "create", "current", "data", "deploy", "deposit",
  "delegate", "delegated", "delegation", "difficulty", "energy", "epoch",
  "estimate", "event", "exchange", "exit", "fee", "filter",
  "finality", "for", "fork", "freeze", "from", "genesis", "get", "hash",
  "header", "height", "hex", "history", "id", "identity", "in",
  "index", "info", "is", "issue", "key", "latest", "ledger", "limit",
  "list", "log", "market", "memo", "mempool", "merkle", "metadata",
  "mining", "mint", "name", "net", "network", "new", "next", "node", "nodes",
  "now", "num", "number", "of", "order", "pair", "params",
  "peer", "pending", "permission", "price", "proof", "proposal",
  "raw", "receipt", "reserve", "resource",
  "reward", "root", "sign", "size", "slot", "smart",
  "stake", "state", "subscribe", "status", "storage", "sub", "supply", "swap", "sync",
  "syncing", "time", "to", "token", "total", "transaction",
  "transfer", "trigger", "tx", "uptime", "unfreeze",
  "unstake", "update", "validate", "validator", "verify",
  "version", "vote", "wallet", "withdraw", "witness",
  // stems the shipped REST paths need
  "annotation", "bonded", "checkpoint", "delegator", "denom", "descriptor",
  "grant", "healthy", "inflation", "module", "reflection", "signing",
  "spendable", "subspace", "unbonding",
];

const VOCAB_SET = new Set(VOCAB);
/** Longest first so the segmenter tries "blockchain" before "block". */
const VOCAB_BY_LENGTH = [...VOCAB].sort((a, b) => b.length - a.length);

/** Plural forms are matched off the singular so the vocabulary stays a list of
 *  stems — `balances`, `checkpoints`, `validators` need no entries of their own. */
const PLURALS = ["", "s", "es"];

/** Split a run-together lowercase token into vocabulary words, or null when
 *  no full segmentation exists. Backtracking (not greedy): "blockchain" wins
 *  at the front of `blockchaininfo`, but `blockcount` still falls back to
 *  "block" when the longer match leaves an unsplittable tail. */
function segment(token: string, memo = new Map<string, string[] | null>()): string[] | null {
  if (token === "") return [];
  const cached = memo.get(token);
  if (cached !== undefined) return cached;
  memo.set(token, null); // guard against re-entering the same suffix
  for (const word of VOCAB_BY_LENGTH) {
    for (const plural of PLURALS) {
      const candidate = word + plural;
      if (!token.startsWith(candidate)) continue;
      const rest = segment(token.slice(candidate.length), memo);
      if (rest) {
        const out = [candidate, ...rest];
        memo.set(token, out);
        return out;
      }
    }
  }
  // Trailing version suffix — `…v2`, `…v3` on Tron's wallet paths.
  const version = /^v\d+$/.exec(token);
  if (version) {
    memo.set(token, [token]);
    return [token];
  }
  memo.set(token, null);
  return null;
}

/** camelCase / PascalCase / snake_case / kebab-case → lowercase words.
 *  Acronym runs stay whole (`getBlockRLP` → get, block, rlp). Null when a
 *  run-together chunk is a compound the vocabulary can't fully split — see
 *  `humanizeMethod`. */
function splitWords(raw: string): string[] | null {
  const out: string[] = [];
  for (const chunk of raw.split(/[_\-.\s]+/)) {
    if (!chunk) continue;
    const camel = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(" ")
      .filter(Boolean);
    // The id told us where the words are — take them, casing intact so
    // titleCase can spot acronyms.
    if (camel.length > 1) {
      out.push(...camel);
      continue;
    }
    const lower = chunk.toLowerCase();
    if (lower.length <= 4 || VOCAB_SET.has(lower) || ACRONYMS[lower] || !/^[a-z][a-z0-9]*$/.test(lower)) {
      out.push(chunk);
      continue;
    }
    // A run-together chunk (bitcoin's `getblockcount`, Tron's `getnowblock`)
    // carries no boundaries, so the vocabulary has to find them.
    const parts = segment(lower);
    if (parts) {
      out.push(...parts);
      continue;
    }
    // Unsplittable. When it starts with a known word it IS a compound we
    // failed to read ("Getassetissue…") — bail rather than mangle it. When it
    // doesn't, it's simply one word the vocabulary lacks ("hashrate").
    if (VOCAB_BY_LENGTH.some((w) => lower.startsWith(w))) return null;
    out.push(chunk);
  }
  return out.length > 0 ? out : null;
}

function titleCase(word: string): string {
  const lower = word.toLowerCase();
  const acronym = ACRONYMS[lower];
  if (acronym) return acronym;
  // An all-caps run the camel splitter kept whole is an acronym of its own
  // (`eth_compileLLL` → LLL) — title-casing it to "Lll" reads as a typo.
  if (word.length > 1 && word === word.toUpperCase()) return word;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Read a display name out of a method id — `debug_getRawReceipts` → "Raw
 * Receipts", `cosmos.bank.v1beta1.Query/TotalSupply` → "Total Supply",
 * `getblockcount` → "Block Count".
 *
 * Returns null when the id yields nothing better than itself: an
 * unsplittable run-together token, or a name that only differs from the id by
 * capitalisation (`status` → "Status" adds nothing next to `status`).
 */
export function humanizeMethod(raw: string): string | null {
  if (!raw) return null;
  // gRPC ids are `pkg.Service/Method` — the method is the only readable part.
  const afterSlash = raw.slice(raw.lastIndexOf("/") + 1);
  let body = afterSlash || raw;
  // Drop a leading namespace segment (`debug_`, `Filecoin.`).
  const ns = /^([A-Za-z][A-Za-z0-9]*)[_.](.+)$/.exec(body);
  if (ns && NAMESPACES.has(ns[1]!.toLowerCase())) body = ns[2]!;
  const words = splitWords(body);
  if (!words) return null;
  const name = words.map(titleCase).join(" ");
  // Nothing gained when the name neither separates words nor drops a
  // namespace — "Status" next to `status` is noise, "Get Block Count" next to
  // `getblockcount` is not.
  const single = !name.includes(" ");
  if (single && name.toLowerCase() === raw.replace(/[_\-./]/g, "").toLowerCase()) return null;
  return name;
}

/**
 * Path segments that identify nothing: an api version (`v1`, `v1beta1`), or a
 * `{placeholder}` the caller has to fill in.
 *
 * Both tests are single-pass on purpose. The obvious spelling of the version
 * rule — `v\d+([a-z]+\d*)*` — nests one quantifier inside another, so a
 * segment like `v0aaaa…` that never matches makes the engine try every way of
 * splitting the letter run: 17 SECONDS on a 31-character segment (CodeQL
 * js/redos). A trailing `[a-z0-9]*` accepts the same real segments with no
 * ambiguity to backtrack through.
 */
function skipSegment(segment: string): boolean {
  if (segment.startsWith("{") && segment.endsWith("}")) return true;
  return /^v\d+[a-z0-9]*$/i.test(segment);
}

/** Segments too vague to name a path on their own — they qualify the segment
 *  before them (`/blocks/latest`), so that one comes along. */
const QUALIFIER_SEGMENTS = new Set([
  "latest", "all", "head", "best", "current", "root", "info",
]);

/**
 * Read a display name out of a REST path — `/wallet/getnowblock` → "Get Now
 * Block", `/eth/v1/beacon/states/{state_id}/finality_checkpoints` → "Finality
 * Checkpoints". Null when the tail segments yield no readable words.
 */
export function humanizePath(path: string): string | null {
  const segments = path.split("/").filter((s) => s && !skipSegment(s));
  const last = segments[segments.length - 1];
  if (!last) return null;
  const prev = segments[segments.length - 2];
  const tail =
    QUALIFIER_SEGMENTS.has(last.toLowerCase()) && prev ? `${prev} ${last}` : last;
  const words = splitWords(tail);
  return words ? words.map(titleCase).join(" ") : null;
}

/**
 * The path a REST command calls. `AddonCommand.method` holds its HTTP VERB,
 * so the path lives in `label` (the template, `/blocks/{height}`) unless the
 * catalog replaced the label with a curated name — then `params` carries the
 * concrete path.
 */
export function restPath(cmd: AddonCommand): string {
  return cmd.label.startsWith("/") ? cmd.label : cmd.params;
}

/** What identifies a command in the curated map: its method id, or its path
 *  for REST (whose method id is just `GET`/`POST`). */
export function commandKey(iface: CatalogInterface, cmd: AddonCommand): string {
  return storageKey(iface) === "rest" ? restPath(cmd) : cmd.method;
}

/** The line under the Command dropdown: the request this command sends —
 *  `eth_getBalance`, or `POST /wallet/getnowblock` for REST, where the verb
 *  alone said nothing about which endpoint is being called. */
export function commandSignature(iface: CatalogInterface, cmd: AddonCommand): string {
  return storageKey(iface) === "rest"
    ? `${cmd.method} ${restPath(cmd)}`
    : cmd.method;
}

/**
 * The display name for a catalog command: the catalog's own label when it
 * carries one (archive commands ship "Get Balance (Archive)"), then the
 * curated map, then a name derived from the id/path. Null when none of those
 * beats the bare id — callers then render the id alone.
 */
export function friendlyName(
  iface: CatalogInterface,
  cmd: AddonCommand,
): string | null {
  const key = commandKey(iface, cmd);
  // The catalog's own label wins over the curated map: it is set per-command
  // by the generator's hints, so it is the more specific of the two. For REST
  // the label IS the path, which names nothing the signature line doesn't.
  if (cmd.label !== cmd.method && cmd.label !== key) return cmd.label;
  const curated = COMMON_METHODS[storageKey(iface)]?.[key];
  if (curated) return curated;
  return storageKey(iface) === "rest" ? humanizePath(key) : humanizeMethod(key);
}

/** Whether this command is in the curated subset the dropdown opens on. */
export function isCommonMethod(iface: CatalogInterface, cmd: AddonCommand): boolean {
  return COMMON_METHODS[storageKey(iface)]?.[commandKey(iface, cmd)] !== undefined;
}
