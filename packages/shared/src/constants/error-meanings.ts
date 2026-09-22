/**
 * Plain-words meaning for the error codes the dashboard surfaces — what
 * happened, said the way a colleague would. Codes outside the table fall
 * back to what their layer prefix guarantees, which is still true. Shared so
 * the api's incident analysis and the web's rows say it identically.
 */
const CODE_MEANING: Readonly<Record<string, string>> = {
  NODE_RATE_LIMITED: "the provider refused the request - the plan's request limit was hit",
  NODE_SERVER_ERROR: "the provider's server answered with an internal error (HTTP 5xx)",
  NODE_INTERNAL_ERROR: "the provider's node reported an internal failure while handling the request",
  NODE_BAD_GATEWAY: "a proxy in front of the provider could not reach the node behind it",
  NODE_METHOD_NOT_FOUND: "the provider does not serve the method that was called",
  NODE_METHOD_NOT_SUPPORTED: "the provider knows the method but does not offer it on this plan or node type",
  NODE_METHOD_NOT_ALLOWED: "the provider blocks this method - usually an allow-list on their side",
  NODE_UNAUTHORIZED: "the provider rejected the credentials - wrong or expired API key",
  NODE_SYNCING: "the provider's node is still catching up with the chain and refused to answer",
  NODE_TIMEOUT: "the provider took too long and the router gave up waiting",
  PROTOCOL_CONTEXT_DEADLINE: "the request ran out of time inside the router before any provider answered",
  PROTOCOL_NO_PROVIDERS: "no provider was available to even try this request",
  PROTOCOL_ALL_ENDPOINTS_DISABLED: "every provider on the chain was benched at that moment",
  PROTOCOL_INSUFFICIENT_PROVIDERS: "fewer providers were available than the request's policy requires",
  CHAIN_NONCE_TOO_LOW: "the chain rejected the transaction - the sender reuses or skips nonces",
  CHAIN_NONCE_TOO_HIGH: "the chain rejected the transaction - the sender skipped ahead of its own nonce",
  CHAIN_INSUFFICIENT_FUNDS: "the chain rejected the transaction - the sending account does not have enough funds",
  CHAIN_BLOCK_NOT_FOUND: "the block asked for does not exist on the node that answered - often a pruned or lagging node",
  CHAIN_STATE_PRUNED: "the node no longer keeps the historical state the request needs - an archive node would",
  USER_INVALID_PARAMS: "the request itself was malformed - wrong or missing parameters",
  UNKNOWN_ERROR: "the router could not classify this failure - the raw message is in the logs",
};

const LAYER_MEANING: ReadonlyArray<readonly [prefix: string, meaning: string]> = [
  ["PROTOCOL_", "a router-side step failed before a good answer was obtained"],
  ["NODE_", "the provider answered, and the answer was an error"],
  ["CHAIN_", "the blockchain itself could not satisfy the request"],
  ["USER_", "the request itself was the problem"],
];

/** One plain sentence for a code - exact where known, layer-level otherwise. */
export function errorMeaning(code: string): string {
  const name = code.trim().toUpperCase();
  const exact = CODE_MEANING[name];
  if (exact) return exact;
  const layer = LAYER_MEANING.find(([prefix]) => name.startsWith(prefix));
  return layer ? layer[1] : "an unrecognised code - the reference explains the taxonomy";
}
