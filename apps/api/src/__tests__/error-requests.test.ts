import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { buildErrorRows, ErrorRequestsService } from "../services/error-requests.js";
import { readRange } from "../services/read-range.js";
import type { RouterTopology } from "@sr/shared";
import { CANCELLED_NOTE, METHOD_REDACTED, methodOf, onChain, parseRouterLine, scrubUrls, UpstreamIndex, type RouterLine, type UpstreamInfo } from "../services/router-log.js";
import type { LokiClient, LokiLine } from "../services/loki-client.js";
import type { ConfigurationService } from "../services/configuration.js";

/* Router log lines as a live router wrote them (smart-router :main,
   2026-09-27), cut down to the fields the table reads. Real captures unless
   the comment says otherwise. */
const at = (tsMs: number, fields: Record<string, string>): LokiLine => ({ tsMs, line: JSON.stringify(fields) });
const RECEIVED = "Consumer received a new JSON-RPC request";
const DECIDE = "[StateMachine] policy.Decide";
const struct = (name: string, group: string) => `{ProviderAddress:${name} ProviderReputationSummary:0 ProviderStake:0 ProviderGroup:${group}}`;
const PRUNED_1000 = "Block 1000 cleaned up, does not exist on node. First available block: 450467753";
const RATE_LIMITED = "HTTP 429: Disallowed status code error (429), retry after 10s";

// Solana getBlock: sol-publicnode had pruned the block → retry → sol-solana-labs answered.
const PRUNED_THEN_OK = [
  at(1000, { GUID: "2933472877181550523", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[1000,{"transactionDetails":"none"}]}', message: RECEIVED }),
  at(1009, { GUID: "2933472877181550523", chosenProviders: "sol-publicnode", stateful: "0", message: "Choosing providers" }),
  at(1119, { GUID: "2933472877181550523", error: PRUNED_1000, error_name: "CHAIN_STATE_PRUNED", retryable: "true", chain_error_message: PRUNED_1000, chain_id: "SOLANA", provider: struct("sol-publicnode", "publicnode"), message: "received node error reply from provider" }),
  at(1120, { GUID: "2933472877181550523", Error: PRUNED_1000, provider: struct("sol-publicnode", "publicnode"), Request: "getBlock", message: "Relay received a node error" }),
  at(1120, { GUID: "2933472877181550523", action: "retry", reason: "Default", batchNumber: "1", message: DECIDE }),
  at(1121, { GUID: "2933472877181550523", chosenProviders: "sol-solana-labs", stateful: "0", message: "Choosing providers" }),
  at(1243, { GUID: "2933472877181550523", served_by: "sol-solana-labs", stop_reason: "Success", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

// Solana getSlot: sol-solana-labs answered HTTP 429 → retry → sol-publicnode answered.
const RATE_LIMITED_THEN_OK = [
  at(2000, { GUID: "15972212763463815960", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"getSlot"}', message: RECEIVED }),
  at(2000, { GUID: "15972212763463815960", chosenProviders: "sol-solana-labs", stateful: "0", message: "Choosing providers" }),
  at(2064, { GUID: "15972212763463815960", endpoint: "sol-solana-labs", error: RATE_LIMITED, latency: "63.978875ms", message: "direct RPC relay failed in goroutine" }),
  at(2064, { GUID: "15972212763463815960", error: RATE_LIMITED, error_name: "NODE_RATE_LIMITED", retryable: "true", chain_id: "SOLANA", provider: "sol-solana-labs", message: "could not send relay to provider" }),
  at(2064, { GUID: "15972212763463815960", action: "retry", reason: "Default", batchNumber: "1", message: DECIDE }),
  at(2065, { GUID: "15972212763463815960", chosenProviders: "sol-publicnode", stateful: "0", message: "Choosing providers" }),
  at(2158, { GUID: "15972212763463815960", served_by: "sol-publicnode", stop_reason: "Success", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

// Solana getBlock: pruned → retry → 429 → retry → no one left: the client got
// sol-publicnode's error reply, which the retry counter calls "recovered".
const ERROR_REPLY = [
  at(3000, { GUID: "7523410479464486944", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[13000]}', message: RECEIVED }),
  at(3000, { GUID: "7523410479464486944", chosenProviders: "sol-publicnode", stateful: "0", message: "Choosing providers" }),
  at(3085, { GUID: "7523410479464486944", error_name: "CHAIN_STATE_PRUNED", chain_error_message: "Block 13000 cleaned up, does not exist on node. First available block: 450476234", chain_id: "SOLANA", provider: struct("sol-publicnode", "publicnode"), message: "received node error reply from provider" }),
  at(3085, { GUID: "7523410479464486944", Error: "Block 13000 cleaned up, does not exist on node. First available block: 450476234", provider: struct("sol-publicnode", "publicnode"), Request: "getBlock", message: "Relay received a node error" }),
  at(3085, { GUID: "7523410479464486944", action: "retry", reason: "Default", batchNumber: "1", message: DECIDE }),
  at(3086, { GUID: "7523410479464486944", chosenProviders: "sol-solana-labs", stateful: "0", message: "Choosing providers" }),
  at(3161, { GUID: "7523410479464486944", endpoint: "sol-solana-labs", error: RATE_LIMITED, message: "direct RPC relay failed in goroutine" }),
  at(3161, { GUID: "7523410479464486944", error: RATE_LIMITED, error_name: "NODE_RATE_LIMITED", chain_id: "SOLANA", provider: "sol-solana-labs", message: "could not send relay to provider" }),
  at(3162, { GUID: "7523410479464486944", action: "retry", reason: "Default", batchNumber: "2", message: DECIDE }),
  at(3162, { GUID: "7523410479464486944", batchNumber: "2", message: "Circuit breaker: all providers exhausted, stopping" }),
  at(3181, { GUID: "7523410479464486944", served_by: "sol-publicnode", stop_reason: "AllProvidersExhausted", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

// ETH1 eth_gasPrice, captured whole: eth-mevblocker never answered; eth-tenderly
// was passed over (154 blocks behind), then - no one else left - sent to anyway,
// and its TLS handshake timed out. The request died on the router's 30 s
// processing timeout, which is also when eth-mevblocker's try was cut off.
// Six of these lines share one millisecond, at three log levels (three Loki
// streams): only the fraction puts them in order.
const TLS_TIMEOUT = 'http request failed: Post "https://mainnet.gateway.tenderly.co": net/http: TLS handshake timeout: Network operation timed out connecting to provider';
const DEADLINE = 'http request failed: Post "https://rpc.mevblocker.io": context deadline exceeded: Caller\'s context.Context deadline expired before the relay completed (can fire at any layer - consumer request timeout, processing timeout, subrequest timeout)';
const G = "14201510179726267290";
const BEHIND = { endpoint: "eth-tenderly", endpointLatest: "26069373", chainTip: "26069527", lag: "154", threshold: "10", source: "endpointtip_store" };
const FAILED = [
  at(4000, { GUID: G, path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice"}', message: RECEIVED }),
  at(4000.557, { GUID: G, chosenProviders: "eth-mevblocker", stateful: "0", message: "Choosing providers" }),
  at(5010.6483, { GUID: G, chosenProviders: "eth-tenderly", stateful: "0", message: "Choosing providers" }),
  at(5010.7881, { GUID: G, ...BEHIND, message: "skipping endpoint due to consistency check" }),
  at(5011.1101, { GUID: G, fallbackProviders: "eth-tenderly", message: "all selectable providers failed consistency validation; serving from stale fallback" }),
  at(5011.1882, { GUID: G, chosenProviders: "eth-tenderly", stateful: "0", message: "Choosing providers" }),
  at(5011.2253, { GUID: G, ...BEHIND, message: "skipping endpoint due to consistency check" }),
  at(5011.2471, { GUID: G, promotedEndpoints: "1", message: "consistency fallback accepted stale endpoint batch" }),
  at(6007.3871, { GUID: G, batchNumber: "3", stillInFlight: "2", message: "Circuit breaker: all providers exhausted, stopping new attempts - relays already in flight may still answer" }),
  at(15232.087, { GUID: G, endpoint: "eth-tenderly", error: TLS_TIMEOUT, latency: "10.210899797s", message: "direct RPC relay failed in goroutine" }),
  at(15232.8483, { GUID: G, error: TLS_TIMEOUT, error_code: "1001", error_name: "PROTOCOL_CONNECTION_TIMEOUT", retryable: "true", chain_id: "ETH1", provider: "eth-tenderly", message: "could not send relay to provider" }),
  at(15233.186, { GUID: G, action: "retry", reason: "Default", batchNumber: "3", message: DECIDE }),
  at(34271.6469, { GUID: G, served_by: "", stop_reason: "ProcessingTimeout", status: "0", has_reply: "false", error: `failed relay, insufficient results ErrMsg: ${TLS_TIMEOUT} {GUID:${G}}`, message: "relay finished" }),
  at(34272.1817, { GUID: G, endpoint: "eth-mevblocker", error: DEADLINE, latency: "30.001915013s", message: "direct RPC relay failed in goroutine" }),
];

// A 1.5.x router writes only "Relay received a node error": the error's text,
// no code. Built from PRUNED_THEN_OK without the classified line.
const NO_CODE = PRUNED_THEN_OK.filter((l) => !l.line.includes("received node error reply from provider"))
  .map((l) => ({ tsMs: l.tsMs + 500, line: l.line.replace("2933472877181550523", "555") }));

// ETH1 eth_getLogs over an archive range: eth-publicnode refused it, the
// router judged the error not retryable and stopped - one try, no retry, and
// the app got the refusal.
const ARCHIVE_REFUSED = "Archive requests require a personal token. Get one at: https://www.allnodes.com/[redacted]";
const NON_RETRYABLE = [
  at(5000, { GUID: "1798399298462960308", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x1","toBlock":"latest"}]}', message: RECEIVED }),
  at(5000.4033, { GUID: "1798399298462960308", chosenProviders: "eth-publicnode", stateful: "0", message: "Choosing providers" }),
  at(5081.094, {
    GUID: "1798399298462960308",
    error: ARCHIVE_REFUSED,
    error_name: "USER_INVALID_PARAMS",
    error_category: "external",
    retryable: "false",
    chain_error_message: ARCHIVE_REFUSED,
    chain_id: "ETH1",
    provider: struct("eth-publicnode", "publicnode"),
    message: "received node error reply from provider",
  }),
  at(5081.156, { GUID: "1798399298462960308", Error: ARCHIVE_REFUSED, provider: struct("eth-publicnode", "publicnode"), Request: "eth_getLogs", message: "Relay received a node error" }),
  at(5097.95, { GUID: "1798399298462960308", served_by: "eth-publicnode", stop_reason: "NonRetryableNodeError", status: "403", has_reply: "true", error: "", message: "relay finished" }),
];

// Solana getSlot sent to two upstreams at once: sol-publicnode answered, and
// the router called sol-solana-labs' try off. Built from the shapes of the
// captured lines; nothing went wrong, so never a row.
const CANCELED = 'http request failed: Post "https://api.mainnet-beta.solana.com": context canceled: Request context was canceled (client disconnect or relay race resolved)';
const CALLED_OFF = [
  at(9000, { GUID: "444", body: '{"jsonrpc":"2.0","id":1,"method":"getSlot"}', message: RECEIVED }),
  at(9000.5, { GUID: "444", chosenProviders: "sol-solana-labs,sol-publicnode", stateful: "0", message: "Choosing providers" }),
  at(9080, { GUID: "444", served_by: "sol-publicnode", stop_reason: "Success", status: "200", has_reply: "true", error: "", message: "relay finished" }),
  at(9081, { GUID: "444", endpoint: "sol-solana-labs", error: CANCELED, message: "direct RPC relay failed in goroutine" }),
  at(9081.2, { GUID: "444", error: CANCELED, error_name: "PROTOCOL_CONTEXT_CANCELED", retryable: "false", chain_id: "SOLANA", provider: "sol-solana-labs", message: "could not send relay to provider" }),
];

// One of the router's own relays (a health check): no arrival, no end, and
// "[-] failed sending init relay" once its tries ran out. Built from the shape
// of the lines captured on 2026-09-28, while the host's network was down.
const INIT_RELAY = [
  at(8000, { GUID: "9201381641782795540", chosenProviders: "sol-publicnode", stateful: "0", message: "Choosing providers" }),
  at(8100, { GUID: "9201381641782795540", error: "dial tcp: lookup solana-rpc.publicnode.com: no such host", error_name: "UNKNOWN_ERROR", retryable: "true", chain_id: "SOLANA", provider: "sol-publicnode", message: "could not send relay to provider" }),
  at(8101, { GUID: "9201381641782795540", chainID: "SOLANA", APIInterface: "jsonrpc", message: "[-] failed sending init relay" }),
];

// A read that went fine - never a row.
const NOT_RETRIED = [
  at(6000, { GUID: "13101775707732352358", body: '{"jsonrpc":"2.0","id":1,"method":"getSlot"}', message: RECEIVED }),
  at(6000, { GUID: "13101775707732352358", chosenProviders: "sol-solana-labs", stateful: "0", message: "Choosing providers" }),
  at(6093, { GUID: "13101775707732352358", served_by: "sol-solana-labs", stop_reason: "Success", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

const UPSTREAMS: Record<string, UpstreamInfo> = {
  "sol-publicnode": { spec: "SOLANA", interfaces: ["jsonrpc"] },
  "sol-solana-labs": { spec: "SOLANA", interfaces: ["jsonrpc"] },
  "eth-mevblocker": { spec: "ETH1", interfaces: ["jsonrpc"] },
  "eth-tenderly": { spec: "ETH1", interfaces: ["jsonrpc"] },
  "eth-publicnode": { spec: "ETH1", interfaces: ["jsonrpc"] },
};
const parse = (ls: LokiLine[]) => ls.map(parseRouterLine).filter((l): l is RouterLine => l !== null);
/** An index of one single-node router per upstream - the fixtures' names are each on one chain. */
const indexOf = (ups: Record<string, UpstreamInfo>) =>
  new UpstreamIndex(
    Object.entries(ups).map(([name, u]) => ({ id: name, spec: u.spec, nodes: [{ name, endpoints: u.interfaces.map((i) => ({ interface: i })) }] })) as unknown as RouterTopology[],
  );
const rowsOf = (ls: LokiLine[]) => buildErrorRows(parse(ls), indexOf(UPSTREAMS));
const ALL = [...PRUNED_THEN_OK, ...RATE_LIMITED_THEN_OK, ...ERROR_REPLY, ...FAILED, ...NO_CODE, ...NON_RETRYABLE, ...CALLED_OFF, ...INIT_RELAY, ...NOT_RETRIED];
const row = (guid: string) => rowsOf(ALL).find((r) => r.guid === guid);

describe("requests that hit an error, from the router's log lines", () => {
  it("a row per request that hit an error, newest first - retried or not; one that went fine is not a row", () => {
    expect(rowsOf(ALL).map((r) => r.guid)).toEqual([
      "1798399298462960308", "14201510179726267290", "7523410479464486944", "15972212763463815960", "555", "2933472877181550523",
    ]);
  });

  it("each try in order: who failed, why, in the node's own words - and who answered", () => {
    expect(row("2933472877181550523")).toEqual({
      guid: "2933472877181550523",
      time: 1000,
      spec: "SOLANA",
      method: "getBlock",
      attempts: [
        { upstream: "sol-publicnode", batch: 0, outcome: "failed", replied: false, code: "CHAIN_STATE_PRUNED", retryable: true, message: PRUNED_1000, note: null, atMs: 9, endMs: 119 },
        { upstream: "sol-solana-labs", batch: 1, outcome: "ok", replied: true, code: null, retryable: null, message: null, note: null, atMs: 121, endMs: 243 },
      ],
      result: "recovered",
      resolvedBy: "sol-solana-labs",
      retried: true,
      stopReason: "Success",
      exhausted: false,
      totalMs: 243,
      error: null,
    });
  });

  it("a failure with no node reply gets the router's code and the raw error once, not twice", () => {
    const r = row("15972212763463815960");
    expect(r?.attempts).toEqual([
      { upstream: "sol-solana-labs", batch: 0, outcome: "failed", replied: false, code: "NODE_RATE_LIMITED", retryable: true, message: RATE_LIMITED, note: null, atMs: 0, endMs: 64 },
      { upstream: "sol-publicnode", batch: 1, outcome: "ok", replied: true, code: null, retryable: null, message: null, note: null, atMs: 65, endMs: 158 },
    ]);
    expect(r?.result).toBe("recovered");
  });

  it("when the reply that went back was an upstream's error, it says so", () => {
    const r = row("7523410479464486944");
    expect(r?.result).toBe("error-reply");
    expect(r?.resolvedBy).toBe("sol-publicnode");
    expect(r?.exhausted).toBe(true); // it wanted a third try and had no upstream left
    expect(r?.attempts.map((a) => [a.upstream, a.outcome, a.replied, a.code])).toEqual([
      ["sol-publicnode", "failed", true, "CHAIN_STATE_PRUNED"],
      ["sol-solana-labs", "failed", false, "NODE_RATE_LIMITED"],
    ]);
  });

  it("failed: cut off, passed over, then sent anyway - each try with the router's own reason", () => {
    const behind = "154 blocks behind the chain head (up to 10 allowed)";
    expect(row(G)).toEqual({
      guid: G,
      time: 4000,
      spec: "ETH1",
      method: "eth_gasPrice",
      attempts: [
        { upstream: "eth-mevblocker", batch: 0, outcome: "failed", replied: false, code: null, retryable: null, message: DEADLINE, note: null, atMs: 1, endMs: 30272 },
        { upstream: "eth-tenderly", batch: 1, outcome: "skipped", replied: false, code: null, retryable: null, message: null, note: `Skipped: ${behind}.`, atMs: 1011, endMs: null },
        {
          upstream: "eth-tenderly", batch: 2, outcome: "failed", replied: false, code: "PROTOCOL_CONNECTION_TIMEOUT", retryable: true, message: TLS_TIMEOUT,
          note: `Sent as a fallback, no other upstream available: ${behind}.`, atMs: 1011, endMs: 11232,
        },
      ],
      result: "failed",
      resolvedBy: null,
      retried: true,
      stopReason: "ProcessingTimeout",
      exhausted: true,
      totalMs: 30272,
      error: "failed relay, insufficient results ErrMsg: " + TLS_TIMEOUT,
    });
  });

  it("lines read in time order, whatever order the log streams hand them over", () => {
    expect(rowsOf([...FAILED].reverse())).toEqual(rowsOf(FAILED));
  });

  it("a failure proves a passed-over try went out, even with the fallback lines missing", () => {
    const noFallback = FAILED.filter((l) => !/stale fallback|stale endpoint batch/.test(l.line));
    expect(rowsOf(noFallback)[0]?.attempts[2]).toMatchObject({
      outcome: "failed",
      message: TLS_TIMEOUT,
      note: "Sent as a fallback despite the lag: 154 blocks behind the chain head (up to 10 allowed).",
    });
  });

  it("a skip line without its lag still says why", () => {
    const bare = FAILED.map((l) => ({ ...l, line: l.line.replace(/"lag":"154","threshold":"10",/, "") }));
    expect(rowsOf(bare)[0]?.attempts[1]?.note).toBe("Skipped: behind the chain head this request needs.");
  });

  it("not retried: the router judged the error not retryable and stopped - still a row, with the words the app got", () => {
    expect(row("1798399298462960308")).toMatchObject({
      spec: "ETH1",
      method: "eth_getLogs",
      result: "error-reply",
      resolvedBy: "eth-publicnode",
      retried: false,
      stopReason: "NonRetryableNodeError",
      exhausted: false,
    });
    expect(row("1798399298462960308")?.attempts).toEqual([{
      upstream: "eth-publicnode", batch: 0, outcome: "failed", replied: true, code: "USER_INVALID_PARAMS", retryable: false,
      message: "Archive requests require a personal token. Get one at: https://www.allnodes.com", note: null, atMs: 0, endMs: 81,
    }]);
  });

  it("the router's own relays are not requests: no row, whatever failed", () => {
    expect(rowsOf(INIT_RELAY)).toEqual([]);
    // Without the init-relay line, no arrival and no end still say the same.
    expect(rowsOf(INIT_RELAY.filter((l) => !l.line.includes("init relay")))).toEqual([]);
  });

  it("a try the router called off is not a failure - alone it makes no row", () => {
    expect(rowsOf(CALLED_OFF)).toEqual([]);
    // Next to a retry decision it is a row, and the try says it was called off.
    const decided = [...CALLED_OFF, at(9081.5, { GUID: "444", action: "retry", reason: "Default", batchNumber: "1", message: DECIDE })];
    expect(rowsOf(decided)[0]?.attempts[0]).toMatchObject({ outcome: "cancelled", code: "PROTOCOL_CONTEXT_CANCELED", note: CANCELLED_NOTE });
    expect(rowsOf(decided)[0]?.attempts[1]).toMatchObject({ outcome: "ok", replied: true });
  });

  it("an error with no code shows the node's words - there is no 'unknown error'", () => {
    expect(row("555")?.attempts[0]).toMatchObject({ outcome: "failed", code: null, message: PRUNED_1000 });
  });

  it("a request whose end isn't in the logs is unknown", () => {
    const cut = PRUNED_THEN_OK.filter((l) => !l.line.includes("relay finished"));
    expect(rowsOf(cut)[0]).toMatchObject({ result: "unknown", totalMs: null, resolvedBy: null });
  });

  it("a keyed upstream URL in an error keeps only its scheme and host", () => {
    const keyed = RATE_LIMITED_THEN_OK.map((l) =>
      l.line.includes("direct RPC relay failed")
        ? { ...l, line: l.line.replace(RATE_LIMITED, 'Post \\"https://solana.example.com/v2/SECRETKEY123?x=1\\": timeout') }
        : l,
    );
    const message = rowsOf(keyed)[0]?.attempts[0]?.message ?? "";
    expect(message).not.toContain("SECRETKEY123");
    expect(message).toContain("https://solana.example.com");
  });
});

describe("scrubUrls", () => {
  it("keeps scheme and host, drops path and query, for every scheme a node URL uses", () => {
    expect(scrubUrls('Post "https://a.example.com/v2/KEY": x')).toBe('Post "https://a.example.com": x');
    expect(scrubUrls("dial wss://b.example.com:8546/ws/KEY failed")).toBe("dial wss://b.example.com:8546 failed");
    expect(scrubUrls("grpcs://c.example.com:443/path")).toBe("grpcs://c.example.com:443");
    expect(scrubUrls("no url here")).toBe("no url here");
  });
});

describe("ErrorRequestsService", () => {
  /** Loki answering the service's reads: the error lines in a range, then every line of those GUIDs. */
  function lokiStub(lines: LokiLine[]) {
    const queries: string[] = [];
    const found = ["received node error reply from provider", "Relay received a node error", "could not send relay to provider",
      "direct RPC relay failed in goroutine", "[StateMachine] policy.Decide", "failed relay, insufficient results",
      "failed getting responses from RPC endpoints", "failed processing responses from RPC endpoints"];
    const loki = {
      async queryRange(query: string, startMs: number, endMs: number, limit: number) {
        queries.push(query);
        const asked = /`"GUID":"\(([^)]*)\)"`/.exec(query)?.[1]?.split("|");
        if (asked) return lines.filter((l) => asked.some((g) => l.line.includes(`"GUID":"${g}"`)));
        const one = /\|= `"GUID":"([^"]+)"`/.exec(query)?.[1];
        if (one) return lines.filter((l) => l.line.includes(`"GUID":"${one}"`));
        const names = [...query.matchAll(/`([^`]*)`/g)][2]?.[1]?.split("|");
        return lines
          .filter((l) => l.tsMs >= startMs && l.tsMs < endMs)
          .filter((l) => found.some((m) => l.line.includes(m)) && !/context canceled|PROTOCOL_CONTEXT_CANCELED/.test(l.line))
          .filter((l) => !names || names.some((n) => l.line.includes(n)))
          .sort((a, b) => b.tsMs - a.tsMs)
          .slice(0, limit);
      },
    } as unknown as LokiClient;
    return { loki, queries };
  }
  const node = (name: string) => ({ name, endpoints: [{ interface: "jsonrpc" }] });
  const configSvc = {
    getRouters: () => [
      { id: "sol", spec: "SOLANA", nodes: [node("sol-publicnode"), node("sol-solana-labs")] },
      { id: "eth", spec: "ETH1", nodes: [node("eth-mevblocker"), node("eth-tenderly"), node("eth-publicnode")] },
    ],
  } as unknown as ConfigurationService;
  const LINES = [...PRUNED_THEN_OK, ...RATE_LIMITED_THEN_OK, ...FAILED, ...NON_RETRYABLE, ...CALLED_OFF, ...NOT_RETRIED];
  const RANGE = { startMs: 0, endMs: 100_000 };

  it("finds requests by their error lines - called-off tries left out - then reads every line of them", async () => {
    const { loki, queries } = lokiStub(LINES);
    const r = await new ErrorRequestsService(loki, '{service="router"}', configSvc).report(RANGE);
    expect(queries[0]).toContain("received node error reply from provider|Relay received a node error|could not send relay to provider");
    expect(queries[0]).toContain("!~ `PROTOCOL_CONTEXT_CANCELED|context canceled`");
    expect(queries[1]).toContain('`"GUID":"(');
    expect(r).toMatchObject({ available: true, more: false, nextBefore: null });
    expect(r.rows.map((x) => [x.method, x.result])).toEqual([
      ["eth_getLogs", "error-reply"], ["eth_gasPrice", "failed"], ["getSlot", "recovered"], ["getBlock", "recovered"],
    ]);
  });

  it("a chain or a config router narrows the read to its upstreams, and keeps only its own requests", async () => {
    const { loki, queries } = lokiStub(LINES);
    const svc = new ErrorRequestsService(loki, '{service="router"}', configSvc);
    expect((await svc.report(RANGE, "ETH1")).rows.map((x) => x.method)).toEqual(["eth_getLogs", "eth_gasPrice"]);
    expect(queries[0]).toMatch(/\|~ `eth-mevblocker\|eth-tenderly\|eth-publicnode`$/);
    expect((await svc.report(RANGE, undefined, "sol")).rows.map((x) => x.method)).toEqual(["getSlot", "getBlock"]);
  });

  it("reads the newest first, and says where to read on for the older ones", async () => {
    const { loki } = lokiStub(LINES);
    const svc = new ErrorRequestsService(loki, '{service="router"}', configSvc, 2);
    const first = await svc.report(RANGE);
    expect(first.rows.map((x) => x.method)).toEqual(["eth_getLogs", "eth_gasPrice"]);
    expect(first.more).toBe(true);
    // The next read ends just past the newest line of the first request not
    // kept, so that line is read again: nothing between the two reads is lost.
    expect(first.nextBefore).toBeCloseTo(2064.001, 6);
    const older = await svc.report(RANGE, undefined, undefined, first.nextBefore!);
    expect(older.rows.map((x) => x.method)).toEqual(["getSlot", "getBlock"]);
    expect(older).toMatchObject({ more: false, nextBefore: null });
  });

  it("an exact range reads only that range", async () => {
    const { loki } = lokiStub(LINES);
    const r = await new ErrorRequestsService(loki, '{service="router"}', configSvc).report({ startMs: 1500, endMs: 2500 });
    expect(r.rows.map((x) => x.method)).toEqual(["getSlot"]);
  });

  it("looks one request up by its ID - a request that went fine too", async () => {
    const { loki, queries } = lokiStub(LINES);
    const svc = new ErrorRequestsService(loki, '{service="router"}', configSvc);
    expect((await svc.lookup("15972212763463815960", RANGE)).row).toMatchObject({ method: "getSlot", result: "recovered", retried: true });
    expect(queries.at(-1)).toBe('{service="router"} |= `"GUID":"15972212763463815960"`');
    // Nothing failed on the way: answered, not "recovered".
    expect((await svc.lookup("13101775707732352358", RANGE)).row).toMatchObject({ method: "getSlot", result: "ok", retried: false });
    expect(await svc.lookup("999", RANGE)).toEqual({ available: true, row: null });
  });

  it("an ID that could reach into the query is never sent", async () => {
    const { loki, queries } = lokiStub(LINES);
    const r = await new ErrorRequestsService(loki, '{service="router"}', configSvc).lookup('1"} |= `x', RANGE);
    expect(r).toEqual({ available: true, row: null });
    expect(queries).toEqual([]);
  });

  it("no log store, or one that does not answer, is 'not available' - never 'no errors'", async () => {
    expect((await new ErrorRequestsService(null, '{service="router"}').report(RANGE)).available).toBe(false);
    const down = { async queryRange() { return null; } } as unknown as LokiClient;
    expect((await new ErrorRequestsService(down, '{service="router"}').report(RANGE)).available).toBe(false);
    const { loki } = lokiStub([]);
    expect(await new ErrorRequestsService(loki, '{service="router"}').report(RANGE)).toEqual({ available: true, rows: [], more: false, nextBefore: null });
  });
});

describe("readRange", () => {
  const NOW = 1_800_000_000_000;
  it("an exact from-to, never past now", () => {
    expect(readRange({ from: NOW - 3_600_000, to: NOW - 60_000 }, NOW)).toEqual({ startMs: NOW - 3_600_000, endMs: NOW - 60_000 });
    expect(readRange({ from: NOW - 3_600_000, to: NOW + 3_600_000 }, NOW)).toEqual({ startMs: NOW - 3_600_000, endMs: NOW });
  });
  it("a pair it can't read is an error - never a quiet read of another range", () => {
    expect(readRange({ window: "1d", from: NOW - 1000, to: NOW - 2000 }, NOW)).toEqual({ error: "from must be before to" });
    expect(readRange({ window: "1d", from: NOW - 40 * 86_400_000, to: NOW }, NOW)).toEqual({ error: "a range is at most 30 days" });
    expect(readRange({ window: "1d", from: NOW - 1000 }, NOW)).toEqual({ error: "from and to go together" });
    expect(readRange({ from: NOW + 60_000, to: NOW + 120_000 }, NOW)).toEqual({ error: "from must be in the past" });
  });
  it("without from and to it is the page's window back from now; an unknown window is the default", () => {
    expect(readRange({ window: "1d" }, NOW)).toEqual({ startMs: NOW - 86_400_000, endMs: NOW });
    expect(readRange({ window: "nope" }, NOW)).toEqual({ startMs: NOW - 1_800_000, endMs: NOW });
  });
});

describe("GET /api/error-requests", () => {
  let app: FastifyInstance;
  const ns = (ls: LokiLine[]) => ls.map((l) => [String(BigInt(Math.round(l.tsMs * 1000)) * 1000n), l.line]);

  beforeEach(() => {
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(input.toString());
      if (!url.pathname.endsWith("/loki/api/v1/query_range")) {
        return Response.json({ status: "success", data: { resultType: "vector", result: [] } });
      }
      const q = url.searchParams.get("query") ?? "";
      // Every line of the request asked for - by the list's batch or a look-up by ID.
      const lines = q.includes('`"GUID":"(') || q.includes('|= `"GUID":"')
        ? RATE_LIMITED_THEN_OK
        : RATE_LIMITED_THEN_OK.filter((l) => l.line.includes("could not send relay") || l.line.includes("policy.Decide"));
      return Response.json({ status: "success", data: { resultType: "streams", result: [{ stream: { service: "router" }, values: ns(lines) }] } });
    });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.LOKI_URL;
    vi.unstubAllGlobals();
  });

  it("without LOKI_URL it answers, and says the logs are not available", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/error-requests?window=1h" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, reason: "unconfigured", rows: [], more: false, nextBefore: null });
  });

  it("GET /api/requests/:guid looks one request up; a malformed ID is a 400", async () => {
    process.env.LOKI_URL = "http://loki.test:3100";
    app = await buildApp();
    const bad = await app.inject({ method: "GET", url: "/api/requests/not%20an%20id" });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: "GET", url: "/api/requests/15972212763463815960?window=1d" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, row: { guid: "15972212763463815960", method: "getSlot", resolvedBy: "sol-publicnode" } });
  });

  it("with LOKI_URL it lists each request's tries - for the window, or an exact range", async () => {
    process.env.LOKI_URL = "http://loki.test:3100";
    app = await buildApp();
    for (const url of ["/api/error-requests?window=1h", `/api/error-requests?from=${Date.now() - 3_600_000}&to=${Date.now()}`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.available).toBe(true);
      expect(body.rows[0]).toMatchObject({ method: "getSlot", spec: "SOLANA", result: "recovered", resolvedBy: "sol-publicnode", retried: true });
      expect(body.rows[0].attempts.map((a: { upstream: string }) => a.upstream)).toEqual(["sol-solana-labs", "sol-publicnode"]);
    }
  });
});

describe("GET /api/error-requests/count", () => {
  let app: FastifyInstance;
  const queries: string[] = [];
  let answer: (q: string) => { metric: Record<string, string>; value: [number, string] }[] = () => [];

  beforeEach(() => {
    queries.length = 0;
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(input.toString());
      if (!url.pathname.endsWith("/loki/api/v1/query")) {
        return Response.json({ status: "success", data: { resultType: "streams", result: [] } });
      }
      const q = url.searchParams.get("query") ?? "";
      queries.push(q);
      return Response.json({ status: "success", data: { resultType: "vector", result: answer(q) } });
    });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.LOKI_URL;
    vi.unstubAllGlobals();
  });

  it("without LOKI_URL it answers, and says the logs are not available", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/error-requests/count?window=1d" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, reason: "unconfigured", value: null });
  });

  it("counts the line the router ends each request it could not serve with - nothing back, or nothing usable", async () => {
    process.env.LOKI_URL = "http://loki.test:3100";
    answer = () => [{ metric: {}, value: [0, "4"] }];
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/error-requests/count?window=1d&spec=ETH1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, value: 4 });
    expect(queries).toHaveLength(1);
    for (const q of queries) {
      // The default selector: the label the fleet's log agent and compose's promtail share.
      expect(q.startsWith('sum(count_over_time({component="router"} ')).toBe(true);
      expect(q).toContain("|~ `failed (getting|processing) responses from RPC endpoints`");
      // Matched as the line's message: other lines quote it in their error field.
      expect(q).toContain('| json msg="message", ep="endpoint" | msg=~`failed (getting|processing) responses from RPC endpoints`');
      // A chain is the listener that logged it: <spec><interface>.
      expect(q).toContain("| ep=~`ETH1(jsonrpc|rest|tendermintrpc|grpc)`");
      expect(q).toContain("[86400s]");
    }
  });

  it("keeps a count for 30 seconds, so every open page shares one scan", async () => {
    process.env.LOKI_URL = "http://loki.test:3100";
    answer = () => [{ metric: {}, value: [0, "2"] }];
    app = await buildApp();
    for (let k = 0; k < 3; k++) {
      const res = await app.inject({ method: "GET", url: "/api/error-requests/count?window=7d" });
      expect(res.json()).toEqual({ available: true, value: 2 });
    }
    expect(queries).toHaveLength(1);
    // Another window or chain is its own count.
    await app.inject({ method: "GET", url: "/api/error-requests/count?window=7d&spec=BTC" });
    expect(queries).toHaveLength(2);
  });

  it("a spec that isn't a plain token is refused before it can reach the LogQL", async () => {
    process.env.LOKI_URL = "http://loki.test:3100";
    app = await buildApp();
    // A backtick would end the raw string the spec sits in, and run the rest as LogQL.
    const res = await app.inject({ method: "GET", url: `/api/error-requests/count?window=1d&spec=${encodeURIComponent("ETH1` or {job=\"other\"} |= `")}` });
    expect(res.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it("nothing matched is zero requests, not an unknown", async () => {
    process.env.LOKI_URL = "http://loki.test:3100";
    answer = () => [];
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/error-requests/count?window=1h" });
    expect(res.json()).toEqual({ available: true, value: 0 });
    expect(queries.every((q) => !q.includes("| ep=~"))).toBe(true);
  });
});

const SEL = '{service="router"}';
const nodeOf = (name: string) => ({ name, endpoints: [{ interface: "jsonrpc" }] });

describe("a request no upstream answered", () => {
  // As smart-router v1.5.6 writes it: with nothing back, the router logs
  // "failed getting responses from RPC endpoints" and returns before "relay finished".
  const NO_ANSWER = [
    at(7000, { GUID: "303", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}', message: RECEIVED }),
    at(7001, { GUID: "303", chosenProviders: "eth-publicnode,eth-tenderly", stateful: "0", message: "Choosing providers" }),
    at(17_000, { GUID: "303", endpoint: "eth-publicnode", error: 'Post "https://eth.example.com/v2/KEY": context deadline exceeded', message: "direct RPC relay failed in goroutine" }),
    at(17_001, { GUID: "303", endpoint: "eth-tenderly", error: "dial tcp 10.0.0.2:443: connect: connection refused", message: "direct RPC relay failed in goroutine" }),
    at(17_002, { GUID: "303", endpoint: "ETH1jsonrpc", error: "failed relay, insufficient results {GUID:303}", message: "failed getting responses from RPC endpoints" }),
  ];

  it("is failed, with the router's own error and the time it gave up - not 'unknown'", () => {
    const [r] = rowsOf(NO_ANSWER);
    expect(r).toMatchObject({ guid: "303", result: "failed", error: "failed relay, insufficient results", totalMs: 10_002, spec: "ETH1" });
    expect(r!.attempts.map((a) => `${a.upstream}:${a.outcome}`)).toEqual(["eth-publicnode:failed", "eth-tenderly:failed"]);
  });

  it("is found and read back by the list", async () => {
    const node = (name: string) => ({ name, endpoints: [{ interface: "jsonrpc" }] });
    const cfg = { getRouters: () => [{ id: "eth", spec: "ETH1", nodes: [node("eth-publicnode"), node("eth-tenderly")] }] } as unknown as ConfigurationService;
    const loki = {
      async queryRange(query: string, startMs: number, endMs: number) {
        return NO_ANSWER.filter((l) => l.tsMs >= startMs && l.tsMs < endMs && (query.includes("GUID") || /failed getting|direct RPC/.test(l.line)));
      },
    } as unknown as LokiClient;
    const r = await new ErrorRequestsService(loki, SEL, cfg).report({ startMs: 0, endMs: 100_000 });
    expect(r.rows.map((x) => [x.guid, x.result])).toEqual([["303", "failed"]]);
  });
});

describe("reading on with Load older", () => {
  // Request 1's tries failed at 970 and at 1000; request 2's at 985, in between.
  const lines = [
    at(960, { GUID: "1", path: "/", body: '{"method":"eth_call"}', message: RECEIVED }),
    at(961, { GUID: "1", chosenProviders: "eth-publicnode", message: "Choosing providers" }),
    at(970, { GUID: "1", endpoint: "eth-publicnode", error: "context deadline exceeded", message: "direct RPC relay failed in goroutine" }),
    at(971, { GUID: "1", chosenProviders: "eth-tenderly", message: "Choosing providers" }),
    at(1000, { GUID: "1", provider: "eth-tenderly", error_name: "NODE_ERR", chain_id: "ETH1", message: "received node error reply from provider" }),
    at(1001, { GUID: "1", served_by: "eth-tenderly", has_reply: "true", message: "relay finished" }),
    at(980, { GUID: "2", path: "/", body: '{"method":"eth_getLogs"}', message: RECEIVED }),
    at(981, { GUID: "2", chosenProviders: "eth-publicnode", message: "Choosing providers" }),
    at(985, { GUID: "2", provider: "eth-publicnode", error_name: "NODE_ERR", chain_id: "ETH1", message: "received node error reply from provider" }),
    at(986, { GUID: "2", served_by: "eth-publicnode", has_reply: "true", message: "relay finished" }),
  ];

  it("lists a request whose lines sit between a kept request's first and last - one per read", async () => {
    const cfg = { getRouters: () => [{ id: "eth", spec: "ETH1", nodes: [nodeOf("eth-publicnode"), nodeOf("eth-tenderly")] }] } as unknown as ConfigurationService;
    const loki = {
      async queryRange(query: string, startMs: number, endMs: number, limit: number) {
        const asked = /`"GUID":"\(([^)]*)\)"`/.exec(query)?.[1]?.split("|");
        if (asked) return lines.filter((l) => asked.some((g) => l.line.includes(`"GUID":"${g}"`)));
        return lines
          .filter((l) => l.tsMs >= startMs && l.tsMs < endMs && /node error reply|direct RPC/.test(l.line))
          .sort((a, b) => b.tsMs - a.tsMs)
          .slice(0, limit);
      },
    } as unknown as LokiClient;
    const svc = new ErrorRequestsService(loki, SEL, cfg, 1);
    const listed: string[] = [];
    let before: number | undefined;
    for (let read = 0; read < 5; read++) {
      const r = await svc.report({ startMs: 0, endMs: 10_000 }, undefined, undefined, before);
      for (const row of r.rows) if (!listed.includes(row.guid)) listed.push(row.guid);
      if (!r.more) break;
      before = r.nextBefore!;
    }
    expect(listed).toEqual(["1", "2"]);
  });
});

describe("which chain a request was on", () => {
  // One node name serving two chains, as vendors' do in production.
  const index = new UpstreamIndex([
    { id: "eth", spec: "ETH1", nodes: [nodeOf("publicnode"), nodeOf("eth-alchemy")] },
    { id: "base", spec: "BASE", nodes: [nodeOf("publicnode"), nodeOf("base-alchemy")] },
  ] as unknown as RouterTopology[]);
  const failedAt = (guid: string, pool: string) => [
    at(1, { GUID: guid, path: "/", body: '{"method":"eth_call"}', message: RECEIVED }),
    at(2, { GUID: guid, validAddresses: pool, chosenProviders: "publicnode", message: "Choosing providers" }),
    at(3, { GUID: guid, endpoint: "publicnode", error: "HTTP 503", message: "direct RPC relay failed in goroutine" }),
    at(4, { GUID: guid, served_by: "", has_reply: "false", error: "failed relay", message: "relay finished" }),
  ];

  it("the pool the router chose from settles a shared name", () => {
    const [row] = buildErrorRows(parse(failedAt("7", "publicnode,base-alchemy")), index);
    expect(row).toMatchObject({ spec: "BASE" });
    expect(row!.specs).toBeUndefined();
  });

  it("when nothing settles it, the chain stays open and the request shows under each - never under the first alone", () => {
    const [row] = buildErrorRows(parse(failedAt("8", "publicnode")), index);
    expect(row).toMatchObject({ spec: null, specs: ["BASE", "ETH1"] });
    expect(onChain(row!, "BASE") && onChain(row!, "ETH1")).toBe(true);
  });

  it("a chain_id on a line is the chain, whatever the names say", () => {
    const lines = [...failedAt("9", "publicnode"), at(5, { GUID: "9", provider: "publicnode", chain_id: "ETH1", error_name: "X", message: "received node error reply from provider" })];
    expect(buildErrorRows(parse(lines), index)[0]).toMatchObject({ spec: "ETH1" });
  });
});

describe("the Failed requests count", () => {
  const counter = (value: number | null) => {
    const queries: string[] = [];
    const loki = { async count(q: string) { queries.push(q); return value; } } as unknown as LokiClient;
    return { loki, queries };
  };
  const cfg = {
    getRouters: () => [
      { id: "eth-a", spec: "ETH1", nodes: [nodeOf("a")] },
      { id: "eth-b", spec: "ETH1", nodes: [nodeOf("b")] },
      { id: "btc", spec: "BTC", nodes: [nodeOf("c")] },
    ],
  } as unknown as ConfigurationService;

  it("a router alone on its chain is counted by that chain; one sharing it can't be told apart, and says so", async () => {
    const { loki, queries } = counter(2);
    const svc = new ErrorRequestsService(loki, SEL, cfg);
    expect(await svc.failedCount("1h", undefined, "btc")).toEqual({ available: true, value: 2 });
    expect(queries[0]).toContain("| ep=~`BTC(jsonrpc|rest|tendermintrpc|grpc)`");
    expect(await svc.failedCount("1h", undefined, "eth-a")).toEqual({ available: false, reason: "shared-chain", value: null });
    expect(queries).toHaveLength(1);
  });

  it("a chain the values file doesn't serve is zero, without reading the logs", async () => {
    const { loki, queries } = counter(9);
    expect(await new ErrorRequestsService(loki, SEL, cfg).failedCount("1h", "NOPE")).toEqual({ available: true, value: 0 });
    expect(queries).toHaveLength(0);
  });

  it("one read in flight per window and chain, and a failed read is kept too: a down Loki isn't asked on every poll", async () => {
    let calls = 0;
    let settle: (v: number | null) => void = () => {};
    const loki = { count: () => { calls += 1; return new Promise<number | null>((r) => { settle = r; }); } } as unknown as LokiClient;
    const svc = new ErrorRequestsService(loki, SEL, cfg);
    const first = svc.failedCount("1h");
    const second = svc.failedCount("1h");
    settle(null);
    const down = { available: false, reason: "unreachable", value: null };
    expect(await first).toEqual(down);
    expect(await second).toEqual(down);
    expect(await svc.failedCount("1h")).toEqual(down);
    expect(calls).toBe(1);
  });
});

describe("a bar's requests", () => {
  it("an upstream narrows the read to its name, and keeps the requests whose try at it failed", async () => {
    const queries: string[] = [];
    const loki = {
      async queryRange(query: string) {
        queries.push(query);
        return PRUNED_THEN_OK;
      },
    } as unknown as LokiClient;
    const cfg = { getRouters: () => [{ id: "sol", spec: "SOLANA", nodes: [nodeOf("sol-publicnode"), nodeOf("sol-solana-labs")] }] } as unknown as ConfigurationService;
    const svc = new ErrorRequestsService(loki, SEL, cfg);
    const r = await svc.report({ startMs: 0, endMs: 100_000 }, undefined, undefined, undefined, "sol-publicnode");
    expect(queries[0]).toMatch(/\|~ `sol-publicnode`$/);
    expect(r.rows.map((x) => x.guid)).toEqual(["2933472877181550523"]);
    const other = await svc.report({ startMs: 0, endMs: 100_000 }, undefined, undefined, undefined, "sol-solana-labs");
    expect(other.rows).toEqual([]); // its try answered; it didn't fail there
  });
});

describe("the method of a request whose path a log collector masked", () => {
  it("says the path was redacted, rather than showing the mask as a path", () => {
    const rec = parse([at(1, { GUID: "9", path: "/REDACTED", message: "Consumer received a new REST non-POST request" })])[0];
    expect(methodOf(rec)).toBe(METHOD_REDACTED);
    expect(methodOf(undefined, parse([at(2, { GUID: "9", api: "/REDACTED", message: "received node error reply from provider" })]))).toBe(METHOD_REDACTED);
    expect(methodOf(undefined, parse([at(2, { GUID: "9", api: "/cosmos/bank/v1beta1/balances/{address}", message: "x" })]))).toBe("/cosmos/bank/v1beta1/balances/{address}");
  });
});

describe("GET /api/error-requests - ranges it can't read", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
    delete process.env.LOKI_URL;
  });

  it("answers 400 rather than listing another range under the picked times", async () => {
    process.env.LOKI_URL = "http://loki.test:3100";
    app = await buildApp();
    const now = Date.now();
    for (const url of [
      `/api/error-requests?from=${now + 3_600_000}&to=${now + 7_200_000}`,
      `/api/error-requests?from=${now - 1000}`,
      `/api/transactions?from=${now - 1000}&to=${now - 2000}`,
      "/api/requests/123?from=-5&to=10",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
  });
});
