import { describe, expect, it } from "vitest";
import { WRITE_UNKNOWN_NOTE, type RouterTopology } from "@sr/shared";
import { buildErrorRows, ErrorRequestsService } from "../services/error-requests.js";
import { buildTxRows, NOTE, summarize, TransactionsService } from "../services/transactions.js";
import { attemptsOf, methodOf, retried } from "../services/relay-end.js";
import { CANCELLED_NOTE, LOOKUP_ID, METHOD_REDACTED, ownRow, parseRouterLine, UpstreamIndex, type RouterLine } from "../services/router-log.js";
import type { LokiClient, LokiLine } from "../services/loki-client.js";
import type { ConfigurationService } from "../services/configuration.js";

/* relay_end lines as smart-router #543 writes them: its goldens
   (protocol/rpcsmartrouter/testdata/relay_end/, 76e60737), with the times,
   ports and GUIDs a run fills in written out. `at` is when Loki holds the line:
   the relay's end. */
const ev = (at: number, fields: Record<string, unknown>): LokiLine => ({
  tsMs: at,
  line: JSON.stringify({ level: "info", event: "relay_end", schema: 1, stateful: false, api_interface: "jsonrpc", is_batch: false, error: "", error_code: "", ...fields, message: "relay_end" }),
});
const REFUSED = 'http request failed: Post "http://node-a.example:8545": dial tcp 10.0.0.1:8545: connect: connection refused: Provider connection refused';
const NONCE = "nonce too low: next nonce 7, tx nonce 6";

// A read node-a refused at the socket; node-b answered on the retry.
const READ_RECOVERED = ev(10_120, {
  GUID: "7387963", method: "eth_getBalance", chain: "ETH1", selection: "stateless", outcome: "ok", stop_reason: "Success", served_by: "node-b", status: 200, has_reply: true, latency_ms: 120,
  attempts: [
    { upstream: "node-a", outcome: "transport_error", error_code: "PROTOCOL_CONNECTION_REFUSED", message: REFUSED, retryable: true, batch: 0, sent_ms: 1, latency_ms: 3, returned_to_client: false },
    { upstream: "node-b", outcome: "ok", error_code: "", message: "", batch: 1, sent_ms: 5, latency_ms: 110, returned_to_client: true },
  ],
});
// The only upstream refused at the socket: nothing came back.
const NO_ANSWER = ev(20_050, {
  GUID: "7846121", method: "eth_getBalance", chain: "ETH1", selection: "stateless", outcome: "no_answer", stop_reason: "AllProvidersExhausted", served_by: "", status: 0, has_reply: false, latency_ms: 50,
  error_code: "PROTOCOL_CONNECTION_REFUSED", error: `failed relay, insufficient results ErrMsg: ${REFUSED} {GUID:7846121}`,
  attempts: [{ upstream: "node-a", outcome: "transport_error", error_code: "PROTOCOL_CONNECTION_REFUSED", message: REFUSED, retryable: true, batch: 0, sent_ms: 1, latency_ms: 4, returned_to_client: false }],
});
const READ_NODE_ERROR = ev(30_040, {
  GUID: "7285711", method: "eth_getBalance", chain: "ETH1", selection: "stateless", outcome: "node_error", stop_reason: "NonRetryableNodeError", served_by: "node-a", status: 200, has_reply: true, latency_ms: 40,
  error_code: "CHAIN_EXECUTION_REVERTED", error: "execution reverted",
  attempts: [{ upstream: "node-a", outcome: "node_error", error_code: "CHAIN_EXECUTION_REVERTED", message: "execution reverted", retryable: false, batch: 0, sent_ms: 1, latency_ms: 38, returned_to_client: true }],
});
const READ_OK = ev(40_012, { GUID: "7720424", method: "eth_getBalance", chain: "ETH1", selection: "stateless", outcome: "ok", stop_reason: "Success", served_by: "node-a", status: 200, has_reply: true, latency_ms: 12 });
// node-a lagged 50 blocks; with no one else left it was sent anyway.
const STALE_FALLBACK = ev(50_030, {
  GUID: "7027674", method: "eth_getBalance", chain: "ETH1", selection: "stateless", outcome: "ok", stop_reason: "Success", served_by: "node-a", status: 200, has_reply: true, latency_ms: 30,
  skipped: [{ upstream: "node-a", lag: 50, threshold: 10, batch: 0 }],
  attempts: [{ upstream: "node-a", outcome: "ok", error_code: "", message: "", batch: 1, sent_ms: 2, latency_ms: 27, stale_fallback: true, returned_to_client: true }],
});
const UNPARSABLE = ev(60_001, { GUID: "7440920", method: "", chain: "ETH1", selection: "", outcome: "rejected_before_dispatch", stop_reason: "", served_by: "", status: 0, has_reply: false, latency_ms: 1, error: "unexpected end of JSON input", attempts: [] });
const SUBSCRIBE_NOWHERE = ev(61_001, {
  GUID: "8001", connection: "8000", method: "eth_subscribe", chain: "ETH1", selection: "subscription", outcome: "rejected_before_dispatch", stop_reason: "", served_by: "", status: 0, has_reply: false, latency_ms: 1,
  error: "WebSocket subscriptions not available: no ws:// or wss:// endpoints configured for chain ETH1", attempts: [],
});

// Writes.
const WRITE_AFTER_A_REJECTION = ev(70_310, {
  GUID: "7143197", stateful: true, method: "eth_sendRawTransaction", chain: "ETH1", selection: "stateful", outcome: "ok", stop_reason: "Success", served_by: "node-b", status: 200, has_reply: true, latency_ms: 310,
  attempts: [
    { upstream: "node-a", outcome: "node_error", error_code: "CHAIN_NONCE_TOO_LOW", message: NONCE, retryable: false, batch: 0, sent_ms: 1, latency_ms: 2, returned_to_client: false },
    { upstream: "node-b", outcome: "ok", error_code: "", message: "", batch: 0, sent_ms: 1, latency_ms: 304, returned_to_client: true },
  ],
});
const WRITE_NODE_ERROR = ev(71_005, {
  GUID: "7481116", stateful: true, method: "eth_sendRawTransaction", chain: "ETH1", selection: "stateful", outcome: "node_error", stop_reason: "Stateful", served_by: "node-a", status: 200, has_reply: true, latency_ms: 5,
  error_code: "CHAIN_NONCE_TOO_LOW", error: NONCE,
  attempts: [
    { upstream: "node-a", outcome: "node_error", error_code: "CHAIN_NONCE_TOO_LOW", message: NONCE, retryable: false, batch: 0, sent_ms: 1, latency_ms: 2, returned_to_client: true },
    { upstream: "node-b", outcome: "node_error", error_code: "CHAIN_NONCE_TOO_LOW", message: NONCE, retryable: false, batch: 0, sent_ms: 1, latency_ms: 3, returned_to_client: false },
  ],
});
const UNCLEAR = "transaction status unclear: timeout reached before any node responded; the transaction may already have been submitted — verify on-chain before resubmitting";
const WRITE_UNKNOWN = ev(72_500, {
  GUID: "7043733", stateful: true, method: "eth_sendRawTransaction", chain: "ETH1", selection: "stateful", outcome: "write_unknown", stop_reason: "ProcessingTimeout", served_by: "", status: 500, has_reply: false, latency_ms: 500,
  error_code: "PROTOCOL_CONTEXT_DEADLINE", error: UNCLEAR,
  attempts: [
    { upstream: "node-a", outcome: "node_error", error_code: "CHAIN_NONCE_TOO_LOW", message: NONCE, retryable: false, batch: 0, sent_ms: 1, latency_ms: 2, returned_to_client: false },
    { upstream: "node-b", outcome: "timeout", error_code: "", message: "", batch: 0, sent_ms: 1, returned_to_client: false },
  ],
});
const TENDERMINT_REFUSED = ev(73_030, {
  GUID: "7965367", stateful: true, api_interface: "tendermintrpc", method: "broadcast_tx_sync", chain: "LAVA", selection: "stateful", outcome: "ok", stop_reason: "Success", served_by: "node-a", status: 200, has_reply: true, latency_ms: 30,
  tx_code: 5, tx_codespace: "sdk", tx_log: "insufficient funds: 10ulava is smaller than 20ulava",
  attempts: [{ upstream: "node-a", outcome: "ok", error_code: "", message: "", batch: 0, sent_ms: 1, latency_ms: 28, returned_to_client: true }],
});
const REST_WRITE = ev(74_020, {
  GUID: "7100", stateful: true, api_interface: "rest", method: "cosmos/tx/v1beta1/txs", chain: "COSMOSHUB", selection: "stateful", outcome: "ok", stop_reason: "Success", served_by: "node-a", status: 200, has_reply: true, latency_ms: 20, tx_code: 0,
  attempts: [{ upstream: "node-a", outcome: "ok", error_code: "", message: "", batch: 0, sent_ms: 1, latency_ms: 18, returned_to_client: true }],
});
const SUBMIT_AND_WATCH = ev(75_010, {
  GUID: "8101", connection: "8100", stateful: true, method: "author_submitAndWatchExtrinsic", chain: "SUBTEST", selection: "subscription", outcome: "ok", stop_reason: "", served_by: "node-ws", status: 0, has_reply: true, latency_ms: 10,
  attempts: [{ upstream: "node-ws", outcome: "ok", error_code: "", message: "", batch: 0, sent_ms: 1, latency_ms: 9, returned_to_client: true }],
});
// Not goldens: shapes the contract defines that no golden covers.
const SUBMIT_REFUSED = ev(76_010, {
  GUID: "8201", connection: "8200", stateful: true, method: "author_submitAndWatchExtrinsic", chain: "SUBTEST", selection: "subscription", outcome: "no_answer", stop_reason: "", served_by: "", status: 0, has_reply: false, latency_ms: 10,
  error: "failed to subscribe", attempts: [{ upstream: "node-ws", outcome: "node_error", error_code: "NODE_INVALID_TRANSACTION", message: "Invalid Transaction: Transaction is outdated", retryable: false, batch: 0, sent_ms: 1, latency_ms: 8, returned_to_client: false }],
});
const GRPC_WRITE = ev(77_020, {
  GUID: "8301", stateful: true, api_interface: "grpc", method: "cosmos.tx.v1beta1.Service/BroadcastTx", chain: "COSMOSHUB", selection: "stateful", outcome: "ok", stop_reason: "Success", served_by: "node-a", status: 200, has_reply: true, latency_ms: 20,
  attempts: [{ upstream: "node-a", outcome: "ok", error_code: "", message: "", batch: 0, sent_ms: 1, latency_ms: 18, returned_to_client: true }],
});
const UNLISTED_TX = ev(78_010, { GUID: "8401", method: "Default-eth_sendRawTransaction", chain: "HYPERLIQUID", selection: "stateless", outcome: "ok", stop_reason: "Success", served_by: "node-a", status: 200, has_reply: true, latency_ms: 10 });
const BATCHED_TX = ev(79_010, { GUID: "8501", is_batch: true, method: "eth_chainId&eth_sendRawTransaction", chain: "ETH1", selection: "stateless", outcome: "ok", stop_reason: "Success", served_by: "node-a", status: 200, has_reply: true, latency_ms: 10 });
const TX_NO_PROVIDERS = ev(80_002, {
  GUID: "8601", stateful: true, method: "eth_sendRawTransaction", chain: "ETH1", selection: "stateful", outcome: "rejected_before_dispatch", stop_reason: "AllProvidersExhausted", served_by: "", status: 0, has_reply: false, latency_ms: 2,
  error_code: "PROTOCOL_NO_PROVIDERS", error: "No pairings available.", attempts: [],
});

const parse = (ls: LokiLine[]) => ls.map(parseRouterLine).filter((l): l is RouterLine => l !== null);
const one = (l: LokiLine) => parse([l])[0]!;
const node = (name: string) => ({ name, endpoints: [{ interface: "jsonrpc" }] });
const ROUTERS = [
  { id: "eth", spec: "ETH1", nodes: [node("node-a"), node("node-b")] },
  { id: "lava", spec: "LAVA", nodes: [node("node-a")] },
] as unknown as RouterTopology[];
const index = new UpstreamIndex(ROUTERS);
const errorRows = (ls: LokiLine[], every = false) => buildErrorRows(parse(ls), index, every);
const txRows = (ls: LokiLine[]) => buildTxRows(parse(ls), index);

describe("a relay_end's tries", () => {
  it("in dispatch order, with the router's code, verdict and words, timed from the relay's start", () => {
    expect(attemptsOf(one(READ_RECOVERED))).toEqual([
      { upstream: "node-a", batch: 0, outcome: "failed", replied: false, code: "PROTOCOL_CONNECTION_REFUSED", retryable: true, message: 'http request failed: Post "http://node-a.example:8545": dial tcp 10.0.0.1:8545: connect: connection refused: Provider connection refused', note: null, atMs: 1, endMs: 4 },
      { upstream: "node-b", batch: 1, outcome: "ok", replied: true, code: null, retryable: null, message: null, note: null, atMs: 5, endMs: 115 },
    ]);
    expect(retried(one(READ_RECOVERED))).toBe(true);
  });

  it("an upstream passed over for lag, then sent to anyway: both, each with the router's reason", () => {
    const behind = "50 blocks behind the chain head (up to 10 allowed)";
    expect(attemptsOf(one(STALE_FALLBACK))).toEqual([
      { upstream: "node-a", batch: 0, outcome: "skipped", replied: false, code: null, retryable: null, message: null, note: `Skipped: ${behind}.`, atMs: 2, endMs: null },
      { upstream: "node-a", batch: 1, outcome: "ok", replied: true, code: null, retryable: null, message: null, note: `Sent as a fallback, no other upstream available: ${behind}.`, atMs: 2, endMs: 29 },
    ]);
    // A batch the consistency check emptied went nowhere: one batch sent, no retry.
    expect(retried(one(STALE_FALLBACK))).toBe(false);
  });

  it("a try still out when the relay ended has no result; one the router called off is cancelled - neither is a failure", () => {
    expect(attemptsOf(one(WRITE_UNKNOWN)).map((a) => [a.upstream, a.outcome, a.code, a.endMs])).toEqual([
      ["node-a", "failed", "CHAIN_NONCE_TOO_LOW", 3],
      ["node-b", "no-result", null, null],
    ]);
    const hedged = ev(1, { GUID: "1", attempts: [{ upstream: "x", outcome: "cancelled", error_code: "", message: "", batch: 0, sent_ms: 0, returned_to_client: false }] });
    expect(attemptsOf(one(hedged))[0]).toMatchObject({ outcome: "cancelled", note: CANCELLED_NOTE });
    const timedOut = ev(1, { GUID: "1", attempts: [{ upstream: "x", outcome: "timeout", error_code: "PROTOCOL_CONTEXT_DEADLINE", message: "context deadline exceeded", batch: 0, sent_ms: 0, latency_ms: 30_000, returned_to_client: false }] });
    expect(attemptsOf(one(timedOut))[0]).toMatchObject({ outcome: "failed", code: "PROTOCOL_CONTEXT_DEADLINE" });
    // Cancelled as the budget ran out: the router stopped waiting, as on the old lines.
    const cancelledLate = ev(1, { GUID: "1", attempts: [{ upstream: "x", outcome: "timeout", error_code: "PROTOCOL_CONTEXT_CANCELED", message: "context canceled", batch: 0, sent_ms: 0, returned_to_client: false }] });
    expect(attemptsOf(one(cancelledLate))[0]).toMatchObject({ outcome: "cancelled", note: CANCELLED_NOTE });
  });

  it("a read its first try answered lists no tries: its one try is the upstream that served it", () => {
    expect(attemptsOf(one(READ_OK))).toEqual([
      { upstream: "node-a", batch: 0, outcome: "ok", replied: true, code: null, retryable: null, message: null, note: null, atMs: 0, endMs: null },
    ]);
    expect(attemptsOf(one(UNPARSABLE))).toEqual([]); // nothing went out
  });

  it("a cache hit was never sent: no batch of its own, no times", () => {
    const cached = ev(1, { GUID: "7201", attempts: [{ upstream: "Cached", outcome: "node_error", error_code: "NODE_SERVER_ERROR", message: "header not found", retryable: true, returned_to_client: true }] });
    expect(attemptsOf(one(cached))).toEqual([
      { upstream: "Cached", batch: 0, outcome: "failed", replied: true, code: "NODE_SERVER_ERROR", retryable: true, message: "header not found", note: null, atMs: 0, endMs: null },
    ]);
  });

  it("an upstream URL in a try's words keeps only its scheme and host", () => {
    const keyed = ev(1, { GUID: "1", attempts: [{ upstream: "x", outcome: "transport_error", error_code: "PROTOCOL_CONNECTION_TIMEOUT", message: 'Post "https://eth.example.com/v2/SECRETKEY": timeout', batch: 0, sent_ms: 0, returned_to_client: false }] });
    expect(attemptsOf(one(keyed))[0]?.message).toBe('Post "https://eth.example.com": timeout');
  });
});

describe("a relay_end's method", () => {
  const of = (method: string, api_interface = "jsonrpc") => methodOf(one(ev(1, { GUID: "1", method, api_interface })));
  it("as the client named it; unlisted, it keeps its name, unless the router withheld it as a URL", () => {
    expect(of("eth_call")).toBe("eth_call");
    expect(of("Default-eth_foo")).toBe("eth_foo");
    expect(of("Default-REDACTED", "rest")).toBe(METHOD_REDACTED);
  });
  it("a REST api is its path; a request that didn't parse names none", () => {
    expect(of("cosmos/tx/v1beta1/txs", "rest")).toBe("/cosmos/tx/v1beta1/txs");
    expect(of("/", "rest")).toBe("/");
    expect(of("")).toBe("unknown");
  });
});

describe("the Errors tab from relay_end", () => {
  it("a recovered read: when the router took it, its chain, both tries, the retry", () => {
    expect(errorRows([READ_RECOVERED])).toEqual([{
      guid: "7387963",
      time: 10_000, // the event's time, less its latency
      spec: "ETH1",
      method: "eth_getBalance",
      attempts: attemptsOf(one(READ_RECOVERED)),
      result: "recovered",
      resolvedBy: "node-b",
      retried: true,
      stopReason: "Success",
      exhausted: false,
      totalMs: 120,
      error: null,
      errorCode: null,
    }]);
  });

  it("nothing came back: failed, with the router's error less its GUID", () => {
    expect(errorRows([NO_ANSWER])[0]).toMatchObject({
      result: "failed", resolvedBy: null, exhausted: true, totalMs: 50,
      error: 'failed relay, insufficient results ErrMsg: http request failed: Post "http://node-a.example:8545": dial tcp 10.0.0.1:8545: connect: connection refused: Provider connection refused',
    });
  });

  it("a node's error passed through is the reply the app got; a read that went fine is not a row, except looked up", () => {
    expect(errorRows([READ_NODE_ERROR])[0]).toMatchObject({ result: "error-reply", resolvedBy: "node-a", stopReason: "NonRetryableNodeError" });
    expect(errorRows([READ_OK])).toEqual([]);
    expect(errorRows([READ_OK], true)[0]).toMatchObject({ result: "ok", attempts: [{ upstream: "node-a", outcome: "ok" }], totalMs: 12 });
  });

  it("a write the router can't settle is its own result - the Transactions tab's unknown - with the words the client got", () => {
    expect(errorRows([WRITE_UNKNOWN])[0]).toMatchObject({
      guid: "7043733", result: "write-unknown", resolvedBy: null, stopReason: "ProcessingTimeout",
      error: UNCLEAR, errorCode: "PROTOCOL_CONTEXT_DEADLINE",
    });
    // Both tabs explain it with the same words.
    expect(NOTE.writeUnknown).toBe(WRITE_UNKNOWN_NOTE);
  });

  it("the request's own error code, beside its tries' - what the error type filter also matches", () => {
    const timedOut = ev(72_600, {
      GUID: "7043734", stateful: true, method: "eth_sendRawTransaction", chain: "ETH1", selection: "stateful", outcome: "write_unknown", stop_reason: "ProcessingTimeout", served_by: "", status: 500, has_reply: false, latency_ms: 30_000,
      error_code: "NODE_GATEWAY_TIMEOUT", error: UNCLEAR,
      attempts: [{ upstream: "node-a", outcome: "timeout", error_code: "", message: "", batch: 0, sent_ms: 1, returned_to_client: false }],
    });
    // No try failed - the one still out has no result - yet the request is listed, by its own code.
    expect(errorRows([timedOut])[0]).toMatchObject({ result: "write-unknown", errorCode: "NODE_GATEWAY_TIMEOUT", attempts: [{ outcome: "no-result", code: null }] });
    expect(errorRows([NO_ANSWER])[0]?.errorCode).toBe("PROTOCOL_CONNECTION_REFUSED");
    expect(errorRows([READ_NODE_ERROR])[0]?.errorCode).toBe("CHAIN_EXECUTION_REVERTED");
    expect(errorRows([READ_RECOVERED])[0]?.errorCode).toBeNull(); // ended ok
  });

  it("a request the router couldn't parse, and a subscription request, are not on the list - as the alert counts neither", () => {
    expect(errorRows([UNPARSABLE, SUBSCRIBE_NOWHERE])).toEqual([]);
    expect(errorRows([UNPARSABLE], true)[0]).toMatchObject({ result: "failed", method: "unknown", error: "unexpected end of JSON input" });
  });

  it("a hedge nothing failed in is not on the list, at any log level - looked up, it says it went out twice", () => {
    const hedged = ev(1_200, {
      GUID: "9100", method: "eth_call", chain: "ETH1", selection: "stateless", outcome: "ok", stop_reason: "Success", served_by: "node-b", status: 200, has_reply: true, latency_ms: 200,
      attempts: [
        { upstream: "node-a", outcome: "cancelled", error_code: "", message: "", batch: 0, sent_ms: 1, returned_to_client: false },
        { upstream: "node-b", outcome: "ok", error_code: "", message: "", batch: 1, sent_ms: 150, latency_ms: 40, returned_to_client: true },
      ],
    });
    const decided = { tsMs: 1_150, line: JSON.stringify({ GUID: "9100", action: "retry", reason: "Default", batchNumber: "1", message: "[StateMachine] policy.Decide" }) };
    expect(errorRows([hedged])).toEqual([]);
    expect(errorRows([decided, hedged])).toEqual([]); // its DEBUG line changes nothing
    expect(errorRows([hedged], true)[0]).toMatchObject({ result: "ok", retried: true });
  });

  it("a request with a relay_end is read from it, whatever narrative lines it also wrote", () => {
    const narrative = { tsMs: 10_002, line: JSON.stringify({ GUID: "7387963", provider: "node-a", error: "connection refused", error_name: "PROTOCOL_CONNECTION_REFUSED", message: "could not send relay to provider" }) };
    expect(errorRows([narrative, READ_RECOVERED])).toEqual(errorRows([READ_RECOVERED]));
  });

  it("old lines and relay_end side by side - a window across an upgrade - each request once", () => {
    const old = [
      { tsMs: 1000, line: JSON.stringify({ GUID: "303", path: "/", body: '{"method":"eth_blockNumber"}', message: "Consumer received a new JSON-RPC request" }) },
      { tsMs: 1001, line: JSON.stringify({ GUID: "303", chosenProviders: "node-a", stateful: "0", message: "Choosing providers" }) },
      { tsMs: 1500, line: JSON.stringify({ GUID: "303", endpoint: "node-a", error: "connection refused", message: "direct RPC relay failed in goroutine" }) },
      { tsMs: 1501, line: JSON.stringify({ GUID: "303", endpoint: "ETH1jsonrpc", error: "failed relay, insufficient results", message: "failed getting responses from RPC endpoints" }) },
    ];
    expect(errorRows([...old, NO_ANSWER, READ_RECOVERED]).map((r) => [r.guid, r.result])).toEqual([
      ["7846121", "failed"], ["7387963", "recovered"], ["303", "failed"],
    ]);
  });
});

describe("a relay_end row under a config router", () => {
  const two = [
    { id: "eth-a", spec: "ETH1", nodes: [node("node-a")] },
    { id: "eth-b", spec: "ETH1", nodes: [node("node-b")] },
  ] as unknown as RouterTopology[];
  const cached = ev(1, {
    GUID: "7201", method: "eth_getBlockByNumber", chain: "ETH1", selection: "stateless", outcome: "node_error", stop_reason: "ErrorToleranceExceeded", served_by: "Cached", status: 200, has_reply: true, latency_ms: 1,
    error_code: "NODE_SERVER_ERROR", error: "header not found",
    attempts: [{ upstream: "Cached", outcome: "node_error", error_code: "NODE_SERVER_ERROR", message: "header not found", retryable: true, returned_to_client: true }],
  });

  it("the cache answered: its router's when it is alone on the chain, no one's when the chain is shared", () => {
    const [row] = errorRows([cached]);
    expect(ownRow(row!, ROUTERS[0]!, ROUTERS)).toBe(true);
    expect(ownRow(row!, two[0]!, two)).toBe(false);
  });

  it("a transaction by name whose first try answered belongs to the router whose upstream served it", () => {
    const sentByB = ev(1, { GUID: "8402", method: "eth_sendTransaction", chain: "ETH1", selection: "stateless", outcome: "ok", stop_reason: "Success", served_by: "node-b", status: 200, has_reply: true, latency_ms: 10 });
    const [row] = txRows([sentByB]);
    expect(row?.attempts.map((a) => [a.upstream, a.outcome, a.replied])).toEqual([["node-b", "ok", true]]);
    expect([ownRow(row!, two[0]!, two), ownRow(row!, two[1]!, two)]).toEqual([false, true]);
  });
});

describe("the Transactions tab from relay_end", () => {
  const tx = (l: LokiLine) => txRows([l])[0];

  it("accepted by the upstream that answered, whatever another one said", () => {
    expect(tx(WRITE_AFTER_A_REJECTION)).toEqual({
      guid: "7143197",
      time: 70_000,
      spec: "ETH1",
      method: "eth_sendRawTransaction",
      attempts: attemptsOf(one(WRITE_AFTER_A_REJECTION)),
      answeredBy: "node-b",
      replyMs: 310,
      outcome: "accepted",
      error: null,
      note: null,
    });
  });

  it("rejected, with the node's code and words; failed, with the router's", () => {
    expect(tx(WRITE_NODE_ERROR)).toMatchObject({ outcome: "rejected", answeredBy: "node-a", error: { code: "CHAIN_NONCE_TOO_LOW", message: NONCE } });
    expect(tx(TX_NO_PROVIDERS)).toMatchObject({ outcome: "failed", attempts: [], error: { code: "PROTOCOL_NO_PROVIDERS", message: "No pairings available." } });
  });

  it("a write the router can't settle is unknown, in its own words", () => {
    expect(tx(WRITE_UNKNOWN)).toMatchObject({ outcome: "unknown", note: NOTE.writeUnknown, error: null, answeredBy: null });
  });

  it("a Cosmos node's refusal inside a normal reply: rejected, by the code the router read out of it", () => {
    const row = tx(TENDERMINT_REFUSED);
    expect(row).toMatchObject({ spec: "LAVA", method: "broadcast_tx_sync", outcome: "rejected", error: { code: "sdk:5", message: "insufficient funds: 10ulava is smaller than 20ulava" } });
    expect(row?.attempts[0]).toMatchObject({ outcome: "failed", replied: true, code: "sdk:5" });
    expect(tx(REST_WRITE)).toMatchObject({ method: "/cosmos/tx/v1beta1/txs", outcome: "accepted", note: null });
  });

  it("over gRPC the router reads no code out of the reply: unknown, and the reply isn't a ✓", () => {
    const row = tx(GRPC_WRITE);
    expect(row).toMatchObject({ outcome: "unknown", note: NOTE.replyNotLogged });
    expect(row?.attempts[0]).toMatchObject({ outcome: "no-result", replied: true });
  });

  it("a transaction submitted over a subscription: accepted, or rejected by the node's refusal on its try", () => {
    expect(tx(SUBMIT_AND_WATCH)).toMatchObject({ spec: "SUBTEST", method: "author_submitAndWatchExtrinsic", outcome: "accepted", answeredBy: "node-ws" });
    expect(tx(SUBMIT_REFUSED)).toMatchObject({ outcome: "rejected", error: { code: "NODE_INVALID_TRANSACTION", message: "Invalid Transaction: Transaction is outdated" } });
  });

  it("a transaction method by name is one too: unlisted, or inside a batch; a read is not", () => {
    expect(txRows([UNLISTED_TX, BATCHED_TX, READ_OK]).map((r) => [r.guid, r.method])).toEqual([
      ["8501", "eth_chainId&eth_sendRawTransaction"], ["8401", "eth_sendRawTransaction"],
    ]);
  });
});

/** A Loki that applies a query's line filters, in order, to the lines it holds. */
const lokiOf = (lines: LokiLine[]) => {
  const queries: string[] = [];
  const loki = {
    async volume() { return 0; },
    async queryRange(query: string, startMs: number, endMs: number, limit: number) {
      queries.push(query);
      const filters = [...query.matchAll(/(\|~|!~|\|=|!=) (`[^`]*`|"(?:[^"\\]|\\.)*")/g)].map(([, op, q]) => {
        const text = q!.startsWith("`") ? q!.slice(1, -1) : (JSON.parse(q!) as string);
        return { op, text, re: op === "|~" || op === "!~" ? new RegExp(text) : null };
      });
      // `| json … | method!="" or selection!=""`: a line that parses, of a request the router parsed.
      const parsedOnly = query.includes('| method!="" or selection!=""');
      const parses = (line: string) => {
        try {
          const f = JSON.parse(line) as { method?: string; selection?: string };
          return Boolean(f.method || f.selection);
        } catch {
          return false;
        }
      };
      const keep = (line: string) =>
        filters.every((f) => (f.op === "|=" ? line.includes(f.text) : f.op === "!=" ? !line.includes(f.text) : f.op === "|~" ? f.re!.test(line) : !f.re!.test(line))) &&
        (!parsedOnly || parses(line));
      return lines.filter((l) => l.tsMs >= startMs && l.tsMs < endMs && keep(l.line)).sort((a, b) => b.tsMs - a.tsMs).slice(0, limit);
    },
    async count(query: string) {
      queries.push(query);
      return 0;
    },
  } as unknown as LokiClient;
  return { loki, queries };
};
const SEL = '{component="router"}';
const cfg = { getRouters: () => ROUTERS } as unknown as ConfigurationService;
const RANGE = { startMs: 0, endMs: 100_000 };

describe("ErrorRequestsService on a router that writes relay_end", () => {
  const LINES = [READ_RECOVERED, NO_ANSWER, READ_NODE_ERROR, READ_OK, STALE_FALLBACK, UNPARSABLE, SUBSCRIBE_NOWHERE];

  it("finds a request by its relay_end and needs no second read for it", async () => {
    const { loki, queries } = lokiOf(LINES);
    const r = await new ErrorRequestsService(loki, SEL, cfg).report(RANGE);
    expect(queries[1]).toBe(
      `${SEL} |= \`"event":"relay_end"\` != \`"selection":"subscription"\` |~ \`"outcome":"(no_answer|write_unknown|rejected_before_dispatch|router_error|node_error|rate_limited|timeout|transport_error)"\`` +
        ' | json outcome="outcome", method="method", selection="selection" | __error__="" | method!="" or selection!=""',
    );
    expect(queries).toHaveLength(2); // nothing found by narrative lines, so no follow-up read
    expect(r.rows.map((x) => [x.guid, x.result])).toEqual([["7285711", "error-reply"], ["7846121", "failed"], ["7387963", "recovered"]]);
  });

  it("a request found by its narrative lines is read back with its relay_end", async () => {
    const narrative = { tsMs: 10_002, line: JSON.stringify({ GUID: "7387963", provider: "node-a", error: "connection refused", error_name: "PROTOCOL_CONNECTION_REFUSED", message: "could not send relay to provider" }) };
    // Only the narrative line is in the range the finding reads see; its relay_end lands just after.
    const { loki, queries } = lokiOf([narrative, READ_RECOVERED]);
    const r = await new ErrorRequestsService(loki, SEL, cfg).report({ startMs: 0, endMs: 10_050 });
    expect(queries[2]).toContain('"event":"relay_end"');
    expect(r.rows).toEqual(errorRows([READ_RECOVERED]));
  });

  it("requests the router couldn't parse never take a place on the list - a flood of them hides nothing", async () => {
    const junk = Array.from({ length: 10 }, (_, i) =>
      ev(25_000 + i, { GUID: String(9200 + i), method: "", chain: "ETH1", selection: "", outcome: "rejected_before_dispatch", stop_reason: "", served_by: "", status: 0, has_reply: false, latency_ms: 1, error: "unexpected end of JSON input", attempts: [] }),
    );
    const { loki } = lokiOf([NO_ANSWER, ...junk]);
    const r = await new ErrorRequestsService(loki, SEL, cfg, 5).report(RANGE);
    expect(r).toMatchObject({ more: false, nextBefore: null });
    expect(r.rows.map((x) => x.guid)).toEqual(["7846121"]);
  });

  it("reads relay_end requests newest first, and says where to read on for the older ones", async () => {
    const { loki } = lokiOf(LINES);
    const svc = new ErrorRequestsService(loki, SEL, cfg, 2);
    const first = await svc.report(RANGE);
    expect(first.rows.map((x) => x.guid)).toEqual(["7285711", "7846121"]);
    expect(first).toMatchObject({ more: true });
    // Each read ends just past the oldest event it held, which comes back on
    // the seam; the list keeps it once. Nothing between two reads is lost.
    const listed = first.rows.map((x) => x.guid);
    let before = first.nextBefore!;
    for (let read = 0; read < 5; read++) {
      const older = await svc.report(RANGE, undefined, undefined, before);
      for (const row of older.rows) if (!listed.includes(row.guid)) listed.push(row.guid);
      if (!older.more) break;
      before = older.nextBefore!;
    }
    expect(listed).toEqual(["7285711", "7846121", "7387963"]);
  });

  it("a chain narrows the relay_end read to the chain it names, an upstream to the tries it names", async () => {
    const { loki, queries } = lokiOf(LINES);
    const svc = new ErrorRequestsService(loki, SEL, cfg);
    await svc.report(RANGE, "ETH1");
    expect(queries[1]).toContain(' |= `"chain":"ETH1"` | json');
    const r = await svc.report(RANGE, undefined, undefined, undefined, "node-a");
    expect(queries.at(-1)).toContain(' |= `"upstream":"node-a"` | json');
    expect(r.rows.map((x) => x.guid)).toEqual(["7285711", "7846121", "7387963"]);
  });

  it("the failed count adds the relay_end leg - the alert's - to the old lines", async () => {
    const { loki, queries } = lokiOf([]);
    await new ErrorRequestsService(loki, SEL, cfg).failedCount("1h", "ETH1");
    expect(queries[0]).toBe(
      "(sum(count_over_time({component=\"router\"} |~ `failed (getting|processing) responses from RPC endpoints` | json msg=\"message\", ep=\"endpoint\" | msg=~`failed (getting|processing) responses from RPC endpoints` | ep=~`ETH1(jsonrpc|rest|tendermintrpc|grpc)` [3600s])) or vector(0))" +
        " + (sum(count_over_time({component=\"router\"} |= `\"chain\":\"ETH1\"` |= `\"event\":\"relay_end\"` |~ `\"outcome\":\"(no_answer|write_unknown|rejected_before_dispatch|router_error)\"`" +
        " | json outcome=\"outcome\", method=\"method\", selection=\"selection\" | __error__=\"\"" +
        " | method!=\"\" or selection!=\"\" | selection!=\"subscription\" | outcome=~`no_answer|write_unknown|rejected_before_dispatch|router_error` [3600s])) or vector(0))",
    );
  });
});

describe("TransactionsService on a router that writes relay_end", () => {
  const LINES = [WRITE_AFTER_A_REJECTION, WRITE_NODE_ERROR, WRITE_UNKNOWN, TENDERMINT_REFUSED, UNLISTED_TX, BATCHED_TX, READ_OK, READ_RECOVERED];

  it("finds writes by the flag and transaction methods by name, and needs no second read for them", async () => {
    const { loki, queries } = lokiOf(LINES);
    const r = await new TransactionsService(loki, SEL, cfg).report(RANGE);
    expect(queries[2]).toBe(
      `${SEL} |= \`"event":"relay_end"\` |~ \`"stateful":true|"method":"([^"]*[&-])?(eth_sendRawTransaction|eth_sendTransaction|sendTransaction|sendrawtransaction|broadcast_tx_sync|broadcast_tx_async|broadcast_tx_commit)[&"]\``,
    );
    expect(queries).toHaveLength(3);
    expect(r).toMatchObject({ available: true, total: 6, accepted: 3, rejected: 2, failed: 0 });
    expect(r.rows.map((x) => x.guid)).toEqual(["8501", "8401", "7965367", "7043733", "7481116", "7143197"]);
  });

  it("a chain, or a config router's chain, narrows the relay_end read to it", async () => {
    const { loki, queries } = lokiOf(LINES);
    const svc = new TransactionsService(loki, SEL, cfg);
    expect((await svc.report(RANGE, "LAVA")).rows.map((x) => x.guid)).toEqual(["7965367"]);
    expect(queries[2]).toMatch(/ \|= `"chain":"LAVA"`$/);
    await svc.report(RANGE, undefined, "eth");
    expect(queries.at(-1)).toMatch(/ \|= `"chain":"ETH1"`$/);
  });

  it("looks a transaction up by its ID from its relay_end", async () => {
    const { loki } = lokiOf(LINES);
    expect(await new TransactionsService(loki, SEL, cfg).lookup("7481116", RANGE)).toMatchObject({ found: true, row: { outcome: "rejected", answeredBy: "node-a" } });
  });
});

/* The fields the router adds to relay_end, schema 1 still: each absent when
   unknown, so an event without them reads as before. Shapes from the field
   list (smart-router's RELAY-END-EVENT.md); not goldens. */
describe("relay_end's caller, hash and on-chain fields", () => {
  const HASH = "0x" + "8f3a91c2".repeat(8);
  const DIGEST = "8kNVrbs2QzMnVuMxQ7f2YtaE9qH1rJ4Z5pW3cX6vB9dL";
  const SENT = ev(90_310, {
    GUID: "9001", stateful: true, method: "eth_sendRawTransaction", chain: "ETH1", selection: "stateful", outcome: "ok", stop_reason: "Success", served_by: "node-b", status: 200, has_reply: true, latency_ms: 310,
    tx_hash: HASH, customer: "demo-acme", request_id: "acme-req-0192", task_id: "settle-77", tx_id: "acme-tx-5521", request_bytes: 412, reply_bytes: 104, seen_block: 21_734_118,
    attempts: [
      { upstream: "node-a", outcome: "node_error", error_code: "CHAIN_NONCE_TOO_LOW", node_code: -32000, message: NONCE, retryable: false, batch: 0, sent_ms: 1, latency_ms: 2, returned_to_client: false },
      { upstream: "node-b", outcome: "ok", error_code: "", message: "", batch: 0, sent_ms: 1, latency_ms: 304, returned_to_client: true },
    ],
  });
  const sui = (guid: string, at: number, more: Record<string, unknown>) => ev(at, {
    GUID: guid, stateful: true, method: "sui_executeTransactionBlock", chain: "SUI", selection: "stateful", outcome: "ok", stop_reason: "Success", served_by: "node-a", status: 200, has_reply: true, latency_ms: 640, tx_hash: DIGEST,
    attempts: [{ upstream: "node-a", outcome: "ok", error_code: "", message: "", batch: 0, sent_ms: 1, latency_ms: 638, returned_to_client: true }],
    ...more,
  });
  const ABORT = "MoveAbort(MoveLocation { module: balance, function: 3 }, 2) in command 0";
  const SUI_FAILED = sui("9002", 91_640, { tx_status: "failure", tx_error: `${ABORT}, at https://fullnode.example.com/v1/SECRETKEY`, customer: "demo-globex" });
  const SUI_OK = sui("9003", 92_640, { tx_status: "success" });
  const READ_FAILED = ev(93_050, {
    GUID: "9004", method: "eth_getBalance", chain: "ETH1", selection: "stateless", outcome: "no_answer", stop_reason: "AllProvidersExhausted", served_by: "", status: 0, has_reply: false, latency_ms: 50,
    error_code: "NODE_SERVER_ERROR", error: "failed relay, insufficient results", customer: "demo-initech", request_bytes: 120, requested_block: 21_734_000, seen_block: 21_734_110,
    attempts: [{ upstream: "node-a", outcome: "node_error", error_code: "NODE_SERVER_ERROR", node_code: -32603, message: "header not found", retryable: true, batch: 0, sent_ms: 1, latency_ms: 4, returned_to_client: false }],
  });
  const FACTS = ["customer", "requestId", "taskId", "txId", "requestBytes", "replyBytes", "requestedBlock", "seenBlock", "txHash", "txStatus", "txError"];

  it("a transaction carries its hash, the caller's project and ids, its sizes, and each try the node's own code", () => {
    const [row] = txRows([SENT]);
    expect(row).toMatchObject({
      outcome: "accepted", txHash: HASH, customer: "demo-acme", requestId: "acme-req-0192", taskId: "settle-77", txId: "acme-tx-5521",
      requestBytes: 412, replyBytes: 104, seenBlock: 21_734_118,
    });
    expect(row).not.toHaveProperty("requestedBlock"); // a send names no block
    expect(row?.attempts.map((a) => [a.upstream, a.nodeCode])).toEqual([["node-a", -32000], ["node-b", undefined]]);
    expect(row?.attempts[1]).not.toHaveProperty("nodeCode");
  });

  it("an event without them reads exactly as before: none of them, on either tab", () => {
    for (const row of [...txRows([WRITE_AFTER_A_REJECTION, WRITE_NODE_ERROR]), ...errorRows([READ_RECOVERED, NO_ANSWER])]) {
      for (const k of FACTS) expect(row).not.toHaveProperty(k);
      for (const a of row.attempts) expect(a).not.toHaveProperty("nodeCode");
    }
  });

  it("the chain ran it and it failed: Failed on chain, in the chain's words with any node url cut; a success stays Accepted", () => {
    expect(txRows([SUI_FAILED])[0]).toMatchObject({
      outcome: "failed-on-chain", txStatus: "failure", txHash: DIGEST, customer: "demo-globex", error: null,
      txError: `${ABORT}, at https://fullnode.example.com`,
    });
    expect(txRows([SUI_OK])[0]).toMatchObject({ outcome: "accepted", txStatus: "success" });
    expect(txRows([SUI_OK])[0]).not.toHaveProperty("txError");
  });

  it("values not in the field's form are left out, never shown as something they aren't", () => {
    const odd = sui("9005", 94_000, { tx_status: "pending", tx_error: "ignored without a failure", customer: 7, request_id: "", request_bytes: -1, reply_bytes: 1.5, seen_block: "21734110", tx_hash: "  " });
    const [row] = txRows([odd]);
    expect(row?.outcome).toBe("accepted");
    for (const k of FACTS) expect(row).not.toHaveProperty(k);
  });

  it("a failure on chain counts as failed: in the totals and against the success rate", () => {
    expect(summarize(txRows([SENT, SUI_FAILED, SUI_OK]))).toEqual({ total: 3, accepted: 2, rejected: 0, failed: 0, failedOnChain: 1, successRate: 2 / 3 });
  });

  it("the Errors tab's rows carry the same facts, and the blocks a read named and the router had", () => {
    expect(errorRows([READ_FAILED])[0]).toMatchObject({
      result: "failed", customer: "demo-initech", requestBytes: 120, requestedBlock: 21_734_000, seenBlock: 21_734_110,
      attempts: [{ upstream: "node-a", code: "NODE_SERVER_ERROR", nodeCode: -32603 }],
    });
  });

  it("finds a transaction by its hash or by the caller's request id, as by its ID", async () => {
    const { loki, queries } = lokiOf([SENT, SUI_FAILED, READ_FAILED, WRITE_NODE_ERROR]);
    const svc = new TransactionsService(loki, SEL, cfg);
    expect(await svc.lookup(HASH, RANGE)).toMatchObject({ found: true, row: { guid: "9001", txHash: HASH } });
    expect(queries.at(-1)).toBe(`${SEL} |= \`${HASH}\` |~ \`"(GUID|tx_hash|request_id)":"${HASH}"\``);
    expect(await svc.lookup("acme-req-0192", RANGE)).toMatchObject({ found: true, row: { guid: "9001" } });
    expect(await svc.lookup(DIGEST, RANGE)).toMatchObject({ row: { guid: "9002", outcome: "failed-on-chain" } });
    expect(await svc.lookup("7481116", RANGE)).toMatchObject({ row: { guid: "7481116" } });
    expect(await new ErrorRequestsService(loki, SEL, cfg).lookup("acme-req-0192", RANGE)).toMatchObject({ row: { guid: "9001", customer: "demo-acme" } });
    // A value that only turns up inside another request's fields - its words,
    // or an object of its own - names nothing: only the event's own fields do.
    const quoted = ev(95_000, { GUID: "9006", method: "eth_call", chain: "ETH1", selection: "stateless", outcome: "node_error", error_code: "CHAIN_EXECUTION_REVERTED", error: `reverted ${HASH}`, served_by: "node-a", status: 200, has_reply: true, latency_ms: 3 });
    const nested = ev(95_100, { GUID: "9007", method: "eth_call", chain: "ETH1", selection: "stateless", outcome: "ok", served_by: "node-a", status: 200, has_reply: true, latency_ms: 3, client: { request_id: "acme-req-0192" } });
    const others = new ErrorRequestsService(lokiOf([quoted, nested]).loki, SEL, cfg);
    expect(await others.lookup(HASH, RANGE)).toEqual({ available: true, row: null });
    expect(await others.lookup("acme-req-0192", RANGE)).toEqual({ available: true, row: null });
  });

  it("a hash several requests carry - the transaction sent again - answers with the newest and how many", async () => {
    const again = ev(96_100, { ...JSON.parse(SENT.line), GUID: "9010", latency_ms: 100 });
    const { loki } = lokiOf([SENT, again]);
    expect(await new TransactionsService(loki, SEL, cfg).lookup(HASH, RANGE)).toMatchObject({ found: true, matches: 2, row: { guid: "9010" } });
    expect(await new ErrorRequestsService(loki, SEL, cfg).lookup(HASH, RANGE)).toMatchObject({ matches: 2, row: { guid: "9010" } });
    expect(await new TransactionsService(lokiOf([SENT]).loki, SEL, cfg).lookup(HASH, RANGE)).not.toHaveProperty("matches");
  });

  it("a look-up takes a hash or a caller's id of up to 128 plain characters, and nothing that could reach into the query", async () => {
    const base58 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYVCJjBRSJ2mWbmJu3pXr8ZqAiBXhBxwMpvz1k7iVNyQFJqU1n2Yb";
    for (const ok of [HASH, base58, DIGEST, "acme-req-0192", "job:42.7@eu+1=a", "x".repeat(128)]) expect(LOOKUP_ID.test(ok)).toBe(true);
    for (const bad of ["x".repeat(129), "a b", "a`b", 'a"b', "a\\b", "a/b", ""]) expect(LOOKUP_ID.test(bad)).toBe(false);
    const { loki, queries } = lokiOf([SENT]);
    expect(await new TransactionsService(loki, SEL, cfg).lookup("a`b", RANGE)).toEqual({ available: true, found: false, row: null });
    expect(queries).toEqual([]);
  });
});
