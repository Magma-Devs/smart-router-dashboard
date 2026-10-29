/**
 * Every error code Smart Router v1.6.0 knows, in words a client can act on.
 *
 * The router names each failure with a code from its registry (smart-router
 * `protocol/common/error_codes.go`: 133 codes, plus `UNKNOWN_ERROR` when no rule matched).
 * This table gives each code what the Errors page needs to say about it:
 *
 * - `source`: where the error comes from. The request, the chain, a provider, the router,
 *   or unclear when the code alone doesn't say.
 * - `meaning`: what happened, in one short sentence (two at most), stating only what the
 *   code proves.
 * - `action`: what the client can do, or `""` when there is nothing useful for it to do.
 *   It never promises work from us and never says to read the provider's message (the
 *   screen shows it). It says to retry only where waiting is the fix (a block not produced
 *   yet), never for a provider failure the router already retries elsewhere.
 *   The "may already be on chain" warning comes from `mayHaveGoneThrough`, not from here.
 * - `routerRetries`: the router tries another provider on this error (its Retryable flag).
 *   Transactions are the exception: the router sends them to every provider at once and
 *   never sends them again.
 * - `mayHaveGoneThrough`: a transaction may be on chain despite this error. The router's
 *   own MayHaveReachedNode flag (broken or timed-out connections, `UNKNOWN_ERROR`), plus
 *   answers that say the transaction is already there or queued.
 *
 * Chain or provider: would a second healthy, up-to-date provider give the same answer?
 * Yes, chain. Maybe not, provider. A "not found" answer is tagged provider: the provider
 * says it doesn't hold the data.
 *
 * The Errors and Transactions tabs draw it when a row is opened (the web's
 * request-breakdown.tsx). docs/ERROR-CODES.md has the rules, the points R&D still has to
 * confirm, and how to add a code when the router adds one.
 */

export const ERROR_SOURCES = ["request", "chain", "provider", "router", "unclear"] as const;

export type ErrorSource = (typeof ERROR_SOURCES)[number];

/** One word per source, the same everywhere it is shown. */
export const ERROR_SOURCE_LABELS: Record<ErrorSource, string> = {
  request: "Request",
  chain: "Chain",
  provider: "Provider",
  router: "Router",
  unclear: "Undetermined",
};

export interface RouterErrorCode {
  /** The router's number for the code. */
  code: number;
  /** The router's name for the code, as its logs write it: `NODE_DATA_NOT_HELD`. */
  name: string;
  source: ErrorSource;
  /** What happened, in one short plain sentence. */
  meaning: string;
  /** What the client can do. Empty when there is nothing useful for the client to do. */
  action: string;
  /** The router tries another provider on this error. Never true of a transaction resend. */
  routerRetries: boolean;
  /** A transaction may be on chain despite this error: check before sending it again. */
  mayHaveGoneThrough: boolean;
}

type Entry = Omit<RouterErrorCode, "name">;

const ENTRIES: Record<string, Entry> = {
  // No rule matched (code 0).
  UNKNOWN_ERROR: {
    code: 0,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The router got an error it doesn't recognize.",
    action: "",
  },

  // PROTOCOL_: raised inside the router, mostly about reaching a provider (1000-1999).
  PROTOCOL_CONNECTION_TIMEOUT: {
    code: 1001,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The provider didn't answer in time.",
    action: "",
  },
  PROTOCOL_CONNECTION_REFUSED: {
    code: 1002,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider refused the connection. The request never reached it.",
    action: "",
  },
  PROTOCOL_DNS_FAILURE: {
    code: 1003,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The router couldn't look up the provider's address. The request never reached it.",
    action: "",
  },
  PROTOCOL_TLS_MISMATCH: {
    code: 1004,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider's address uses the wrong protocol (HTTP or HTTPS). The request never reached it.",
    action: "",
  },
  PROTOCOL_CONNECTION_RESET: {
    code: 1005,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The connection to the provider broke during the request.",
    action: "",
  },
  PROTOCOL_CONNECTION_CLOSED: {
    code: 1006,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The provider closed the connection before it sent a full answer.",
    action: "",
  },
  PROTOCOL_CONTEXT_DEADLINE: {
    code: 1007,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning:
      "Time ran out before the request finished. The time limit may be the client's, the router's or the provider's.",
    action: "If the client's timeout is too short, raise it.",
  },
  PROTOCOL_CONTEXT_CANCELED: {
    code: 1008,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning:
      "The client closed the connection before the request finished. On one try, it can also mean another provider answered first.",
    action: "If the client gives up too early, raise its timeout.",
  },
  PROTOCOL_NETWORK_UNREACHABLE: {
    code: 1009,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The router had no network path to the provider. The request never reached it.",
    action: "",
  },
  PROTOCOL_NO_PROVIDERS: {
    code: 1010,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The router had no provider for this request.",
    action: "",
  },
  PROTOCOL_ALL_ENDPOINTS_DISABLED: {
    code: 1011,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "After repeated failures, the router had turned off every provider for this request.",
    action: "Retry later.",
  },
  PROTOCOL_PROVIDER_UNAVAILABLE: {
    code: 1012,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The request asked for one provider, and the router couldn't use it.",
    action: "Check the provider name in the header, or let the router choose.",
  },
  PROTOCOL_PROVIDER_ABORTED: {
    code: 1013,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider stopped handling the request.",
    action: "",
  },
  PROTOCOL_PROVIDER_DATA_LOSS: {
    code: 1014,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider reported that data was lost.",
    action: "",
  },
  PROTOCOL_INSUFFICIENT_PROVIDERS: {
    code: 1015,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "There weren't enough providers or provider groups to start cross-validation.",
    action: "If the client sends cross-validation headers, ask for fewer providers.",
  },
  PROTOCOL_RATE_LIMITED: {
    code: 1020,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The router's own rate limit was reached.",
    action: "Slow down.",
  },
  PROTOCOL_MAX_CU_EXCEEDED: {
    code: 1021,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network limit on compute units was reached.",
    action: "",
  },
  PROTOCOL_BATCH_SIZE_EXCEEDED: {
    code: 1022,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The batch has more calls than this router accepts.",
    action: "Split the batch into smaller ones.",
  },
  PROTOCOL_CU_MISMATCH: {
    code: 1023,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network error about compute units.",
    action: "",
  },
  PROTOCOL_SESSION_NOT_FOUND: {
    code: 1030,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network session error.",
    action: "",
  },
  PROTOCOL_EPOCH_MISMATCH: {
    code: 1031,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network epoch error.",
    action: "",
  },
  PROTOCOL_CONSUMER_BLOCKED: {
    code: 1032,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network error: the consumer was blocked.",
    action: "",
  },
  PROTOCOL_CONSUMER_NOT_REGISTERED: {
    code: 1033,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network error: the consumer wasn't registered.",
    action: "",
  },
  PROTOCOL_RELAY_NUMBER_MISMATCH: {
    code: 1034,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network session error.",
    action: "",
  },
  PROTOCOL_SESSION_OUT_OF_SYNC: {
    code: 1035,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network session error.",
    action: "",
  },
  PROTOCOL_INVALID_RELAY_REQUEST: {
    code: 1036,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network check on the request failed.",
    action: "",
  },
  PROTOCOL_REQUEST_BLOCK_MISMATCH: {
    code: 1037,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's block height didn't match what the request needed.",
    action: "",
  },
  PROTOCOL_SESSION_ACCOUNTING_FAILED: {
    code: 1038,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network session accounting error.",
    action: "",
  },
  PROTOCOL_SUBSCRIPTION_CLEANUP_FAILED: {
    code: 1039,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The router failed to close the client's subscriptions.",
    action: "",
  },
  PROTOCOL_FINALIZATION_ERROR: {
    code: 1040,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's finality data was wrong.",
    action: "",
  },
  PROTOCOL_CONSISTENCY_ERROR: {
    code: 1041,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's answer failed the router's consistency check.",
    action: "",
  },
  PROTOCOL_HASH_CONSENSUS_ERROR: {
    code: 1042,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "Cross-validation couldn't confirm an answer. Not enough separate providers gave the same answer.",
    action: "",
  },
  PROTOCOL_NO_RESPONSE_TIMEOUT: {
    code: 1043,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "No provider answered within the router's time limit.",
    action: "",
  },
  PROTOCOL_RELAY_PROCESSING_FAILED: {
    code: 1044,
    source: "router",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The router failed while handling this request.",
    action: "",
  },
  PROTOCOL_SUBSCRIPTION_NOT_FOUND: {
    code: 1050,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The client tried to end a subscription it doesn't have.",
    action: "Check the subscription ID.",
  },
  PROTOCOL_SUBSCRIPTION_INIT_FAILED: {
    code: 1051,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The provider answered, but the router failed to set up the subscription.",
    action: "Subscribe again.",
  },
  PROTOCOL_WEBSOCKET_IDLE_TIMEOUT: {
    code: 1052,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The WebSocket connection was idle for too long.",
    action: "Reconnect, and keep the connection active.",
  },
  PROTOCOL_SUBSCRIPTION_ALREADY_EXISTS: {
    code: 1053,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "This subscription already exists.",
    action: "Use the existing subscription.",
  },

  // NODE_: a provider's node answered (2000-2999).
  NODE_METHOD_NOT_FOUND: {
    code: 2001,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "This provider says the method doesn't exist. Another provider may have it.",
    action: "Check the method name.",
  },
  NODE_METHOD_NOT_SUPPORTED: {
    code: 2002,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "This provider doesn't support this method.",
    action: "",
  },
  NODE_INTERNAL_ERROR: {
    code: 2003,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's node had an internal error on this request.",
    action: "",
  },
  NODE_SERVER_ERROR: {
    code: 2004,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's server failed while handling the request.",
    action: "",
  },
  NODE_RATE_LIMITED: {
    code: 2005,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider is limiting our requests right now.",
    action: "",
  },
  NODE_SERVICE_UNAVAILABLE: {
    code: 2006,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's service isn't available right now.",
    action: "",
  },
  NODE_SYNCING: {
    code: 2007,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's node is still catching up with the chain.",
    action: "",
  },
  NODE_UNIMPLEMENTED: {
    code: 2008,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "This provider doesn't support this method or path.",
    action: "Check the method name.",
  },
  NODE_ENDPOINT_NOT_FOUND: {
    code: 2009,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "This path wasn't served. The provider doesn't have it, or on REST, the router doesn't know it for this chain.",
    action: "On a REST call, check the path.",
  },
  NODE_METHOD_NOT_ALLOWED: {
    code: 2010,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "This provider doesn't accept this HTTP method (like GET or POST) on this path.",
    action: "On a REST call, check the HTTP method.",
  },
  NODE_LIMIT_EXCEEDED: {
    code: 2011,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The provider says a limit was exceeded. It can be the query's size or the number of requests.",
    action: "If it's a range query, narrow the range. If it's a rate limit, slow down.",
  },
  NODE_RESOURCE_NOT_FOUND: {
    code: 2012,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have what the request asked for. It may not exist yet, or be older than the provider keeps.",
    action: "Check the ID or number. If it's new, retry shortly.",
  },
  NODE_RESOURCE_UNAVAILABLE: {
    code: 2013,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider says what the request asked for isn't available on its node right now.",
    action: "",
  },
  NODE_GATEWAY_TIMEOUT: {
    code: 2014,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The provider's gateway gave up waiting for its own node.",
    action: "",
  },
  NODE_BAD_GATEWAY: {
    code: 2015,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The provider's gateway got a bad answer from its own node.",
    action: "",
  },
  NODE_UNAUTHORIZED: {
    code: 2016,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider rejected the router's credentials for it.",
    action: "",
  },
  NODE_DATA_NOT_HELD: {
    code: 2017,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have this data. It may not exist yet, or be older than the provider keeps.",
    action: "Check the ID, address or block number.",
  },
  NODE_ACCESS_DENIED: {
    code: 2018,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider refused the router access.",
    action: "",
  },
  NODE_ABORTED: {
    code: 2019,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "Sui's validators stopped processing this transaction. A new send can succeed.",
    action: "Check the chain. If the transaction isn't there, send it again.",
  },
  NODE_BITCOIN_WARMUP: {
    code: 2101,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's Bitcoin node is still starting up.",
    action: "",
  },
  NODE_BITCOIN_INITIAL_DOWNLOAD: {
    code: 2102,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's Bitcoin node is still downloading the chain.",
    action: "",
  },
  NODE_BITCOIN_NOT_CONNECTED: {
    code: 2103,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's Bitcoin node isn't connected to the network, or is shutting down.",
    action: "",
  },
  NODE_SOLANA_UNHEALTHY: {
    code: 2150,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's Solana node is behind or unhealthy.",
    action: "",
  },

  // CHAIN_: the chain's rules or data (3000-3999).
  CHAIN_NONCE_TOO_LOW: {
    code: 3001,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "This nonce was already used.",
    action: "Check the chain before sending again.",
  },
  CHAIN_NONCE_TOO_HIGH: {
    code: 3002,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "The nonce skips ahead: an earlier transaction from this account isn't applied yet.",
    action:
      "Send the earlier transaction first. On XRP Ledger, this one may then apply by itself, so check the chain before sending it again.",
  },
  CHAIN_INSUFFICIENT_FUNDS: {
    code: 3003,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "Not enough funds for the amount and the fee.",
    action: "Add funds or lower the amount.",
  },
  CHAIN_GAS_TOO_LOW: {
    code: 3004,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The gas limit is below what this transaction needs.",
    action: "Raise the gas limit.",
  },
  CHAIN_GAS_LIMIT_EXCEEDED: {
    code: 3005,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The gas limit is higher than a block allows.",
    action: "Lower the gas limit.",
  },
  CHAIN_TX_UNDERPRICED: {
    code: 3006,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The fee is below this node's minimum, or too low for its full pending pool.",
    action: "Raise the fee.",
  },
  CHAIN_TX_ALREADY_KNOWN: {
    code: 3007,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "The network already has this exact transaction.",
    action: "Don't send it again.",
  },
  CHAIN_TX_REPLACEMENT_UNDERPRICED: {
    code: 3008,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "A transaction with this nonce is already pending, and the new one doesn't pay enough more to replace it.",
    action: "Raise the fee to replace it, or wait for the pending one.",
  },
  CHAIN_MEMPOOL_FULL: {
    code: 3009,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The provider's node has no room for new pending transactions right now.",
    action: "Send again later, or with a higher fee.",
  },
  CHAIN_TX_TOO_LARGE: {
    code: 3010,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The transaction is bigger than nodes accept.",
    action: "Make the transaction smaller.",
  },
  CHAIN_MAX_FEE_BELOW_BASE: {
    code: 3011,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The max fee per gas is below the block's current base fee.",
    action: "Raise the max fee.",
  },
  CHAIN_INVALID_SEQUENCE: {
    code: 3012,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The account sequence (the Cosmos nonce) doesn't match.",
    action: "Get the account's current sequence, sign again and send.",
  },
  CHAIN_INSUFFICIENT_FEE: {
    code: 3013,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The fee is below this node's minimum.",
    action: "Raise the fee.",
  },
  CHAIN_TX_REJECTED: {
    code: 3014,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning:
      "The node refused the transaction. On XRP Ledger the refusal may not be final: the transaction may still apply later.",
    action: "Check the chain before sending again.",
  },
  CHAIN_DOUBLE_SPEND: {
    code: 3015,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An input of this transaction is already spent.",
    action: "Rebuild the transaction from unspent outputs.",
  },
  CHAIN_INVALID_SIGNATURE: {
    code: 3016,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The transaction's signature isn't valid.",
    action: "Sign again with the right key.",
  },
  CHAIN_EXECUTION_REVERTED: {
    code: 3101,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The smart contract rejected the call (reverted).",
    action: "Check the call's inputs against the contract.",
  },
  CHAIN_OUT_OF_GAS: {
    code: 3102,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The call ran out of gas before it finished.",
    action: "Raise the gas limit.",
  },
  CHAIN_STACK_OVERFLOW: {
    code: 3103,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The contract used more than the EVM's 1,024-item stack.",
    action: "Check the contract call.",
  },
  CHAIN_INVALID_OPCODE: {
    code: 3104,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The contract ran an invalid instruction.",
    action: "Check the contract call.",
  },
  CHAIN_WRITE_PROTECTION: {
    code: 3105,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The call tried to change state where only reading is allowed.",
    action: "Check the contract call.",
  },
  CHAIN_CONTRACT_SIZE_EXCEEDED: {
    code: 3106,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The contract's code is over the 24 KB limit.",
    action: "Make the contract smaller.",
  },
  CHAIN_ACCOUNT_NOT_FOUND: {
    code: 3107,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "No account at this address. It may never have been funded, or this provider is behind.",
    action: "Check the address. If it was just funded, retry shortly.",
  },
  CHAIN_ZKEVM_OUT_OF_COUNTERS: {
    code: 3108,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "Polygon zkEVM can't prove this transaction: it needs too many steps.",
    action: "Split it into smaller transactions.",
  },
  CHAIN_BLOCK_NOT_FOUND: {
    code: 3201,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have this block. It may not exist yet, or be older than the provider keeps.",
    action: "Check the block number. If the block is new, retry shortly.",
  },
  CHAIN_TX_NOT_FOUND: {
    code: 3202,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have this transaction. It may still be pending, or be older than the provider keeps.",
    action: "Check the hash. If the transaction was just sent, retry shortly.",
  },
  CHAIN_RECEIPT_NOT_FOUND: {
    code: 3203,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider has no receipt for this transaction. It may still be pending, or be older than the provider keeps.",
    action: "Check the hash. If the transaction was just sent, retry shortly.",
  },
  CHAIN_STATE_PRUNED: {
    code: 3204,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider no longer keeps the state for that block.",
    action: "",
  },
  CHAIN_DATA_NOT_AVAILABLE: {
    code: 3205,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider doesn't have this historical data.",
    action: "",
  },
  CHAIN_BLOCK_TOO_OLD: {
    code: 3206,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider serves this only for recent blocks.",
    action: "",
  },
  CHAIN_LOG_RESPONSE_TOO_LARGE: {
    code: 3207,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The log query matches too many results.",
    action: "Narrow the block range or the filter.",
  },
  CHAIN_SOLANA_MISSING_LONG_TERM: {
    code: 3302,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "This provider has no block for this slot. Solana skipped the slot, or it's missing from long-term storage.",
    action: "Check the slot number.",
  },
  CHAIN_SOLANA_LEDGER_JUMP: {
    code: 3303,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "This provider has no data for this slot. Its node started from a later snapshot, or the slot was skipped.",
    action: "Check the slot number.",
  },
  CHAIN_SOLANA_BLOCKHASH_NOT_FOUND: {
    code: 3304,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The node doesn't know the transaction's recent blockhash. It expired, or this node hasn't seen it yet.",
    action: "Get a fresh blockhash, sign again and send.",
  },
  CHAIN_SOLANA_SIMULATION_FAILED: {
    code: 3305,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The transaction failed when the node simulated it, so it wasn't sent. An expired blockhash is one cause.",
    action:
      "If the blockhash wasn't found, get a fresh one, sign again and send. Otherwise, fix what the program logs show.",
  },
  CHAIN_SOLANA_SIGNATURE_VERIFY_FAILED: {
    code: 3306,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "A signature on the transaction isn't valid.",
    action: "Sign again with the right keys.",
  },
  CHAIN_SOLANA_EXCLUDED_FROM_INDEX: {
    code: 3307,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "This provider's node doesn't index this account, so it can't run this query.",
    action: "",
  },
  CHAIN_SOLANA_SIGNATURE_LENGTH_MISMATCH: {
    code: 3308,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The transaction has a different number of signatures than its signers need.",
    action: "Sign with exactly the required signers, then send again.",
  },
  CHAIN_SOLANA_BLOCK_STATUS_UNAVAILABLE: {
    code: 3309,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider doesn't have this block's status yet.",
    action: "",
  },
  CHAIN_SOLANA_TX_VERSION_UNSUPPORTED: {
    code: 3310,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The answer has a newer transaction version, and the request didn't say it can read it.",
    action: "Add maxSupportedTransactionVersion to the request.",
  },
  CHAIN_SOLANA_MIN_CONTEXT_SLOT_NOT_REACHED: {
    code: 3311,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's node hasn't reached the minimum slot the request asked for.",
    action: "",
  },
  CHAIN_STARKNET_FAILED_TO_RECEIVE_TX: {
    code: 3320,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "The node couldn't take the transaction.",
    action: "Check the chain by hash. If the transaction isn't there, send it again.",
  },
  CHAIN_STARKNET_CLASS_NOT_FOUND: {
    code: 3321,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "No contract class with this hash. It may never have been declared, or this provider is behind.",
    action: "Check the class hash. If it was just declared, retry shortly.",
  },
  CHAIN_STARKNET_COMPILATION_FAILED: {
    code: 3322,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The contract class failed to compile (Sierra to CASM).",
    action: "Fix the contract class.",
  },
  CHAIN_STARKNET_CLASS_ALREADY_DECLARED: {
    code: 3323,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "This contract class is already declared.",
    action: "Use the existing class.",
  },
  CHAIN_STARKNET_CONTRACT_ERROR: {
    code: 3324,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The contract returned an error.",
    action: "Check the call against the contract.",
  },
  CHAIN_STARKNET_TX_EXEC_ERROR: {
    code: 3325,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The transaction failed while it ran.",
    action: "Fix the transaction.",
  },
  CHAIN_STARKNET_INVALID_NONCE: {
    code: 3326,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The transaction's nonce doesn't match the account.",
    action: "Get the account's current nonce, sign again and send.",
  },
  CHAIN_STARKNET_INSUFFICIENT_FEE: {
    code: 3327,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The max fee is too low.",
    action: "Raise the max fee.",
  },
  CHAIN_STARKNET_INSUFFICIENT_BALANCE: {
    code: 3328,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The account can't pay the max fee.",
    action: "Add funds.",
  },
  CHAIN_STARKNET_VALIDATION_FAILURE: {
    code: 3329,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The account contract rejected the transaction when it checked it.",
    action: "Check the signature and the account.",
  },
  CHAIN_STARKNET_CONTRACT_NOT_FOUND: {
    code: 3330,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "No contract at this address. It may never have been deployed, or this provider is behind.",
    action: "Check the address. If it was just deployed, retry shortly.",
  },
  CHAIN_STARKNET_BLOCK_NOT_FOUND: {
    code: 3331,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider doesn't have this block.",
    action: "Check the block number. If the block is new, retry shortly.",
  },
  CHAIN_STARKNET_TX_HASH_NOT_FOUND: {
    code: 3332,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have this transaction. It may still be pending, or be older than the provider keeps.",
    action: "Check the hash. If the transaction was just sent, retry shortly.",
  },
  CHAIN_STARKNET_DUPLICATE_TX: {
    code: 3333,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "This transaction is already pending.",
    action: "Don't send it again.",
  },
  CHAIN_STARKNET_TX_VERSION_UNSUPPORTED: {
    code: 3334,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "Starknet doesn't accept this transaction version.",
    action: "Use a supported transaction version.",
  },
  CHAIN_STARKNET_UNEXPECTED_ERROR: {
    code: 3335,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's Starknet node had an unexpected error.",
    action: "",
  },
  CHAIN_BITCOIN_VERIFY_ERROR: {
    code: 3341,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The transaction failed Bitcoin's checks, for example missing or spent inputs.",
    action: "Fix the transaction.",
  },
  CHAIN_BITCOIN_VERIFY_REJECTED: {
    code: 3342,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The node refused the transaction under the network's rules or its own, like a minimum fee.",
    action: "Fix the transaction and send again.",
  },
  CHAIN_BITCOIN_ALREADY_IN_CHAIN: {
    code: 3343,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "This transaction is already confirmed.",
    action: "",
  },
  CHAIN_BITCOIN_WALLET_INSUFFICIENT_FUNDS: {
    code: 3344,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The node's own wallet can't fund this wallet call. It says nothing about the client's balance.",
    action: "Build and sign the transaction in the client, then send it with sendrawtransaction.",
  },
  CHAIN_NEAR_UNKNOWN_BLOCK: {
    code: 3360,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have this block. It doesn't exist yet, or the node already dropped it.",
    action: "Check the block. If the block is new, retry shortly.",
  },
  CHAIN_NEAR_UNKNOWN_CHUNK: {
    code: 3361,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have this chunk. It may not exist, or be older than the provider keeps.",
    action: "Check the chunk ID.",
  },
  CHAIN_NEAR_INVALID_SHARD_ID: {
    code: 3362,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The shard ID in the request doesn't exist.",
    action: "Use a valid shard ID.",
  },
  CHAIN_NEAR_NOT_SYNCED_YET: {
    code: 3363,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's NEAR node is still syncing.",
    action: "",
  },

  // USER_: the request itself (4000-4999).
  USER_PARSE_ERROR: {
    code: 4001,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The provider couldn't read the request, though the router read it as valid JSON.",
    action: "If the same request keeps failing, check it for unusual characters.",
  },
  USER_INVALID_REQUEST: {
    code: 4002,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The provider rejected the request as invalid. On some REST chains (Stellar), this also means the chain refused a transaction.",
    action: "",
  },
  USER_INVALID_PARAMS: {
    code: 4003,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The provider says the request's parameters are wrong.",
    action: "Check the parameters.",
  },
  USER_INVALID_BLOCK_FORMAT: {
    code: 4004,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "A hex value is in the wrong format, usually a block number or hash.",
    action: "Check hex values, block numbers and hashes. They need 0x.",
  },
  USER_INVALID_ADDRESS: {
    code: 4005,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The address isn't valid: wrong format or checksum.",
    action: "Fix the address.",
  },
  USER_REQUEST_TOO_LARGE: {
    code: 4006,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The request is bigger than the provider accepts.",
    action: "Send a smaller request.",
  },
  USER_INVALID_HEX: {
    code: 4007,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "A hex value in the request isn't valid.",
    action: "Fix the hex value.",
  },
};

/** Every code by name. */
export const ROUTER_ERROR_CODES: Readonly<Record<string, RouterErrorCode>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ENTRIES).map(([name, entry]) => [name, Object.freeze({ name, ...entry })]),
  ),
);

/**
 * The entry for a code name as the router writes it (`NODE_DATA_NOT_HELD`), or null for a
 * name this table doesn't know. Case and surrounding spaces don't matter.
 */
export function explainRouterError(name: string | null | undefined): RouterErrorCode | null {
  if (!name) return null;
  const key = name.trim().toUpperCase();
  return Object.hasOwn(ROUTER_ERROR_CODES, key) ? (ROUTER_ERROR_CODES[key] ?? null) : null;
}
