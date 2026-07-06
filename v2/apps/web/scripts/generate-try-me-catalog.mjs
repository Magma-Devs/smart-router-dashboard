#!/usr/bin/env node
/**
 * Generate the full-coverage Try-it method catalog from the Lava spec repo.
 *
 *   LAVA_SPECS_DIR=~/projects/lava-specs node scripts/generate-try-me-catalog.mjs
 *
 * Reads every `*.json` proposal file in the specs dir, resolves spec `imports`
 * transitively (COSMOSHUB → COSMOSSDK50 → COSMOSSDK → IBC/TENDERMINT) plus the
 * within-spec `inheritance_apis` collection links (STRK "" ← HTTP-ONLY/WS-ONLY,
 * AVAX /C/rpc ← ""), and emits
 * `src/components/try-me/chain-methods.generated.json`:
 *
 *   { [specIndex]:
 *       string                               // alias — identical to that index
 *     | { [iface in jsonrpc|rest|tendermintrpc|grpc]?: {
 *          regular?: Cmd[]; archive?: Cmd[]; debug?: Cmd[]; trace?: Cmd[] } } }
 *
 *   Cmd = { m: string; v?: string; l?: string; p?: string; d?: string }
 *     m  method name (JSON-RPC method / REST path template / grpc Svc/Method)
 *     v  HTTP verb for REST when not GET
 *     l  label when different from m (curated)
 *     p  example params when known (JSON string, or concrete REST path);
 *        omitted when it equals the interface default ("[]" / the path
 *        template itself / "{}")
 *     d  one-line description (curated)
 *
 * Tier derivation (verified against the spec data):
 *   - collection_data.add_on ""        → regular
 *   - collection_data.add_on "debug"   → debug
 *   - collection_data.add_on "trace"   → trace
 *   - collection_data.add_on "arbtrace"→ trace  (Arbitrum's trace add-on)
 *   - other add_ons (bundler, warp, blockdaemon, indexer, admin,
 *     compound-v3, aave-v3) have no tier in the drawer → skipped
 *   - archive is NOT a method list in the specs: it's a collection-level
 *     extension (`api_collections[].extensions[].name === "archive"`, with a
 *     cu_multiplier + block rule). A spec/interface whose collections carry
 *     the extension (own or inherited) is archive-capable; its archive tier
 *     is synthesised from the curated ARCHIVE_HINTS below, filtered to
 *     methods that actually exist in the regular tier.
 *
 * Collection selection: for each (interface, tier) prefer internal_path ""
 * (which inherits the real methods via imports/inheritance_apis everywhere we
 * checked); when "" is absent or empty, fall back to the internal_path with
 * the most methods. All collection `type` variants at the chosen path merge
 * (REST specs split GET/POST into sibling collections).
 *
 * Disabled specs (enabled:false — the abstract cosmossdk/ibc/tendermint base
 * specs) are indexed for import resolution but not emitted. Disabled
 * COLLECTIONS are kept as inheritance templates but never emitted directly:
 * AVAX disables the "" path (serving happens at /C/rpc, whose
 * inheritance_apis points back at ""), and STRK's HTTP-ONLY/WS-ONLY are
 * disabled ingredient collections that the enabled "" collection inherits.
 * Disabled apis are dropped; a child spec re-declaring an api with
 * enabled:false removes the inherited one.
 *
 * Determinism: spec indices sorted; within a tier curated hints come first in
 * hint-table order, the rest alphabetically; identical entries alias to the
 * first index that produced them (testnets mostly alias their mainnet).
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ → web → apps → v2 → smart-router-dashboard → ~/projects
const SPECS_DIR =
  process.env.LAVA_SPECS_DIR ??
  path.resolve(__dirname, "../../../../../lava-specs");
const OUT_PATH = path.resolve(
  __dirname,
  "../src/components/try-me/chain-methods.generated.json",
);

/* ── Curated hints ───────────────────────────────────────────────────────── */
/** Single source for example params / descriptions / labels. `only` scopes a
 *  hint to spec-index prefixes (used where the same method name means
 *  different things on different chains). Order = display order. */

const JSONRPC_HINTS = [
  // EVM
  { m: "eth_blockNumber", p: "[]", d: "Returns the latest block number." },
  { m: "eth_chainId", p: "[]", d: "Returns the chain ID of the current network." },
  { m: "eth_getBalance", p: '["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"]', d: "Returns the Ether balance of an address in wei." },
  { m: "eth_getBlockByNumber", p: '["latest", false]', d: "Returns block info for a given block number." },
  { m: "eth_getTransactionByHash", p: '["0x..."]', d: "Returns a transaction matching the given hash." },
  { m: "eth_getTransactionReceipt", p: '["0x..."]', d: "Returns the receipt of a transaction by hash." },
  { m: "eth_getTransactionCount", p: '["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"]', d: "Returns the number of transactions sent from an address." },
  { m: "eth_gasPrice", p: "[]", d: "Returns the current gas price in wei." },
  { m: "eth_maxPriorityFeePerGas", p: "[]", d: "Returns the current max priority fee per gas in wei." },
  { m: "eth_feeHistory", p: '["0x5", "latest", []]', d: "Returns historical gas fee data." },
  { m: "eth_estimateGas", p: '[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","value":"0x0"}]', d: "Estimates the gas needed for a transaction." },
  { m: "eth_call", p: '[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x18160ddd"}, "latest"]', d: "Executes a read-only call — great for reading contract state (e.g. ERC-20 totalSupply)." },
  { m: "eth_getLogs", p: '[{"address":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","fromBlock":"latest","toBlock":"latest"}]', d: "Returns logs matching a given filter object." },
  { m: "eth_getCode", p: '["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "latest"]', d: "Returns the bytecode at a given address." },
  { m: "eth_getStorageAt", p: '["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0x0", "latest"]', d: "Returns the value from a storage position at an address." },
  { m: "eth_syncing", p: "[]", d: "Returns sync status, or false when in sync." },
  { m: "net_version", p: "[]", d: "Returns the current network ID as a string." },
  { m: "web3_clientVersion", p: "[]", d: "Returns the current client version string." },
  // EVM debug add-on
  { m: "debug_traceTransaction", p: '["0x...", {"tracer":"callTracer"}]', d: "Traces a transaction's execution with the given tracer." },
  { m: "debug_traceBlockByNumber", p: '["latest", {"tracer":"callTracer"}]', d: "Traces every transaction in a block by number." },
  { m: "debug_traceBlockByHash", p: '["0x...", {"tracer":"callTracer"}]', d: "Traces every transaction in a block by hash." },
  { m: "debug_traceCall", p: '[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x18160ddd"}, "latest", {"tracer":"callTracer"}]', d: "Traces an eth_call without creating a transaction." },
  // EVM trace add-on (OpenEthereum-style)
  { m: "trace_block", p: '["latest"]', d: "Returns traces created at the given block." },
  { m: "trace_transaction", p: '["0x..."]', d: "Returns all traces of the given transaction." },
  { m: "trace_replayBlockTransactions", p: '["latest", ["trace"]]', d: "Replays all transactions in a block, returning the requested traces." },
  { m: "trace_filter", p: '[{"fromBlock":"latest","toBlock":"latest"}]', d: "Returns traces matching the given filter." },
  { m: "trace_call", p: '[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x18160ddd"}, ["trace"], "latest"]', d: "Executes a call and returns the requested traces." },
  // Arbitrum classic trace add-on
  { m: "arbtrace_block", p: '["latest"]', d: "Arbitrum classic: traces created at the given block." },
  { m: "arbtrace_transaction", p: '["0x..."]', d: "Arbitrum classic: all traces of the given transaction." },
  { m: "arbtrace_replayBlockTransactions", p: '["latest", ["trace"]]', d: "Arbitrum classic: replay a block's transactions with traces." },
  // Solana
  { m: "getLatestBlockhash", p: "[]", d: "Returns the latest blockhash and last valid block height." },
  { m: "getSlot", p: "[]", d: "Returns the current slot." },
  { m: "getBalance", p: '["11111111111111111111111111111111"]', d: "Returns the lamport balance of the account at the provided pubkey.", only: ["SOLANA", "KOII"] },
  { m: "getBlockHeight", p: "[]", d: "Returns the current block height of the node." },
  { m: "getBlock", p: '[430, {"maxSupportedTransactionVersion":0}]', d: "Returns identity and transaction information about a confirmed block.", only: ["SOLANA", "KOII"] },
  { m: "getTransaction", p: '["base58 tx signature…", {"maxSupportedTransactionVersion":0}]', d: "Returns transaction details for a confirmed transaction.", only: ["SOLANA", "KOII"] },
  { m: "getAccountInfo", p: '["11111111111111111111111111111111"]', d: "Returns all information associated with the account.", only: ["SOLANA", "KOII"] },
  { m: "getEpochInfo", p: "[]", d: "Returns information about the current epoch." },
  { m: "getHealth", p: "[]", d: "Returns the health of the node." },
  { m: "getVersion", p: "[]", d: "Returns the software version of the node." },
  // NEAR
  { m: "status", p: "[]", d: "Returns the state of the node.", only: ["NEAR"] },
  { m: "block", p: '{"finality":"final"}', d: "Returns details of a specific block.", only: ["NEAR"] },
  { m: "gas_price", p: "[null]", d: "Returns the gas price for a specific block.", only: ["NEAR"] },
  { m: "network_info", p: "[]", d: "Returns network info such as active peers.", only: ["NEAR"] },
  { m: "validators", p: "[null]", d: "Returns the current validator set.", only: ["NEAR"] },
  // Starknet
  { m: "starknet_blockNumber", p: "[]", d: "Get the most recent accepted block number." },
  { m: "starknet_blockHashAndNumber", p: "[]", d: "Get the most recent accepted block hash and number." },
  { m: "starknet_chainId", p: "[]", d: "Return the currently configured StarkNet chain id." },
  { m: "starknet_getBlockWithTxs", p: '[{"block_id":"latest"}]', d: "Get block information with full transactions." },
  { m: "starknet_syncing", p: "[]", d: "Returns sync status, or false if not syncing." },
  { m: "starknet_getStateUpdate", p: '[{"block_id":"latest"}]', d: "Get the state changes in a given block." },
  { m: "starknet_traceTransaction", p: '["0x..."]', d: "Returns the execution trace of a transaction." },
  // Bitcoin-family (btc / bch / doge / litecoin)
  { m: "getblockchaininfo", p: "[]", d: "Returns blockchain state info." },
  { m: "getblockcount", p: "[]", d: "Returns the current block height." },
  { m: "getbestblockhash", p: "[]", d: "Returns the hash of the chain tip." },
  { m: "getblockhash", p: "[800000]", d: "Returns the hash of the block at the given height." },
  { m: "getblockheader", p: '["<blockhash>"]', d: "Returns the header of the given block." },
  { m: "getnetworkinfo", p: "[]", d: "Returns P2P networking state." },
  { m: "getmempoolinfo", p: "[]", d: "Returns mempool state info." },
  { m: "getdifficulty", p: "[]", d: "Returns the current proof-of-work difficulty." },
  // Filecoin
  { m: "Filecoin.ChainHead", p: "[]", d: "Returns the current head of the chain." },
  { m: "Filecoin.Version", p: "[]", d: "Returns the node version." },
  // Polkadot / Substrate
  { m: "chain_getBlock", p: "[]", d: "Returns the latest block." },
  { m: "chain_getBlockHash", p: "[]", d: "Returns the hash of the latest block." },
  { m: "system_chain", p: "[]", d: "Returns the chain name." },
  { m: "system_health", p: "[]", d: "Returns node health information." },
  // Sui / IOTA
  { m: "sui_getChainIdentifier", p: "[]", d: "Returns the chain identifier." },
  { m: "sui_getLatestCheckpointSequenceNumber", p: "[]", d: "Returns the sequence number of the latest checkpoint." },
  { m: "sui_getTotalTransactionBlocks", p: "[]", d: "Returns the total number of transaction blocks." },
  { m: "iota_getChainIdentifier", p: "[]", d: "Returns the chain identifier." },
  { m: "iota_getLatestCheckpointSequenceNumber", p: "[]", d: "Returns the sequence number of the latest checkpoint." },
  // Stellar (soroban-rpc)
  { m: "getVersionInfo", p: "[]", d: "Returns version information of the RPC instance." },
  { m: "getNetwork", p: "[]", d: "Returns network configuration info." },
  { m: "getLatestLedger", p: "[]", d: "Returns the latest known ledger." },
  // Casper
  { m: "info_get_status", p: "[]", d: "Returns the current node status." },
  { m: "chain_get_state_root_hash", p: "[]", d: "Returns the latest state root hash." },
];

const REST_HINTS = [
  // Cosmos SDK
  { m: "/cosmos/base/tendermint/v1beta1/blocks/latest", d: "Returns the latest block." },
  { m: "/cosmos/base/tendermint/v1beta1/node_info", d: "Returns connected node info." },
  { m: "/cosmos/base/tendermint/v1beta1/syncing", d: "Returns the node's syncing state." },
  { m: "/cosmos/base/tendermint/v1beta1/blocks/{height}", p: "/cosmos/base/tendermint/v1beta1/blocks/340801", d: "Returns the block at the given height." },
  { m: "/cosmos/staking/v1beta1/validators", d: "Returns all validators." },
  { m: "/cosmos/bank/v1beta1/supply", d: "Returns total coin supply." },
  { m: "/cosmos/bank/v1beta1/balances/{address}", d: "Returns all balances of the given address." },
  // Aptos / Movement (fullnode API is mounted under /v1 on the endpoint)
  { m: "/", d: "Returns ledger info of the node (API root)." },
  { m: "/-/healthy", d: "Node health check." },
  { m: "/accounts/{address}", d: "Returns account authentication key and sequence number." },
  { m: "/blocks/by_height/{block_height}", d: "Returns the block at the given height." },
  { m: "/estimate_gas_price", d: "Returns the estimated gas price." },
  // Ethereum Beacon API
  { m: "/eth/v1/beacon/genesis", d: "Returns beacon chain genesis details." },
  { m: "/eth/v1/node/health", d: "Node health check." },
  { m: "/eth/v1/node/version", d: "Returns the beacon node version." },
  { m: "/eth/v1/beacon/headers", d: "Returns the latest block headers." },
  { m: "/eth/v1/beacon/states/{state_id}/root", p: "/eth/v1/beacon/states/head/root", d: "Returns the state root for the given state." },
  { m: "/eth/v1/beacon/states/{state_id}/finality_checkpoints", p: "/eth/v1/beacon/states/head/finality_checkpoints", d: "Returns finality checkpoints for the given state." },
  // Tron
  { m: "/wallet/getnowblock", v: "POST", d: "Returns the latest block." },
  { m: "/wallet/getnodeinfo", d: "Returns node runtime info." },
  // TON (toncenter-style HTTP API)
  { m: "/getMasterchainInfo", d: "Returns the masterchain state." },
  { m: "/getAddressInformation", p: "/getAddressInformation?address=EQAAFhjXzKuQ5N0c96nsdZQWATcJm909LYSaCAvWFxVJP80D", d: "Returns basic information about the address." },
  // Hedera mirror node
  { m: "/api/v1/accounts/{idOrAliasOrEvmAddress}", p: "/api/v1/accounts/0.0.1", d: "Returns info for the given account." },
  { m: "/api/v1/transactions", d: "Lists recent transactions." },
];

const TENDERMINT_HINTS = [
  { m: "status", p: "[]", d: "Returns node status: node info, sync info, validator info." },
  { m: "health", p: "[]", d: "Returns node health — empty result means healthy." },
  { m: "abci_info", p: "[]", d: "Returns ABCI application data." },
  { m: "net_info", p: "[]", d: "Returns active peer network info." },
  { m: "block", p: "[]", d: "Returns the block at the given height (latest when omitted)." },
  { m: "block_results", p: "[]", d: "Returns execution results for the block at the given height." },
  { m: "blockchain", p: "[]", d: "Returns block headers for a height range." },
  { m: "genesis", p: "[]", d: "Returns the genesis document." },
  { m: "validators", p: "[]", d: "Returns the validator set at the given height." },
  { m: "consensus_state", p: "[]", d: "Returns a snapshot of the consensus state." },
  { m: "num_unconfirmed_txs", p: "[]", d: "Returns the number of unconfirmed transactions." },
];

const GRPC_HINTS = [
  { m: "cosmos.base.tendermint.v1beta1.Service/GetLatestBlock", p: "{}", d: "Returns the latest block." },
  { m: "cosmos.base.tendermint.v1beta1.Service/GetNodeInfo", p: "{}", d: "Returns connected node info." },
  { m: "cosmos.base.tendermint.v1beta1.Service/GetSyncing", p: "{}", d: "Returns the node's syncing state." },
  { m: "cosmos.base.tendermint.v1beta1.Service/GetBlockByHeight", p: '{"height":"340801"}', d: "Returns the block at the given height." },
  { m: "cosmos.bank.v1beta1.Query/TotalSupply", p: "{}", d: "Returns total coin supply." },
  { m: "cosmos.staking.v1beta1.Query/Validators", p: "{}", d: "Returns all validators." },
];

const HINTS = {
  jsonrpc: JSONRPC_HINTS,
  rest: REST_HINTS,
  tendermintrpc: TENDERMINT_HINTS,
  grpc: GRPC_HINTS,
};

/** Archive-tier examples, synthesised for archive-capable interfaces from
 *  methods present in the regular tier (archive is a collection-level
 *  extension in the specs, never a method list — see header comment). */
const ARCHIVE_HINTS = {
  jsonrpc: [
    { m: "eth_getBalance", l: "Get Balance (Archive)", p: '["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0x2C2A2"]', d: "Balance at a historical block — requires an archive node." },
    { m: "eth_getStorageAt", l: "Get Storage At (Archive)", p: '["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0x0", "0x2C2A2"]', d: "Storage slot at a historical block — requires an archive node." },
    { m: "eth_getCode", l: "Get Code (Archive)", p: '["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0x2C2A2"]', d: "Bytecode at a historical block — requires an archive node." },
    { m: "eth_call", l: "Call (Archive)", p: '[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x18160ddd"}, "0x2C2A2"]', d: "Read-only call against a historical block — requires an archive node." },
    { m: "query", l: "Query (Archive)", p: '{"request_type":"view_account","account_id":"example.near","block_id":10000000}', d: "View account state at a historical block — requires an archive node.", only: ["NEAR"] },
    { m: "starknet_getStorageAt", l: "Get Storage At (Archive)", p: '["0x0123", "0x0", {"block_number":123456}]', d: "Storage value at a historical block — requires an archive node." },
    { m: "getblockhash", l: "Get Block Hash (Archive)", p: "[800000]", d: "Hash of a historical block." },
  ],
  rest: [
    { m: "/cosmos/base/tendermint/v1beta1/blocks/{height}", l: "Block (Archive)", p: "/cosmos/base/tendermint/v1beta1/blocks/340801", d: "Historical block — requires an archive node." },
    { m: "/blocks/by_height/{block_height}", l: "Block (Archive)", p: "/blocks/by_height/1000000", d: "Historical block — requires an archive node." },
  ],
  tendermintrpc: [
    { m: "block", l: "Block (Archive)", p: '{"height":"340801"}', d: "Historical block — requires an archive node." },
    { m: "block_results", l: "Block Results (Archive)", p: '{"height":"340801"}', d: "Historical block results — requires an archive node." },
  ],
  grpc: [
    { m: "cosmos.base.tendermint.v1beta1.Service/GetBlockByHeight", l: "Get Block By Height (Archive)", p: '{"height":"340801"}', d: "Historical block — requires an archive node." },
  ],
};

/* ── Spec loading ────────────────────────────────────────────────────────── */

const INTERFACES = ["jsonrpc", "rest", "tendermintrpc", "grpc"];
const TIER_BY_ADDON = { "": "regular", debug: "debug", trace: "trace", arbtrace: "trace" };
const TIERS = ["regular", "archive", "debug", "trace"];

const skipped = []; // { index?, file, reason }
const specsByIndex = new Map(); // index → { spec, file }

for (const file of readdirSync(SPECS_DIR).sort()) {
  if (!file.endsWith(".json")) continue;
  const full = path.join(SPECS_DIR, file);
  if (!statSync(full).isFile()) continue;
  let doc;
  try {
    doc = JSON.parse(readFileSync(full, "utf8"));
  } catch (e) {
    skipped.push({ file, reason: `unparseable JSON (${e.message})` });
    continue;
  }
  const specs = doc?.proposal?.specs;
  if (!Array.isArray(specs) || specs.length === 0) {
    skipped.push({ file, reason: "no proposal.specs[]" });
    continue;
  }
  for (const spec of specs) {
    if (!spec.index) {
      skipped.push({ file, reason: "spec without index" });
      continue;
    }
    if (specsByIndex.has(spec.index)) {
      skipped.push({ index: spec.index, file, reason: `duplicate index (kept ${specsByIndex.get(spec.index).file})` });
      continue;
    }
    specsByIndex.set(spec.index, { spec, file });
  }
}

/* ── Import + inheritance resolution ─────────────────────────────────────── */

const collKeyOf = (cd) =>
  [cd.api_interface ?? "", cd.internal_path ?? "", cd.type ?? "", cd.add_on ?? ""].join("|");

/** Deep-clone a resolved collection map so memoized parents stay pristine. */
function cloneColls(map) {
  const out = new Map();
  for (const [k, c] of map) {
    out.set(k, {
      cd: c.cd,
      disabled: c.disabled,
      extensions: new Set(c.extensions),
      apis: new Map(c.apis),
      inh: c.inh.slice(),
    });
  }
  return out;
}

const resolveMemo = new Map();

/** Merge imports transitively (cycle-safe), then overlay the spec's own
 *  collections. Returns Map<collKey, { cd, extensions, apis, inh }> where
 *  apis is Map<name, { enabled, verb }>. */
function resolveSpec(index, stack = new Set()) {
  if (resolveMemo.has(index)) return resolveMemo.get(index);
  if (stack.has(index)) return new Map(); // cycle — contribute nothing
  const entry = specsByIndex.get(index);
  if (!entry) return new Map();
  stack.add(index);

  const merged = new Map();
  for (const imp of entry.spec.imports ?? []) {
    if (!specsByIndex.has(imp)) {
      skipped.push({ index, file: entry.file, reason: `unresolvable import "${imp}"` });
      continue;
    }
    for (const [k, c] of resolveSpec(imp, stack)) {
      const existing = merged.get(k);
      if (!existing) {
        merged.set(k, { cd: c.cd, disabled: c.disabled, extensions: new Set(c.extensions), apis: new Map(c.apis), inh: c.inh.slice() });
      } else {
        existing.disabled = existing.disabled && c.disabled;
        for (const e of c.extensions) existing.extensions.add(e);
        for (const [name, api] of c.apis) existing.apis.set(name, api);
        for (const r of c.inh) if (!existing.inh.includes(r)) existing.inh.push(r);
      }
    }
  }

  for (const coll of entry.spec.api_collections ?? []) {
    const cd = coll.collection_data ?? {};
    const key = collKeyOf(cd);
    let target = merged.get(key);
    if (!target) {
      target = { cd, disabled: false, extensions: new Set(), apis: new Map(), inh: [] };
      merged.set(key, target);
    }
    // Disabled collections stay in the map as inheritance templates (see
    // header comment) — the re-declaring spec's flag wins either way.
    target.disabled = coll.enabled === false;
    for (const ext of coll.extensions ?? []) {
      if (ext?.name) target.extensions.add(ext.name);
    }
    for (const ref of coll.inheritance_apis ?? []) {
      const rk = collKeyOf(ref);
      if (!target.inh.includes(rk)) target.inh.push(rk);
    }
    for (const api of coll.apis ?? []) {
      if (!api.name) continue;
      // A child re-declaring an api with enabled:false disables the
      // inherited one — record it, filter at emit time.
      target.apis.set(api.name, { enabled: api.enabled !== false, verb: cd.type ?? "" });
    }
  }

  stack.delete(index);
  const frozen = merged;
  resolveMemo.set(index, frozen);
  return cloneColls(frozen); // callers mutate their copy
}

/** Expand within-spec `inheritance_apis` (STRK "" ← HTTP-ONLY, chains of
 *  refs allowed; the referenced collections are usually disabled templates).
 *  Referenced apis come first (own apis override); referenced extensions
 *  (e.g. archive) carry over to the inheritor. */
function expandInheritance(colls) {
  const expanded = new Map(); // key → { apis, extensions }
  const visiting = new Set();
  function expand(key) {
    if (expanded.has(key)) return expanded.get(key);
    const coll = colls.get(key);
    if (!coll) return { apis: new Map(), extensions: new Set() };
    if (visiting.has(key)) return { apis: coll.apis, extensions: coll.extensions }; // cycle
    visiting.add(key);
    let result;
    if (coll.inh.length === 0) {
      result = { apis: coll.apis, extensions: coll.extensions };
    } else {
      const apis = new Map();
      const extensions = new Set(coll.extensions);
      for (const ref of coll.inh) {
        const r = expand(ref);
        for (const [n, a] of r.apis) apis.set(n, a);
        for (const e of r.extensions) extensions.add(e);
      }
      for (const [n, a] of coll.apis) apis.set(n, a);
      result = { apis, extensions };
    }
    visiting.delete(key);
    expanded.set(key, result);
    return result;
  }
  const out = new Map();
  for (const [key, coll] of colls) {
    const { apis, extensions } = expand(key);
    out.set(key, { ...coll, apis, extensions });
  }
  return out;
}

/* ── Catalog assembly ────────────────────────────────────────────────────── */

const defaultParamsFor = (iface, method) =>
  iface === "rest" ? method : iface === "grpc" ? "{}" : "[]";

function hintApplies(hint, specIndex) {
  return !hint.only || hint.only.some((pfx) => specIndex.startsWith(pfx));
}

/** Build one tier's Cmd list: hinted first (hint order), rest alphabetical. */
function buildCmds(iface, specIndex, apiMap) {
  const names = [...apiMap.keys()].filter((n) => apiMap.get(n).enabled);
  const nameSet = new Set(names);
  const hints = HINTS[iface] ?? [];
  const cmds = [];
  const used = new Set();
  for (const hint of hints) {
    if (!nameSet.has(hint.m) || !hintApplies(hint, specIndex)) continue;
    cmds.push(makeCmd(iface, hint.m, apiMap.get(hint.m).verb, hint));
    used.add(hint.m);
  }
  for (const name of names.sort()) {
    if (used.has(name)) continue;
    cmds.push(makeCmd(iface, name, apiMap.get(name).verb, null));
  }
  return cmds;
}

function makeCmd(iface, name, verb, hint) {
  const cmd = { m: iface === "rest" && !name.startsWith("/") ? `/${name}` : name };
  const effVerb = hint?.v ?? verb;
  if (iface === "rest" && effVerb && effVerb !== "GET") cmd.v = effVerb;
  if (hint?.l && hint.l !== cmd.m) cmd.l = hint.l;
  if (hint?.p !== undefined && hint.p !== defaultParamsFor(iface, cmd.m)) cmd.p = hint.p;
  if (hint?.d) cmd.d = hint.d;
  return cmd;
}

/** Pick the internal_path for (iface, tier): prefer "" when it has methods,
 *  else the path with the most methods (ties break alphabetically). */
function pickPath(collList) {
  const byPath = new Map();
  for (const c of collList) {
    const p = c.cd.internal_path ?? "";
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(c);
  }
  const count = (colls) =>
    colls.reduce((n, c) => n + [...c.apis.values()].filter((a) => a.enabled).length, 0);
  if (byPath.has("") && count(byPath.get("")) > 0) return byPath.get("");
  let best = null;
  let bestCount = -1;
  for (const p of [...byPath.keys()].sort()) {
    const n = count(byPath.get(p));
    if (n > bestCount) {
      best = byPath.get(p);
      bestCount = n;
    }
  }
  return bestCount > 0 ? best : null;
}

function buildSpecEntry(index) {
  const colls = expandInheritance(resolveSpec(index));
  const entry = {};
  for (const iface of INTERFACES) {
    // Disabled collections were only kept as inheritance templates — they
    // are never directly servable, so they never reach the catalog.
    const ifaceColls = [...colls.values()].filter(
      (c) => c.cd.api_interface === iface && !c.disabled,
    );
    if (ifaceColls.length === 0) continue;
    const ifaceEntry = {};
    let regularNames = new Set();
    for (const tier of ["regular", "debug", "trace"]) {
      const tierColls = ifaceColls.filter(
        (c) => TIER_BY_ADDON[c.cd.add_on ?? ""] === tier,
      );
      const chosen = pickPath(tierColls);
      if (!chosen) continue;
      const apiMap = new Map();
      for (const c of chosen) {
        for (const [n, a] of c.apis) if (a.enabled) apiMap.set(n, a);
      }
      if (apiMap.size === 0) continue;
      const cmds = buildCmds(iface, index, apiMap);
      if (tier === "regular") regularNames = new Set(apiMap.keys());
      ifaceEntry[tier] = cmds;
    }
    // Archive: capability flag lives on collection extensions (own or
    // inherited, any add_on / internal_path of this interface).
    const archiveCapable = ifaceColls.some((c) => c.extensions.has("archive"));
    if (archiveCapable && regularNames.size > 0) {
      const cmds = [];
      for (const hint of ARCHIVE_HINTS[iface] ?? []) {
        const m = iface === "rest" && !hint.m.startsWith("/") ? `/${hint.m}` : hint.m;
        if (!regularNames.has(hint.m) && !regularNames.has(m)) continue;
        if (!hintApplies(hint, index)) continue;
        cmds.push(makeCmd(iface, hint.m, "GET", hint));
      }
      if (cmds.length > 0) ifaceEntry.archive = cmds;
    }
    if (Object.keys(ifaceEntry).length > 0) entry[iface] = ifaceEntry;
  }
  return entry;
}

/* ── Emit ────────────────────────────────────────────────────────────────── */

const out = {};
const aliasOf = new Map(); // canonical JSON → first index
let aliased = 0;
const tierTotals = { regular: 0, archive: 0, debug: 0, trace: 0 };
let ifaceEntries = 0;
const emptySpecs = [];

for (const index of [...specsByIndex.keys()].sort()) {
  const { spec, file } = specsByIndex.get(index);
  if (spec.enabled === false) {
    skipped.push({ index, file, reason: "spec disabled (abstract base spec)" });
    continue;
  }
  const entry = buildSpecEntry(index);
  if (Object.keys(entry).length === 0) {
    emptySpecs.push(index);
    skipped.push({ index, file, reason: "no enabled methods after resolution" });
    continue;
  }
  const sig = JSON.stringify(entry);
  const canonical = aliasOf.get(sig);
  if (canonical) {
    out[index] = canonical; // alias — identical catalog
    aliased += 1;
    continue;
  }
  aliasOf.set(sig, index);
  out[index] = entry;
  for (const iface of Object.keys(entry)) {
    ifaceEntries += 1;
    for (const tier of TIERS) tierTotals[tier] += entry[iface][tier]?.length ?? 0;
  }
}

const json = JSON.stringify(out);
writeFileSync(OUT_PATH, `${json}\n`);

/* ── Summary ─────────────────────────────────────────────────────────────── */

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`specs dir        ${SPECS_DIR}`);
console.log(`specs indexed    ${specsByIndex.size}`);
console.log(`specs emitted    ${Object.keys(out).length} (${aliased} aliased to an identical entry)`);
console.log(`iface entries    ${ifaceEntries} (canonical, aliases excluded)`);
console.log(`methods by tier  regular=${tierTotals.regular} archive=${tierTotals.archive} debug=${tierTotals.debug} trace=${tierTotals.trace}`);
console.log(`output           ${OUT_PATH} (${kb(Buffer.byteLength(json))})`);
if (skipped.length > 0) {
  console.log(`skipped          ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s.index ?? s.file}: ${s.reason}`);
}
