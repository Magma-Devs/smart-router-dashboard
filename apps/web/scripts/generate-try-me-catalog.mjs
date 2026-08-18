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
// scripts/ → web → apps → smart-router-dashboard → ~/projects
const SPECS_DIR =
  process.env.LAVA_SPECS_DIR ??
  path.resolve(__dirname, "../../../../lava-specs");
const OUT_PATH =
  process.env.TRY_ME_OUT ??
  path.resolve(__dirname, "../src/components/try-me/chain-methods.generated.json");
/**
 * Committed roll-call of (spec × interface) pairs whose regular tier has NO
 * command that can be sent as-is. It exists to be diffed: a chain family
 * nobody has curated hints for lands as a line in this file, which the drift
 * check turns into a failure instead of a silent gap in the drawer. See
 * `.claude/rules/chain-resync.md`.
 */
const NO_RUNNABLE_PATH =
  process.env.NO_RUNNABLE_OUT ??
  path.resolve(__dirname, "data/no-runnable-defaults.generated.json");
// NOTE: chain display NAMES / families / icons are produced by the separate
// generate-chain-map.mjs (→ packages/shared/.../chain-map.generated.json).
// This script owns only the per-spec METHOD catalog.

/* ── Curated hints ───────────────────────────────────────────────────────── */
/** Single source for example params / descriptions / labels. `only` scopes a
 *  hint to spec-index prefixes (used where the same method name means
 *  different things on different chains); adding `exact: true` matches the
 *  index itself instead of a prefix, for hints carrying data that is valid on
 *  ONE network only (a genesis hash — BTC's does not hold on BTCS/BTCT4).
 *  Order = display order. */

const JSONRPC_HINTS = [
  // EVM
  { m: "eth_blockNumber", p: "[]", d: "Returns the latest block number." },
  { m: "eth_chainId", p: "[]", d: "Returns the chain ID of the current network." },
  { m: "eth_getBalance", p: '["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"]', d: "Returns the Ether balance of an address in wei." },
  { m: "eth_getBlockByNumber", p: '["latest", false]', d: "Returns block info for a given block number." },
  // ETH1 gets a WORKING stable example (the beacon deposit-contract deployment
  // tx — full nodes always serve it). The catalog is shared across the EVM
  // family, so the generic entries below ship WITHOUT params (one hash cannot
  // exist on every EVM chain — the old '["0x..."]' placeholder just produced
  // "cannot unmarshal hex string of odd length" on Send).
  { m: "eth_getTransactionByHash", p: '["0xe75fb554e433e03763a1560646ee22dcb74e5274b34c5ad644e7c0f619a7e1d0"]', d: "Returns a transaction matching the given hash.", only: ["ETH1"] },
  { m: "eth_getTransactionReceipt", p: '["0xe75fb554e433e03763a1560646ee22dcb74e5274b34c5ad644e7c0f619a7e1d0"]', d: "Returns the receipt of a transaction by hash.", only: ["ETH1"] },
  { m: "eth_getTransactionByHash", d: "Returns a transaction matching the given hash — paste a tx hash from this chain." },
  { m: "eth_getTransactionReceipt", d: "Returns the receipt of a transaction by hash — paste a tx hash from this chain." },
  { m: "eth_getTransactionCount", p: '["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"]', d: "Returns the number of transactions sent from an address." },
  { m: "eth_gasPrice", p: "[]", d: "Returns the current gas price in wei." },
  { m: "eth_maxPriorityFeePerGas", p: "[]", d: "Returns the current max priority fee per gas in wei." },
  { m: "eth_feeHistory", p: '["0x5", "latest", []]', d: "Returns historical gas fee data." },
  // Plain value transfer to an EOA — estimates cleanly on every EVM chain
  // (the previous USDC-contract target REVERTED: its fallback rejects ETH).
  { m: "eth_estimateGas", p: '[{"to":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","value":"0x0"}]', d: "Estimates the gas needed for a transaction." },
  { m: "eth_call", p: '[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x18160ddd"}, "latest"]', d: "Executes a read-only call — great for reading contract state (e.g. ERC-20 totalSupply)." },
  { m: "eth_getLogs", p: '[{"address":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","fromBlock":"latest","toBlock":"latest"}]', d: "Returns logs matching a given filter object." },
  { m: "eth_getCode", p: '["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "latest"]', d: "Returns the bytecode at a given address." },
  { m: "eth_getStorageAt", p: '["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0x0", "latest"]', d: "Returns the value from a storage position at an address." },
  { m: "eth_syncing", p: "[]", d: "Returns sync status, or false when in sync." },
  { m: "net_version", p: "[]", d: "Returns the current network ID as a string." },
  { m: "web3_clientVersion", p: "[]", d: "Returns the current client version string." },
  // WS-only (the drawer hides them on plain HTTP interfaces).
  { m: "eth_subscribe", p: '["newHeads"]', d: "Subscribe to new block headers over WebSocket." },
  { m: "eth_unsubscribe", p: '["<subscription id>"]', d: "Cancel a WebSocket subscription by id." },
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
  // No static params: public Solana nodes prune aggressively, so any baked-in
  // slot/signature dies within days (slot 430 → "Block cleaned up"). The
  // description guides the caller instead of a fake placeholder.
  { m: "getBlock", d: "Returns identity and transaction information about a confirmed block — pass a recent slot (get one with getSlot), e.g. [SLOT, {\"maxSupportedTransactionVersion\":0}].", only: ["SOLANA", "KOII"] },
  { m: "getTransaction", d: "Returns transaction details for a confirmed transaction — paste a recent tx signature, e.g. [\"SIGNATURE\", {\"maxSupportedTransactionVersion\":0}].", only: ["SOLANA", "KOII"] },
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
  // BTC gets the genesis-block hash — stable forever on every full node. The
  // other bitcoin-family chains (BCH/DOGE/LTC) have different genesis hashes,
  // so their entry ships without params (the old '<blockhash>' literal just
  // errored on Send). `exact` matters here: BTC's test networks (BTCT, BTCS,
  // BTCT4) all start with "BTC" and none of them shares its genesis hash.
  { m: "getblockheader", p: '["000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"]', d: "Returns the header of the given block.", only: ["BTC"], exact: true },
  { m: "getblockheader", d: "Returns the header of the given block — pass a block hash (get one with getbestblockhash)." },
  { m: "getnetworkinfo", p: "[]", d: "Returns P2P networking state." },
  { m: "getmempoolinfo", p: "[]", d: "Returns mempool state info." },
  { m: "getdifficulty", p: "[]", d: "Returns the current proof-of-work difficulty." },
  // Filecoin
  { m: "Filecoin.ChainHead", p: "[]", d: "Returns the current head of the chain." },
  { m: "Filecoin.Version", p: "[]", d: "Returns the node version." },
  // Polkadot / Substrate (relay chains, asset hubs, and the parachains whose
  // base surface is substrate — Hydration, Bittensor, Enjin, Polymesh)
  { m: "chain_getBlock", p: "[]", d: "Returns the latest block." },
  { m: "chain_getBlockHash", p: "[]", d: "Returns the hash of the latest block." },
  { m: "chain_getFinalizedHead", p: "[]", d: "Returns the hash of the last finalized block." },
  { m: "system_chain", p: "[]", d: "Returns the chain name." },
  { m: "system_health", p: "[]", d: "Returns node health information." },
  { m: "system_version", p: "[]", d: "Returns the node's client version." },
  { m: "system_properties", p: "[]", d: "Returns chain properties: token symbol, decimals, ss58 prefix." },
  { m: "state_getRuntimeVersion", p: "[]", d: "Returns the runtime version (spec name + spec version)." },
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
  // XRP Ledger — rippled's JSON-RPC takes ONE object inside the params array,
  // so `[{}]` is the empty request, not `[]`. Verified against s1.ripple.com.
  { m: "server_info", p: "[{}]", d: "Returns the server's state and the ledger range it holds.", only: ["XRP"] },
  { m: "server_state", p: "[{}]", d: "Returns machine-readable server state.", only: ["XRP"] },
  { m: "fee", p: "[{}]", d: "Returns the current transaction cost, in drops.", only: ["XRP"] },
  { m: "ledger_current", p: "[{}]", d: "Returns the index of the ledger currently being built.", only: ["XRP"] },
  { m: "ledger_closed", p: "[{}]", d: "Returns the hash and index of the most recently closed ledger.", only: ["XRP"] },
  { m: "ping", p: "[{}]", d: "Round-trip check — returns an empty success.", only: ["XRP"] },
  { m: "random", p: "[{}]", d: "Returns a random number from the server, for client-side seeding.", only: ["XRP"] },
  // Monero — object params, not an array. Verified against a public node;
  // `sync_info` is left out because restricted RPCs refuse it.
  { m: "get_info", p: "{}", d: "Returns node and chain state: height, difficulty, connections.", only: ["MONERO"] },
  { m: "get_block_count", p: "{}", d: "Returns the current block height.", only: ["MONERO"] },
  { m: "get_last_block_header", p: "{}", d: "Returns the header of the chain tip.", only: ["MONERO"] },
  { m: "get_fee_estimate", p: "{}", d: "Returns the estimated per-byte fee.", only: ["MONERO"] },
  { m: "get_version", p: "{}", d: "Returns the node's RPC version and hard-fork table.", only: ["MONERO"] },
  { m: "hard_fork_info", p: "{}", d: "Returns the state of the current hard fork.", only: ["MONERO"] },
  // Avalanche P-chain — object params. Only the two verified against
  // api.avax.network before it rate-limited; the rest of platform.* stays
  // uncurated rather than guessed at.
  { m: "platform.getHeight", p: "{}", d: "Returns the height of the last accepted P-chain block.", only: ["AVALANCHEP"] },
  { m: "platform.getBlockchains", p: "{}", d: "Returns every blockchain the network validates.", only: ["AVALANCHEP"] },
  // Celestia node API — the spec marks these DEFAULT (no block argument),
  // unlike header.GetByHeight and friends. NOT live-fired: the node API is
  // auth-gated, so there is no public endpoint to check against.
  { m: "header.NetworkHead", p: "[]", d: "Returns the network head the node has synced to.", only: ["CELESTIA"] },
  { m: "header.LocalHead", p: "[]", d: "Returns this node's local chain head.", only: ["CELESTIA"] },
  { m: "header.SyncState", p: "[]", d: "Returns the header sync state.", only: ["CELESTIA"] },
  { m: "node.Ready", p: "[]", d: "Reports whether the node is ready to serve requests.", only: ["CELESTIA"] },
  { m: "das.SamplingStats", p: "[]", d: "Returns data-availability sampling statistics.", only: ["CELESTIA"] },
];

const REST_HINTS = [
  // Cosmos SDK
  { m: "/cosmos/base/tendermint/v1beta1/blocks/latest", d: "Returns the latest block." },
  { m: "/cosmos/base/tendermint/v1beta1/node_info", d: "Returns connected node info." },
  { m: "/cosmos/base/tendermint/v1beta1/syncing", d: "Returns the node's syncing state." },
  // No static height: the public Cosmos REST nodes in the demo config are
  // PRUNED (skip-verifications: pruning), so a baked-in old height 500s.
  { m: "/cosmos/base/tendermint/v1beta1/blocks/{height}", d: "Returns the block at the given height — replace {height} with a recent height (see /blocks/latest). Old heights need an archive node." },
  { m: "/cosmos/staking/v1beta1/validators", d: "Returns all validators." },
  { m: "/cosmos/bank/v1beta1/supply", d: "Returns total coin supply." },
  { m: "/cosmos/bank/v1beta1/balances/{address}", d: "Returns all balances of the given address." },
  // Aptos / Movement (fullnode API is mounted under /v1 on the endpoint).
  // Scoped: `/` is also served by Arweave and Stellar, and
  // `/accounts/{address}` by VeChain, where these descriptions are wrong.
  { m: "/", d: "Returns ledger info of the node (API root).", only: ["APT", "MOVEMENT"] },
  { m: "/-/healthy", d: "Node health check.", only: ["APT", "MOVEMENT"] },
  { m: "/accounts/{address}", d: "Returns account authentication key and sequence number.", only: ["APT", "MOVEMENT"] },
  { m: "/blocks/by_height/{block_height}", d: "Returns the block at the given height.", only: ["APT", "MOVEMENT"] },
  { m: "/estimate_gas_price", d: "Returns the estimated gas price.", only: ["APT", "MOVEMENT"] },
  // EOS (nodeos chain API — every path is POST; only get_info needs no body).
  // `needs` marks the ones whose path is concrete but whose BODY isn't: the
  // path alone can't carry a block number or an account name.
  { m: "/v1/chain/get_info", v: "POST", d: "Returns chain state: chain id, head block, server version." },
  { m: "/v1/chain/get_block_info", v: "POST", needs: true, d: "Returns block info — POST body {\"block_num\": <height>}." },
  { m: "/v1/chain/get_account", v: "POST", needs: true, d: "Returns an account's resources and permissions — POST body {\"account_name\":\"<name>\"}." },
  { m: "/v1/chain/get_table_rows", v: "POST", needs: true, d: "Reads rows from a contract table — POST body {\"code\":…,\"scope\":…,\"table\":…,\"json\":true}." },
  { m: "/v1/chain/get_producers", v: "POST", needs: true, d: "Returns the producer schedule — POST body {\"json\":true,\"limit\":10}." },
  { m: "/v1/trace_api/get_block", v: "POST", needs: true, d: "Returns a block's action traces — POST body {\"block_num\": <height>}." },
  // VeChain Thor
  { m: "/blocks/{revision}", p: "/blocks/best", d: "Returns a block by number, id, or \"best\" for the chain head." },
  { m: "/accounts/{address}", p: "/accounts/0x0000000000000000000000000000456E65726779", d: "Returns an address's VET balance, VTHO energy and code flag.", only: ["VECHAIN"] },
  { m: "/node/network/peers", d: "Returns the node's connected peers." },
  { m: "/fees/priority", d: "Returns the suggested priority fee." },
  { m: "/fees/history", d: "Returns recent fee history." },
  // TON HTTP API — toncenter v2 (/v2/get*) plus tonindex v3 (/v3/*). Ice Open
  // Network is a TON fork and serves the same paths, so the address examples
  // are scoped to TON (a TON address does not exist on ION) and every chain
  // gets the paramless variant below.
  { m: "/v2/getMasterchainInfo", d: "Returns the masterchain state — the latest known block." },
  { m: "/v3/masterchainInfo", d: "Returns the masterchain state — the latest known block." },
  { m: "/v2/getAddressInformation", p: "/v2/getAddressInformation?address=EQAAFhjXzKuQ5N0c96nsdZQWATcJm909LYSaCAvWFxVJP80D", d: "Returns balance, state and code for an address.", only: ["TON"] },
  { m: "/v2/getAddressInformation", d: "Returns balance, state and code for an address — append ?address=<address>." },
  { m: "/v3/addressInformation", p: "/v3/addressInformation?address=EQAAFhjXzKuQ5N0c96nsdZQWATcJm909LYSaCAvWFxVJP80D", d: "Returns balance, state and code for an address.", only: ["TON"] },
  { m: "/v3/addressInformation", d: "Returns balance, state and code for an address — append ?address=<address>." },
  { m: "/v3/blocks", d: "Lists recent blocks, newest first." },
  { m: "/v3/transactions", d: "Lists recent transactions, newest first." },
  // Concordium (node REST proxy — {…} segments are placeholders to replace)
  { m: "/v0/consensusInfo", d: "Returns consensus state: best block, epoch and finalization info." },
  { m: "/v0/chainParameters", d: "Returns the current chain parameters." },
  { m: "/v0/genesisHash", d: "Returns the genesis block hash." },
  { m: "/v0/blocksAtHeight/{blockHeight}", p: "/v0/blocksAtHeight/1", d: "Returns the block hashes at the given absolute height." },
  { m: "/v0/blockInfo/{blockHash}", d: "Returns info for a block — replace {blockHash} with a hash from /v0/consensusInfo." },
  { m: "/v0/accBalance/{account address}", d: "Returns an account's balance — replace the segment with a Concordium address." },
  { m: "/v0/transactionCost", d: "Returns the current transaction cost estimate." },
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
  // Hedera mirror node
  { m: "/api/v1/accounts/{idOrAliasOrEvmAddress}", p: "/api/v1/accounts/0.0.1", d: "Returns info for the given account." },
  { m: "/api/v1/transactions", d: "Lists recent transactions." },
];

/**
 * CometBFT's JSON-RPC wants an empty OBJECT for "no arguments", never an
 * empty array: any method with optional parameters answers `params: {}` and
 * rejects `params: []` with "error converting json params to arguments:
 * expected 1 parameters ([height]), got 0". Verified against a live
 * cosmoshub-4 RPC through the router — hence `{}` throughout, and
 * `defaultParamsFor` matching it for the uncurated tail.
 */
const TENDERMINT_HINTS = [
  // WS-only (the drawer hides them on plain HTTP interfaces).
  { m: "subscribe", p: '{"query":"tm.event=\'NewBlock\'"}', d: "Subscribe to events over WebSocket (e.g. new blocks)." },
  { m: "unsubscribe", p: '{"query":"tm.event=\'NewBlock\'"}', d: "Unsubscribe from a WebSocket event query." },
  { m: "status", p: "{}", d: "Returns node status: node info, sync info, validator info." },
  { m: "health", p: "{}", d: "Returns node health — empty result means healthy." },
  { m: "abci_info", p: "{}", d: "Returns ABCI application data." },
  { m: "net_info", p: "{}", d: "Returns active peer network info." },
  { m: "block", p: "{}", d: "Returns the block at the given height — the latest when no height is given." },
  { m: "block_results", p: "{}", d: "Returns execution results for a block — the latest when no height is given." },
  { m: "blockchain", p: "{}", d: "Returns block headers for a height range — the last 20 by default." },
  { m: "header", p: "{}", d: "Returns a block header — the latest when no height is given." },
  { m: "commit", p: "{}", d: "Returns the commit for a block — the latest when no height is given." },
  { m: "consensus_params", p: "{}", d: "Returns the consensus parameters at a height — the latest by default." },
  { m: "validators", p: "{}", d: "Returns the validator set at a height — the latest by default." },
  { m: "consensus_state", p: "{}", d: "Returns a snapshot of the consensus state." },
  { m: "num_unconfirmed_txs", p: "{}", d: "Returns the number of unconfirmed transactions." },
  // `genesis` is deliberately uncurated: on any chain with a sizable genesis
  // document the node refuses it outright ("genesis response is large, please
  // use the genesis_chunked API instead"), so it can't be offered as runnable.
];

const GRPC_HINTS = [
  // Concordium — its own `concordium.v2.Queries` service, not cosmos.
  { m: "concordium.v2.Queries/GetConsensusInfo", p: "{}", d: "Returns consensus state: best block, epoch and finalization info." },
  { m: "concordium.v2.Queries/GetTokenomicsInfo", d: "Returns the reward/tokenomics state — pass {} for the last final block." },
  { m: "concordium.v2.Queries/GetCryptographicParameters", d: "Returns the chain's cryptographic parameters — pass {} for the last final block." },
  { m: "concordium.v2.Queries/GetBlockInfo", d: "Returns info for a block — pass {} for the last final block, or {\"given\":{\"hash\":\"<block hash>\"}}." },
  { m: "concordium.v2.Queries/GetBlocks", p: "{}", d: "Streams block summaries as they are baked." },
  { m: "cosmos.base.tendermint.v1beta1.Service/GetLatestBlock", p: "{}", d: "Returns the latest block." },
  { m: "cosmos.base.tendermint.v1beta1.Service/GetNodeInfo", p: "{}", d: "Returns connected node info." },
  { m: "cosmos.base.tendermint.v1beta1.Service/GetSyncing", p: "{}", d: "Returns the node's syncing state." },
  // No static height — the demo config's public nodes are pruned.
  { m: "cosmos.base.tendermint.v1beta1.Service/GetBlockByHeight", d: "Returns the block at the given height — pass a recent height, e.g. {\"height\":\"<recent>\"}." },
  { m: "cosmos.bank.v1beta1.Query/TotalSupply", p: "{}", d: "Returns total coin supply." },
  { m: "cosmos.staking.v1beta1.Query/Validators", p: "{}", d: "Returns all validators." },
  // Sui's gRPC v2 API. Each verified with `grpcurl -d '{}'` against
  // fullnode.mainnet.sui.io:443 — an empty request means "latest" here.
  // StateService/ListBalances is deliberately absent: it answers
  // "InvalidArgument: missing owner".
  { m: "sui.rpc.v2.LedgerService/GetServiceInfo", p: "{}", d: "Returns chain id, epoch and checkpoint height.", only: ["SUI"] },
  { m: "sui.rpc.v2.LedgerService/GetEpoch", p: "{}", d: "Returns the current epoch — first checkpoint, reference gas price.", only: ["SUI"] },
  { m: "sui.rpc.v2.LedgerService/GetCheckpoint", p: "{}", d: "Returns the latest checkpoint when no sequence number is given.", only: ["SUI"] },
  { m: "sui.rpc.v2.LedgerService/ListCheckpoints", p: "{}", d: "Lists checkpoints from the oldest available watermark.", only: ["SUI"] },
  { m: "sui.rpc.v2.LedgerService/ListEvents", p: "{}", d: "Lists recent events.", only: ["SUI"] },
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
      target.apis.set(api.name, {
        enabled: api.enabled !== false,
        verb: cd.type ?? "",
        // block_parsing is the only machine-readable arity signal the specs
        // carry: a PARSE_BY_ARG / PARSE_CANONICAL rule names the ARGUMENT the
        // block sits in, so the method demonstrably takes positional args.
        // DEFAULT / EMPTY say nothing either way.
        block: api.block_parsing ?? null,
      });
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
  iface === "rest"
    ? method
    // CometBFT reads an empty ARRAY as "zero arguments supplied" and errors on
    // any method with optional ones; an empty object is the no-arguments call.
    : iface === "grpc" || iface === "tendermintrpc"
      ? "{}"
      : "[]";

function hintApplies(hint, specIndex) {
  if (!hint.only) return true;
  return hint.only.some((sel) =>
    hint.exact ? specIndex === sel : specIndex.startsWith(sel),
  );
}

/** Build one tier's Cmd list: hinted first (hint order), rest alphabetical. */
function buildCmds(iface, specIndex, apiMap) {
  const names = [...apiMap.keys()].filter((n) => apiMap.get(n).enabled);
  const nameSet = new Set(names);
  const hints = HINTS[iface] ?? [];
  const cmds = [];
  const used = new Set();
  for (const hint of hints) {
    // First applicable hint per method wins — scoped hints (`only`) precede
    // their generic fallback in HINTS, so a spec never gets both.
    if (used.has(hint.m) || !nameSet.has(hint.m) || !hintApplies(hint, specIndex)) continue;
    cmds.push(makeCmd(iface, hint.m, apiMap.get(hint.m).verb, hint, apiMap.get(hint.m)));
    used.add(hint.m);
  }
  for (const name of names.sort()) {
    if (used.has(name)) continue;
    cmds.push(makeCmd(iface, name, apiMap.get(name).verb, null, apiMap.get(name)));
  }
  return cmds;
}

/**
 * Params that still need the caller to fill something in: an ellipsis
 * stand-in (`["0x..."]`), an angle-bracket slot (`<subscription id>`), or a
 * REST path template (`/blocks/{height}`). A JSON object is NOT a
 * placeholder — `{"tracer":"callTracer"}` is a complete value — hence the
 * quote-free character class.
 */
const PLACEHOLDER = /\.\.\.|<[^>]{2,}>|\{[a-z_ ]+\}/i;

/** Does the spec's block_parsing prove the method takes positional args? */
function specTakesArgs(block) {
  const func = block?.parser_func ?? "";
  if (func !== "PARSE_BY_ARG" && func !== "PARSE_CANONICAL") return false;
  return /^\d+$/.test(String(block?.parser_arg?.[0] ?? ""));
}

/**
 * Can this command be sent AS IS, or does the caller have to type something
 * first? Three states, and the third admits to not knowing:
 *
 *   r=1  ready    — what ships with it is already a complete request.
 *   n=1  needs    — it demonstrably takes input we cannot supply: a
 *                   placeholder, a hint that documents the argument instead
 *                   of curating one, or the spec's own arity rule.
 *   —    unknown  — no hint, no arity rule. Rendered unmarked; claiming
 *                   either way would go past what the data says.
 *
 * This cannot be recovered from the emitted JSON later: a hint of `p: "[]"`
 * is dropped for equalling the default, which leaves a no-argument method
 * indistinguishable from an uncurated one. So it is decided here, while the
 * hint is still in hand.
 */
function runnability(iface, cmd, hint, api) {
  const params = cmd.p ?? defaultParamsFor(iface, cmd.m);
  if (hint?.needs || PLACEHOLDER.test(params)) return { n: 1 };
  if (iface === "rest") {
    // A write endpoint never runs out of the box — it wants a signed payload,
    // and several specs declare one as GET (Aptos's encode_submission answers
    // 405 to the GET its own collection type implies).
    if (/(submit|broadcast|simulate|encode|sign|estimate_gas_unit)/i.test(cmd.m)) return {};
    // A GET path with nothing to substitute is already a whole request. A
    // POST may still want a body, so only a curated one counts as ready.
    const verb = cmd.v ?? "GET";
    return verb === "GET" || hint ? { r: 1 } : {};
  }
  // Elsewhere the params ARE the request, so only a curated example proves it.
  if (hint?.p !== undefined) return { r: 1 };
  // A hint that describes the argument instead of curating one is this
  // table's way of saying no static value can work here.
  if (hint) return { n: 1 };
  return specTakesArgs(api?.block) ? { n: 1 } : {};
}

function makeCmd(iface, name, verb, hint, api) {
  const cmd = { m: iface === "rest" && !name.startsWith("/") ? `/${name}` : name };
  const effVerb = hint?.v ?? verb;
  if (iface === "rest" && effVerb && effVerb !== "GET") cmd.v = effVerb;
  if (hint?.l && hint.l !== cmd.m) cmd.l = hint.l;
  if (hint?.p !== undefined && hint.p !== defaultParamsFor(iface, cmd.m)) cmd.p = hint.p;
  if (hint?.d) cmd.d = hint.d;
  Object.assign(cmd, runnability(iface, cmd, hint, api));
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
        cmds.push(makeCmd(iface, hint.m, "GET", hint, null));
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

/* ── Runnable-defaults roll-call ─────────────────────────────────────────── */

/* Which (spec × interface) pairs ended up with nothing the drawer can offer
   as a working default. Aliases resolve to their canonical entry, so a chain
   that aliases a covered one is covered too. */
const noRunnable = [];
let readyTotal = 0;
for (const index of Object.keys(out).sort()) {
  let entry = out[index];
  for (let hops = 0; typeof entry === "string" && hops < 4; hops++) entry = out[entry];
  if (typeof entry !== "object") continue;
  for (const iface of Object.keys(entry).sort()) {
    const regular = entry[iface].regular ?? [];
    const ready = regular.filter((c) => c.r).length;
    readyTotal += ready;
    if (ready === 0) noRunnable.push(`${index}/${iface}`);
  }
}
writeFileSync(NO_RUNNABLE_PATH, `${JSON.stringify(noRunnable, null, 2)}\n`);

/* ── Summary ─────────────────────────────────────────────────────────────── */

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`specs dir        ${SPECS_DIR}`);
console.log(`specs indexed    ${specsByIndex.size}`);
console.log(`specs emitted    ${Object.keys(out).length} (${aliased} aliased to an identical entry)`);
console.log(`iface entries    ${ifaceEntries} (canonical, aliases excluded)`);
console.log(`methods by tier  regular=${tierTotals.regular} archive=${tierTotals.archive} debug=${tierTotals.debug} trace=${tierTotals.trace}`);
console.log(`runnable         ${readyTotal} commands can be sent as-is`);
console.log(`output           ${OUT_PATH} (${kb(Buffer.byteLength(json))})`);
console.log(`no runnable      ${noRunnable.length} (spec × iface) pairs → ${NO_RUNNABLE_PATH}`);
for (const pair of noRunnable) console.log(`  - ${pair}: no command runs without caller input`);
if (skipped.length > 0) {
  console.log(`skipped          ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s.index ?? s.file}: ${s.reason}`);
}
