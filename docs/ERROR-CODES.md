# Router error codes in plain words

`packages/shared/src/constants/error-codes.ts` holds every error code Smart Router v1.6.0
knows: the 133 codes in its registry (smart-router `protocol/common/error_codes.go`) plus
`UNKNOWN_ERROR`, the code it gives an error no rule matched. Each code carries what the
Errors page needs to say about it.

| Field | What it is |
| --- | --- |
| `source` | Where the error comes from: `request`, `chain`, `provider`, `router` or `unclear` |
| `meaning` | What happened, in one short sentence, stating only what the code proves |
| `action` | What the client can do, or `""` when there is nothing useful for it to do |
| `routerRetries` | The router tries another provider on this error |
| `mayHaveGoneThrough` | A transaction may be on chain despite this error |

`explainRouterError(name)` looks a code up by the name the router writes in its logs
(`NODE_DATA_NOT_HELD`) and returns `null` for a name the table doesn't know, so a screen can
fall back to the raw code. `ERROR_SOURCE_LABELS` is the one word each source is shown as.

## Where it shows

The Errors tab's request list and the Transactions tab draw it
(`apps/web/src/components/metrics/request-breakdown.tsx`). An opened row is a breakdown in
three parts:

| Part | What it holds |
| --- | --- |
| Request | Method, chain, time, duration, request ID (copy, logs), the caller's IDs, size, the requested block and the router's latest block |
| Tries | One line per try at a provider, in order: result, time, the error by name and its source. The router's code and the provider's message are on hover, inline only when the source is undetermined |
| Response | Returned by, status, retries, the meaning, the provider's message and the next step (the code's `action`, left out when it is empty) |

Each error is stated once, on the try it happened on; the Response names it only when the
router answered itself. Orange marks what was returned to the client. A code the table
doesn't know shows its name from the code and no source.

## How a source is decided

| Source | When |
| --- | --- |
| Request | How the request was built or sent: its format, parameters or size, or the app closing the connection. Any provider would answer the same. |
| Chain | The chain's rules or state said no: a nonce, funds, gas, a contract that reverted. Every healthy, up-to-date provider would answer the same. |
| Provider | One provider, or the network path to it: down, slow, busy, behind, a method switched off, data it doesn't keep, access refused. Another provider may answer differently. |
| Router | The router itself failed, or had no provider to send the request to. |
| Undetermined | The code alone doesn't say which side. The provider's message decides. |

**Chain or provider?** Ask whether a second healthy, up-to-date provider would give the same
answer. Yes: chain. Maybe not: provider. The router draws the same line when it decides
whether to retry: it tries another provider on provider answers and never on chain or
request answers.

**"Not found" is tagged provider.** A provider that answers "not found" is saying it doesn't
hold the data. That can be a wrong ID, an account never created, a block not produced yet, or
data older than that provider keeps. The meaning says it in short ("It may not exist yet, or
be older than the provider keeps."), and the tag doesn't guess between them.

## The two tags

- `routerRetries` is the router's own Retryable flag. Transactions are the exception: the
  router sends a write to every provider at once and never sends it again.
- `mayHaveGoneThrough` is the router's MayHaveReachedNode flag (a connection that broke or
  timed out after the request went out, and `UNKNOWN_ERROR`), plus the answers that say the
  transaction is already there or queued: already known, already in chain, duplicate, nonce
  too low, and XRP Ledger results that may still apply in a later ledger. On a transaction the
  screen shows it as a "May already be on chain" tag, so the action doesn't repeat it.

## How the texts are written

The app that sends requests is "the client"; the RPC provider is "the provider". Plain,
common words, no idioms, no em dashes, no narration.

**Meaning: one short sentence a person understands.** It says what happened, not what the
code can't tell, and never lists every possibility. One code serves every chain, so a text
never names one: a chain-specific fact ("on XRP Ledger the refusal may not be final") reads
as wrong on every other chain, and the "May already be on chain" tag already says it.

**Action: only when the client can do something.** Otherwise it is `""` and the "Next step"
row isn't drawn. It is empty for:

- provider failures the router already retries at another provider: timeouts, rate limits,
  server errors, unavailable, refused, reset or closed connections, gateway errors. Telling
  the client to "retry later" adds nothing;
- "no action on your side" and "read the provider's message" (the screen shows the message);
- old Lava-network codes that no longer apply.

An action is a real, specific step: "Check the ID, address or block number.", "Add funds or
lower the amount.", "Raise the fee.", "Get the account's current nonce, sign again and send.",
"Reconnect, and keep the connection active.", "Slow down." (the router's own rate limit).
"Retry shortly" stays only where waiting is the fix and the router can't do it: "If the block
is new, retry shortly." A setup problem (a provider's URL or credentials, a chain with no
provider) has none: one message has to hold for every deployment.

**No duplicates.** A transaction that may be on chain gets the "May already be on chain" tag
from `mayHaveGoneThrough`, so no action ends in "it may have gone through". Where checking
before resending is the step itself (nonce too low, a refusal that may not be final), the
action says "Check the chain before sending again." The action never promises work from us
and never sells a feature.

| Error | Meaning | Action |
| --- | --- | --- |
| `NODE_SERVER_ERROR` | The provider's server failed while handling the request. | (none) |
| `PROTOCOL_CONNECTION_TIMEOUT` | The provider didn't answer in time. | (none) |
| `NODE_DATA_NOT_HELD` | The provider doesn't have this data. It may not exist yet, or be older than the provider keeps. | Check the ID, address or block number. |
| `CHAIN_INSUFFICIENT_FUNDS` | Not enough funds for the amount and the fee. | Add funds or lower the amount. |
| `CHAIN_NONCE_TOO_LOW` | This nonce was already used. | Check the chain before sending again. |

## Coverage

v1.6.0 sends 103 of these codes. Nine more are only written by the per-request log line that
came after v1.6.0 (`relay_end`, smart-router `docs/RELAY-END-EVENT.md`). The other 22 are never
sent, mostly leftovers from the Lava network's session protocol. They keep a row so that an
unexpected one still gets a line.

## Open for R&D

1. **Seven codes are tagged provider, but the router doesn't retry them:**
   `CHAIN_MEMPOOL_FULL`, `CHAIN_ACCOUNT_NOT_FOUND`, `CHAIN_SOLANA_MISSING_LONG_TERM`,
   `CHAIN_SOLANA_EXCLUDED_FROM_INDEX`, `CHAIN_STARKNET_CLASS_NOT_FOUND`,
   `CHAIN_STARKNET_CONTRACT_NOT_FOUND`, `CHAIN_BITCOIN_WALLET_INSUFFICIENT_FUNDS`. Each is an
   answer another provider could give differently. Confirm the tag, or the retry.
2. **`NODE_ENDPOINT_NOT_FOUND` is also the router's own refusal.** When a REST path isn't in the
   router's spec for the chain, the router answers 501 itself and logs this provider code
   (`CreateRestMethodNotFoundError`, `protocol/common/return_errors.go`). The code is tagged
   unclear until the router gives its own refusal a router code.
3. **Catch-alls stay unclear.** `NODE_SERVER_ERROR` (JSON-RPC -32000 with a message no rule
   knows), `UNKNOWN_ERROR`, and `USER_INVALID_REQUEST` (a REST 400, which some chains also use to
   refuse a transaction) can't name a side. A rule on the provider's message would split the
   common ones, for example a provider answering "pending state is not supported".

## When the router adds or changes a code

Add or change its row in `error-codes.ts`. The tests check that every name sits in its
prefix's number range, that every row has a source and a meaning (and any action) written as
full sentences, that a meaning is two short sentences at most, that an action is empty rather
than "no action" or "read the message", that no action repeats the may-have-gone-through
warning, and how many codes there are, so the count in
`packages/shared/src/__tests__/error-codes.test.ts` changes with it, on purpose.
