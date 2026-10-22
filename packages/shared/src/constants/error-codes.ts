/**
 * Every error code Smart Router v1.6.0 knows, in words a customer can act on.
 *
 * The router names each failure with a code from its registry (smart-router
 * `protocol/common/error_codes.go`: 133 codes, plus `UNKNOWN_ERROR` when no rule matched).
 * This table gives each code what the Errors page needs to say about it:
 *
 * - `source`: where the error comes from. The request, the chain, a provider, the router,
 *   or unclear when the code alone doesn't say.
 * - `meaning`: what happened, stating only what the code proves.
 * - `action`: what the customer can do on their side. It never promises work from us.
 * - `routerRetries`: the router tries another provider on this error (its Retryable flag).
 *   Transactions are the exception: the router sends them to every provider at once and
 *   never sends them again.
 * - `mayHaveGoneThrough`: a transaction may be on chain despite this error. The router's
 *   own MayHaveReachedNode flag (broken or timed-out connections, `UNKNOWN_ERROR`), plus
 *   answers that say the transaction is already there or queued.
 *
 * Chain or provider: would a second healthy, up-to-date provider give the same answer?
 * Yes, chain. Maybe not, provider. A "not found" answer is tagged provider: the provider
 * says it doesn't hold the data, and the meaning lists what that can mean.
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
  /** What happened, in plain words. */
  meaning: string;
  /** What the customer can do on their side. */
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
    meaning: "The router didn't recognize this error.",
    action:
      "Read the error message. For a transaction: check the chain before sending it again. It may have gone through.",
  },

  // PROTOCOL_: raised inside the router, mostly about reaching a provider (1000-1999).
  PROTOCOL_CONNECTION_TIMEOUT: {
    code: 1001,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The router timed out connecting to the provider or waiting for its answer.",
    action:
      "Retry later. For a transaction: check the chain before sending it again. It may have gone through.",
  },
  PROTOCOL_CONNECTION_REFUSED: {
    code: 1002,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's server refused the connection. The request never reached it.",
    action: "Retry later.",
  },
  PROTOCOL_DNS_FAILURE: {
    code: 1003,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The router couldn't look up the provider's address (DNS). The request never reached it.",
    action:
      "Retry later. If you run the router and manage its providers yourself, check this provider's URL in your router config.",
  },
  PROTOCOL_TLS_MISMATCH: {
    code: 1004,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider's address is set up with the wrong protocol (HTTP vs HTTPS). The request never reached it.",
    action:
      "No action on your side. If you run the router and manage its providers yourself, check this provider's URL in your router config.",
  },
  PROTOCOL_CONNECTION_RESET: {
    code: 1005,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The connection to the provider broke in the middle of the request.",
    action:
      "Retry later. For a transaction: check the chain before sending it again. It may have gone through.",
  },
  PROTOCOL_CONNECTION_CLOSED: {
    code: 1006,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The provider closed the connection before sending a full answer.",
    action:
      "Retry later. For a transaction: check the chain before sending it again. It may have gone through.",
  },
  PROTOCOL_CONTEXT_DEADLINE: {
    code: 1007,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning:
      "Time ran out before the request finished. It can be a timeout in your app, the router's time limit, or a slow provider.",
    action:
      "Retry. For a transaction: check the chain before sending it again. It may have gone through.",
  },
  PROTOCOL_CONTEXT_CANCELED: {
    code: 1008,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning:
      "The request was stopped before it finished because the app closed the connection. On a single try it can also mean another provider answered first.",
    action:
      "Nothing, unless your app gives up too early. Then raise its timeout. For a transaction: check the chain before sending it again. It may have gone through.",
  },
  PROTOCOL_NETWORK_UNREACHABLE: {
    code: 1009,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The router had no network route to the provider. The request never reached it.",
    action: "Retry later.",
  },
  PROTOCOL_NO_PROVIDERS: {
    code: 1010,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The router had no provider available for this request.",
    action:
      "No action on your side. If you run the router yourself, check that this chain and interface have a provider in your router config.",
  },
  PROTOCOL_ALL_ENDPOINTS_DISABLED: {
    code: 1011,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The router had switched off the providers' endpoints after repeated failures, so none could take this request.",
    action: "Retry later.",
  },
  PROTOCOL_PROVIDER_UNAVAILABLE: {
    code: 1012,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The request pinned one provider and the router couldn't use it. The name was unknown or ambiguous, or the provider was blocked, didn't serve this request, or had already failed.",
    action: "Check the provider name in the header, or let the router pick.",
  },
  PROTOCOL_PROVIDER_ABORTED: {
    code: 1013,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider aborted the request (gRPC ABORTED).",
    action: "Retry later.",
  },
  PROTOCOL_PROVIDER_DATA_LOSS: {
    code: 1014,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider reported data loss (gRPC DATA_LOSS).",
    action: "Retry later.",
  },
  PROTOCOL_INSUFFICIENT_PROVIDERS: {
    code: 1015,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "Cross-validation couldn't start: there were too few providers or provider groups for what it needed.",
    action:
      "If you send cross-validation headers, ask for fewer providers. Otherwise, no action on your side.",
  },
  PROTOCOL_RATE_LIMITED: {
    code: 1020,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The router's own rate limit was reached.",
    action: "Slow down and retry.",
  },
  PROTOCOL_MAX_CU_EXCEEDED: {
    code: 1021,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network limit on compute units was reached.",
    action: "No action on your side.",
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
    meaning: "An old Lava-network compute-unit accounting error.",
    action: "No action on your side.",
  },
  PROTOCOL_SESSION_NOT_FOUND: {
    code: 1030,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network session error.",
    action: "No action on your side.",
  },
  PROTOCOL_EPOCH_MISMATCH: {
    code: 1031,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network epoch error.",
    action: "No action on your side.",
  },
  PROTOCOL_CONSUMER_BLOCKED: {
    code: 1032,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network error: the consumer was blocklisted.",
    action: "No action on your side.",
  },
  PROTOCOL_CONSUMER_NOT_REGISTERED: {
    code: 1033,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network error: the consumer wasn't registered.",
    action: "No action on your side.",
  },
  PROTOCOL_RELAY_NUMBER_MISMATCH: {
    code: 1034,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network session error.",
    action: "No action on your side.",
  },
  PROTOCOL_SESSION_OUT_OF_SYNC: {
    code: 1035,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network session error.",
    action: "No action on your side.",
  },
  PROTOCOL_INVALID_RELAY_REQUEST: {
    code: 1036,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network check on the relay failed.",
    action: "No action on your side.",
  },
  PROTOCOL_REQUEST_BLOCK_MISMATCH: {
    code: 1037,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's block height didn't match what the request needed.",
    action: "Retry shortly.",
  },
  PROTOCOL_SESSION_ACCOUNTING_FAILED: {
    code: 1038,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "An old Lava-network session accounting error.",
    action: "No action on your side.",
  },
  PROTOCOL_SUBSCRIPTION_CLEANUP_FAILED: {
    code: 1039,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The router failed to close the app's subscriptions.",
    action: "No action on your side.",
  },
  PROTOCOL_FINALIZATION_ERROR: {
    code: 1040,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's finality data was wrong.",
    action: "Retry later.",
  },
  PROTOCOL_CONSISTENCY_ERROR: {
    code: 1041,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's answer failed the router's consistency check.",
    action: "Retry later.",
  },
  PROTOCOL_HASH_CONSENSUS_ERROR: {
    code: 1042,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "Cross-validation couldn't confirm an answer. The providers didn't agree enough, or the ones that agreed weren't from enough separate groups.",
    action: "Retry later.",
  },
  PROTOCOL_NO_RESPONSE_TIMEOUT: {
    code: 1043,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "No provider answered within the router's time limit.",
    action: "Retry later.",
  },
  PROTOCOL_RELAY_PROCESSING_FAILED: {
    code: 1044,
    source: "router",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The router failed while handling this request.",
    action: "Retry later.",
  },
  PROTOCOL_SUBSCRIPTION_NOT_FOUND: {
    code: 1050,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The app tried to unsubscribe from a subscription it doesn't hold.",
    action: "Check the subscription ID.",
  },
  PROTOCOL_SUBSCRIPTION_INIT_FAILED: {
    code: 1051,
    source: "router",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The provider answered, but the router failed to set up the subscription.",
    action: "Retry later.",
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
    meaning:
      "This provider says the method doesn't exist on its node. Another provider may offer it.",
    action: "Check the method name. If it's right, no action on your side.",
  },
  NODE_METHOD_NOT_SUPPORTED: {
    code: 2002,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "This provider says it doesn't support this method. It may be off on its plan, or not built in. Another provider may offer it.",
    action: "No action on your side.",
  },
  NODE_INTERNAL_ERROR: {
    code: 2003,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's node hit an internal error on this request.",
    action: "Retry later. If it keeps failing, read the provider's message.",
  },
  NODE_SERVER_ERROR: {
    code: 2004,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider returned a general server error. The code alone doesn't say why. The provider's message does.",
    action: "Read the provider's message.",
  },
  NODE_RATE_LIMITED: {
    code: 2005,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider is limiting how many requests it takes right now.",
    action: "Retry later.",
  },
  NODE_SERVICE_UNAVAILABLE: {
    code: 2006,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's service is temporarily unavailable.",
    action: "Retry later.",
  },
  NODE_SYNCING: {
    code: 2007,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's node is still catching up with the chain.",
    action: "Retry later.",
  },
  NODE_UNIMPLEMENTED: {
    code: 2008,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "This provider doesn't implement this method or route.",
    action: "Check the method name. If it's right, no action on your side.",
  },
  NODE_ENDPOINT_NOT_FOUND: {
    code: 2009,
    source: "unclear",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "This path wasn't served. Either the provider doesn't route it, or, on REST, the router doesn't have the path in its list for this chain and answered 501 itself without asking any provider.",
    action: "On a REST call, check the path. If it's right, no action on your side.",
  },
  NODE_METHOD_NOT_ALLOWED: {
    code: 2010,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "This provider doesn't accept this HTTP method (like GET or POST) on this path.",
    action: "On a REST call, check the HTTP method. Otherwise, no action on your side.",
  },
  NODE_LIMIT_EXCEEDED: {
    code: 2011,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The provider says a limit was exceeded. It can be the size of the query (like an eth_getLogs block range) or a limit on how many requests it takes.",
    action:
      "If it's a range query, narrow the range. If it's a rate limit, slow down and retry later.",
  },
  NODE_RESOURCE_NOT_FOUND: {
    code: 2012,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider says it doesn't have what the request asked for. It may not exist, may not exist yet, or may be older than this provider keeps.",
    action: "Check the ID or number. If it's new, retry shortly.",
  },
  NODE_RESOURCE_UNAVAILABLE: {
    code: 2013,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider says what the request asked for isn't available on its node right now.",
    action: "Retry shortly.",
  },
  NODE_GATEWAY_TIMEOUT: {
    code: 2014,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The provider's gateway gave up waiting for its own node.",
    action:
      "Retry later. For a transaction: check the chain before sending it again. It may have gone through.",
  },
  NODE_BAD_GATEWAY: {
    code: 2015,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: true,
    meaning: "The provider's gateway got a bad answer from its own node.",
    action:
      "Retry later. For a transaction: check the chain before sending it again. It may have gone through.",
  },
  NODE_UNAUTHORIZED: {
    code: 2016,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider rejected the credentials the router uses for it.",
    action:
      "No action on your side. If you run the router and manage its providers yourself, check this provider's credentials in your router config.",
  },
  NODE_DATA_NOT_HELD: {
    code: 2017,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider says it doesn't hold this data. It may not exist (a wrong ID, an account that was never created, a block that isn't produced yet), or it may be older than this provider keeps. On REST, a 404 can also mean the path doesn't exist.",
    action: "Check the path, ID, address or block number. If it's new, retry shortly.",
  },
  NODE_ACCESS_DENIED: {
    code: 2018,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider refused the router's access: credentials, plan, firewall or region.",
    action:
      "No action on your side. If you run the router and manage its providers yourself, check this provider's credentials and plan in your router config.",
  },
  NODE_ABORTED: {
    code: 2019,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning:
      "Sui's validators aborted processing this transaction. It may still be on chain. Sui says a new submission can succeed.",
    action: "Check whether the transaction is on chain. If it isn't, submit it again.",
  },
  NODE_BITCOIN_WARMUP: {
    code: 2101,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's Bitcoin node is still starting up.",
    action: "Retry later.",
  },
  NODE_BITCOIN_INITIAL_DOWNLOAD: {
    code: 2102,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's Bitcoin node is still downloading the chain.",
    action: "Retry later.",
  },
  NODE_BITCOIN_NOT_CONNECTED: {
    code: 2103,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's Bitcoin node isn't connected to the network, or is shutting down.",
    action: "Retry later.",
  },
  NODE_SOLANA_UNHEALTHY: {
    code: 2150,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's Solana node is behind or unhealthy.",
    action: "Retry later.",
  },

  // CHAIN_: the chain's rules or data (3000-3999).
  CHAIN_NONCE_TOO_LOW: {
    code: 3001,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning:
      "The transaction's nonce (the account's transaction counter) is already used. The same transaction may have gone through already, or another one used this nonce.",
    action:
      "Check whether a transaction with this nonce already went through before sending again.",
  },
  CHAIN_NONCE_TOO_HIGH: {
    code: 3002,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning:
      "The nonce skips ahead: an earlier transaction from this account hasn't been applied yet.",
    action:
      "Send the missing earlier transaction first. On XRP Ledger this one may then apply by itself, so check before sending it again.",
  },
  CHAIN_INSUFFICIENT_FUNDS: {
    code: 3003,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The account doesn't have enough to cover the amount plus the fee.",
    action: "Add funds or lower the amount, then send again.",
  },
  CHAIN_GAS_TOO_LOW: {
    code: 3004,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The gas limit is below the minimum this transaction needs.",
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
    meaning:
      "The fee is too low for this node: below its minimum, or below what its full pending pool holds.",
    action: "Raise the fee.",
  },
  CHAIN_TX_ALREADY_KNOWN: {
    code: 3007,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "The network already has this exact transaction.",
    action: "Nothing. Don't send it again.",
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
    meaning: "The transaction is bigger than the size nodes accept.",
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
    meaning: "The account sequence (Cosmos's version of a nonce) doesn't match.",
    action: "Get the account's current sequence, sign again and send.",
  },
  CHAIN_INSUFFICIENT_FEE: {
    code: 3013,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The fee is below this node's minimum, which can be its own setting or a chain rule.",
    action: "Raise the fee.",
  },
  CHAIN_TX_REJECTED: {
    code: 3014,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning:
      "The node refused the transaction. On XRP Ledger the refusal may come from this server only, or be provisional: the transaction may still apply in a later ledger.",
    action: "Check whether it was applied before sending again.",
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
    meaning: "The transaction's signature doesn't verify.",
    action: "Sign again with the right key.",
  },
  CHAIN_EXECUTION_REVERTED: {
    code: 3101,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The smart contract rejected the call (reverted).",
    action:
      "Check the call's inputs against the contract. The reason, if the contract gives one, is in the message.",
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
      "No account found at this address. It may never have been funded, or this provider hasn't reached the block that created it.",
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
      "The provider doesn't have this block. It may not be produced yet, or it may be older than this provider keeps.",
    action: "Check the block number. If it's new, retry shortly.",
  },
  CHAIN_TX_NOT_FOUND: {
    code: 3202,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have this transaction. It may still be pending, the hash may be wrong, or it may be older than this provider keeps.",
    action: "Check the hash. If you just sent it, retry shortly.",
  },
  CHAIN_RECEIPT_NOT_FOUND: {
    code: 3203,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider has no receipt for this transaction. It may still be pending, the hash may be wrong, or it may be older than this provider keeps.",
    action: "Check the hash. If you just sent it, retry shortly.",
  },
  CHAIN_STATE_PRUNED: {
    code: 3204,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider no longer keeps the state for that block (pruned).",
    action: "No action on your side.",
  },
  CHAIN_DATA_NOT_AVAILABLE: {
    code: 3205,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider doesn't have this historical data.",
    action: "No action on your side.",
  },
  CHAIN_BLOCK_TOO_OLD: {
    code: 3206,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider serves this only for recent blocks.",
    action: "No action on your side.",
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
      "This provider has no block for this slot: Solana skipped the slot, or it's missing from long-term storage.",
    action: "Check the slot number.",
  },
  CHAIN_SOLANA_LEDGER_JUMP: {
    code: 3303,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "This provider has no data for this slot: its node started from a later snapshot, or the slot was skipped.",
    action: "Check the slot number.",
  },
  CHAIN_SOLANA_BLOCKHASH_NOT_FOUND: {
    code: 3304,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The node doesn't recognize the transaction's recent blockhash: it expired, or this node hasn't seen it yet.",
    action: "Get a fresh blockhash, sign again and send.",
  },
  CHAIN_SOLANA_SIMULATION_FAILED: {
    code: 3305,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The transaction failed when the node simulated it, so it wasn't sent. One reason is an expired blockhash.",
    action:
      "If the message says the blockhash wasn't found, get a fresh one, sign again and send. Otherwise fix what the program logs show.",
  },
  CHAIN_SOLANA_SIGNATURE_VERIFY_FAILED: {
    code: 3306,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "A signature on the transaction doesn't verify.",
    action: "Sign again with the right keys.",
  },
  CHAIN_SOLANA_EXCLUDED_FROM_INDEX: {
    code: 3307,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "This provider's node doesn't index this account, so it can't run this query.",
    action: "No action on your side.",
  },
  CHAIN_SOLANA_SIGNATURE_LENGTH_MISMATCH: {
    code: 3308,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The transaction has a different number of signatures than its signers require, for example an extra one.",
    action: "Sign with exactly the required signers, then send again.",
  },
  CHAIN_SOLANA_BLOCK_STATUS_UNAVAILABLE: {
    code: 3309,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider doesn't have this block's status yet.",
    action: "Retry shortly.",
  },
  CHAIN_SOLANA_TX_VERSION_UNSUPPORTED: {
    code: 3310,
    source: "request",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The answer contains a newer transaction version, and the request didn't say it can read it.",
    action: "Add maxSupportedTransactionVersion to the request.",
  },
  CHAIN_SOLANA_MIN_CONTEXT_SLOT_NOT_REACHED: {
    code: 3311,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider's node hasn't reached the minimum slot the request asked for.",
    action: "Retry shortly.",
  },
  CHAIN_STARKNET_FAILED_TO_RECEIVE_TX: {
    code: 3320,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "The node couldn't take the transaction. The code doesn't say why.",
    action: "Check by hash whether it went through. If it didn't, send it again.",
  },
  CHAIN_STARKNET_CLASS_NOT_FOUND: {
    code: 3321,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "No contract class found with this hash. It may never have been declared, or this provider hasn't reached the block that declared it.",
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
    action: "Nothing. Use the existing class.",
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
    meaning: "The transaction failed while executing.",
    action: "Read the message and fix the transaction.",
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
    meaning: "The account can't cover the max fee.",
    action: "Add funds.",
  },
  CHAIN_STARKNET_VALIDATION_FAILURE: {
    code: 3329,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning: "The account contract rejected the transaction when validating it.",
    action: "Check the signature and the account.",
  },
  CHAIN_STARKNET_CONTRACT_NOT_FOUND: {
    code: 3330,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "No contract found at this address. It may never have been deployed, or this provider hasn't reached the block that deployed it.",
    action: "Check the address. If it was just deployed, retry shortly.",
  },
  CHAIN_STARKNET_BLOCK_NOT_FOUND: {
    code: 3331,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning: "The provider doesn't have this block.",
    action: "Check the block number. If it's new, retry shortly.",
  },
  CHAIN_STARKNET_TX_HASH_NOT_FOUND: {
    code: 3332,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have this transaction. It may still be pending, the hash may be wrong, or it may be older than this provider keeps.",
    action: "Check the hash. If you just sent it, retry shortly.",
  },
  CHAIN_STARKNET_DUPLICATE_TX: {
    code: 3333,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "This transaction is already pending.",
    action: "Nothing. Don't send it again.",
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
    meaning: "The provider's Starknet node hit an unexpected error.",
    action: "Retry later.",
  },
  CHAIN_BITCOIN_VERIFY_ERROR: {
    code: 3341,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The transaction failed Bitcoin's checks, for example missing or already spent inputs.",
    action: "Read the message and fix the transaction.",
  },
  CHAIN_BITCOIN_VERIFY_REJECTED: {
    code: 3342,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The node refused the transaction under its rules. Some are network rules, some (like the minimum fee) are this node's own policy.",
    action: "Read the message, fix the transaction and send again.",
  },
  CHAIN_BITCOIN_ALREADY_IN_CHAIN: {
    code: 3343,
    source: "chain",
    routerRetries: false,
    mayHaveGoneThrough: true,
    meaning: "This transaction is already confirmed.",
    action: "Nothing. It's done.",
  },
  CHAIN_BITCOIN_WALLET_INSUFFICIENT_FUNDS: {
    code: 3344,
    source: "provider",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "That node's wallet can't fund this wallet call. It says nothing about your own balance.",
    action: "Build and sign the transaction yourself, then send it with sendrawtransaction.",
  },
  CHAIN_NEAR_UNKNOWN_BLOCK: {
    code: 3360,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have this block: it doesn't exist yet, or the node already dropped it.",
    action: "Check the block. If it's new, retry shortly.",
  },
  CHAIN_NEAR_UNKNOWN_CHUNK: {
    code: 3361,
    source: "provider",
    routerRetries: true,
    mayHaveGoneThrough: false,
    meaning:
      "The provider doesn't have this chunk. It may not exist, or it may be older than this provider keeps.",
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
    action: "Retry later.",
  },

  // USER_: the request itself (4000-4999).
  USER_PARSE_ERROR: {
    code: 4001,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The provider couldn't parse the request, though the router had read it as valid JSON.",
    action: "Retry. If one request keeps failing, check it for unusual characters.",
  },
  USER_INVALID_REQUEST: {
    code: 4002,
    source: "unclear",
    routerRetries: false,
    mayHaveGoneThrough: false,
    meaning:
      "The provider rejected the request as invalid. On some REST chains (Stellar), a 400 also means the chain refused a transaction.",
    action:
      "Read the provider's message. It says what's wrong, or why the transaction was refused.",
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
    meaning: "The address is invalid: wrong format or checksum.",
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
    meaning: "A hex value in the request is malformed.",
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
