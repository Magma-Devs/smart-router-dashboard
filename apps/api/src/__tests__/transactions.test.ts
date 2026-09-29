import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { buildTxRows, NOTE, summarize, TransactionsService } from "../services/transactions.js";
import { parseRouterLine, type RouterLine, type UpstreamInfo } from "../services/router-log.js";
import { LokiClient, msToNs, type LokiLine } from "../services/loki-client.js";
import type { ConfigurationService } from "../services/configuration.js";

/* Router log lines as a live router wrote them (smart-router :main,
   2026-09-27), cut down to the fields the tab reads. Every fixture except
   ETH_ACCEPTED and IN_FLIGHT is a real capture: accepting a transaction needs a
   funded, signed one, so that path follows the captured shape instead. */
const at = (tsMs: number, fields: Record<string, string>): LokiLine => ({ tsMs, line: JSON.stringify(fields) });
const RECEIVED = "Consumer received a new JSON-RPC request";

// ETH1 - one upstream, which rejected the transaction.
const ETH_REJECTED = [
  at(1000, { GUID: "9946532266546017239", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}', message: RECEIVED }),
  at(1003, { GUID: "9946532266546017239", validAddresses: "eth-mevblocker", chosenProviders: "eth-mevblocker", stateful: "1", message: "Choosing providers" }),
  at(1087, {
    GUID: "9946532266546017239",
    level: "error",
    error: "Request of eth_sendRawTransaction failed with: typed transaction has unknown type: 0",
    error_name: "NODE_SERVER_ERROR",
    chain_error_message: "Request of eth_sendRawTransaction failed with: typed transaction has unknown type: 0",
    chain_id: "ETH1",
    provider: "{ProviderAddress:eth-mevblocker ProviderReputationSummary:0 ProviderStake:0 ProviderGroup:mevblocker}",
    message: "received node error reply from provider",
  }),
  at(1103, { GUID: "9946532266546017239", served_by: "eth-mevblocker", stop_reason: "Stateful", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

// SOLANA - broadcast to two upstreams, both rejected; the client got
// sol-solana-labs' reply. The router cut the long body short, so it is not JSON.
const SOL_REJECTED = [
  at(2000, { GUID: "6778780533849190198", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"sendTransaction","params":["AQAAAAAA...truncated...AAAA==",{"encoding":"base64"}]}', message: RECEIVED }),
  at(2001, { GUID: "6778780533849190198", chosenProviders: "sol-solana-labs,sol-publicnode", stateful: "1", message: "Choosing providers" }),
  at(2079, {
    GUID: "6778780533849190198",
    error_name: "USER_INVALID_PARAMS",
    chain_error_message: "failed to deserialize solana_transaction::versioned::VersionedTransaction: Attempting to read 32 bytes",
    chain_id: "SOLANA",
    provider: "{ProviderAddress:sol-solana-labs ProviderReputationSummary:0 ProviderStake:0 ProviderGroup:solana-labs}",
    message: "received node error reply from provider",
  }),
  at(2180, {
    GUID: "6778780533849190198",
    error_name: "USER_INVALID_REQUEST",
    chain_error_message: "unable to decode tx.Message: unable to decode mx.RecentBlockhash: short buffer",
    chain_id: "SOLANA",
    provider: "{ProviderAddress:sol-publicnode ProviderReputationSummary:0 ProviderStake:0 ProviderGroup:publicnode}",
    message: "received node error reply from provider",
  }),
  at(2196, { GUID: "6778780533849190198", served_by: "sol-solana-labs", stop_reason: "Stateful", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

// A read: `stateful:"0"` and not a transaction method - never a row.
const SOL_READ = [
  at(3000, { GUID: "13101775707732352358", body: '{"jsonrpc":"2.0","id":1,"method":"getSlot"}', message: RECEIVED }),
  at(3000, { GUID: "13101775707732352358", chosenProviders: "sol-solana-labs", stateful: "0", message: "Choosing providers" }),
  at(3093, { GUID: "13101775707732352358", served_by: "sol-solana-labs", stop_reason: "Success", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

// ETH1 - accepted by the upstream that answered first; the slower one said
// "already known", which the client never saw.
const ETH_ACCEPTED = [
  at(4000, { GUID: "111", body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x02f8"]}', message: RECEIVED }),
  at(4002, { GUID: "111", chosenProviders: "eth-publicnode,eth-tenderly", stateful: "1", message: "Choosing providers" }),
  at(4150, { GUID: "111", served_by: "eth-tenderly", stop_reason: "Stateful", status: "200", has_reply: "true", error: "", message: "relay finished" }),
  at(4190, { GUID: "111", error_name: "UNKNOWN_ERROR", chain_error_message: "already known", provider: "{ProviderAddress:eth-publicnode ProviderGroup:publicnode}", message: "received node error reply from provider" }),
];

// BTC - the node answered HTTP 500 (Bitcoin Core's way of returning an RPC
// error), which the router reads as a failed relay rather than a node error.
const BTC_FAILED = [
  at(5000, { GUID: "6955311520133973510", path: "/", body: '{"jsonrpc":"1.0","id":1,"method":"sendrawtransaction","params":["00"]}', message: RECEIVED }),
  at(5001, { GUID: "6955311520133973510", chosenProviders: "btc-publicnode", stateful: "1", message: "Choosing providers" }),
  at(5278, { GUID: "6955311520133973510", level: "error", error: "HTTP 500 500: Internal node error", error_name: "NODE_INTERNAL_ERROR", chain_id: "BTC", provider: "btc-publicnode", message: "could not send relay to provider" }),
  at(5296, { GUID: "6955311520133973510", level: "error", error: "HTTP 500 500: Internal node error", error_name: "NODE_INTERNAL_ERROR", chain_id: "BTC", message: "failed relay, insufficient results" }),
  at(5296, {
    GUID: "6955311520133973510",
    served_by: "",
    stop_reason: "Stateful",
    status: "0",
    has_reply: "false",
    error: "failed relay, insufficient results ErrMsg: HTTP 500 500: Internal node error {GUID:6955311520133973510}",
    message: "relay finished",
  }),
];

// HYPERLIQUID - its spec does not mark eth_sendRawTransaction stateful, so
// only the method name says it's a transaction.
const HL_REJECTED = [
  at(6000, { GUID: "10227923066219274059", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}', message: RECEIVED }),
  at(6000, { GUID: "10227923066219274059", chosenProviders: "hyperliquid-official", stateful: "0", message: "Choosing providers" }),
  at(6273, {
    GUID: "10227923066219274059",
    error_name: "USER_INVALID_PARAMS",
    chain_error_message: "failed to decode signed transaction",
    chain_id: "HYPERLIQUID",
    provider: "{ProviderAddress:hyperliquid-official ProviderReputationSummary:0 ProviderStake:0 ProviderGroup:hyperliquid}",
    message: "received node error reply from provider",
  }),
  at(6290, { GUID: "10227923066219274059", served_by: "hyperliquid-official", stop_reason: "NonRetryableNodeError", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

// COSMOSHUB over Tendermint RPC - no received line at all, and a normal
// reply that carried the chain's refusal ("code":2) inside it.
const COSMOS_REPLIED = [
  at(7000, { GUID: "6810719827514354696", chosenProviders: "cosmos-tendermintrpc-publicnode,cosmos-tendermintrpc-polkachu", stateful: "1", message: "Choosing providers" }),
  at(7093, { GUID: "6810719827514354696", served_by: "cosmos-tendermintrpc-publicnode", stop_reason: "Success", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

// Still in flight when the logs were read.
const IN_FLIGHT = [
  at(8000, { GUID: "333", body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x02"]}', message: RECEIVED }),
  at(8001, { GUID: "333", chosenProviders: "eth-mevblocker", stateful: "1", message: "Choosing providers" }),
];

const ALL = [...ETH_REJECTED, ...SOL_REJECTED, ...SOL_READ, ...ETH_ACCEPTED, ...BTC_FAILED, ...HL_REJECTED, ...COSMOS_REPLIED, ...IN_FLIGHT];
const UPSTREAMS: Record<string, UpstreamInfo> = {
  "eth-mevblocker": { spec: "ETH1", interfaces: ["jsonrpc"] },
  "eth-publicnode": { spec: "ETH1", interfaces: ["jsonrpc"] },
  "eth-tenderly": { spec: "ETH1", interfaces: ["jsonrpc"] },
  "btc-publicnode": { spec: "BTC", interfaces: ["jsonrpc"] },
  "cosmos-tendermintrpc-publicnode": { spec: "COSMOSHUB", interfaces: ["tendermintrpc"] },
  "cosmos-tendermintrpc-polkachu": { spec: "COSMOSHUB", interfaces: ["tendermintrpc"] },
};
const parse = (ls: LokiLine[]) => ls.map(parseRouterLine).filter((l): l is RouterLine => l !== null);
const rowsOf = (ls: LokiLine[]) => buildTxRows(parse(ls), (u) => UPSTREAMS[u] ?? null);
const byGuid = (guid: string) => rowsOf(ALL).find((r) => r.guid === guid);

describe("transaction rows from the router's log lines", () => {
  it("a transaction is a write by the spec or a transaction method by name - reads are left out", () => {
    expect(rowsOf(ALL).map((r) => r.guid)).toEqual([
      "333", "6810719827514354696", "10227923066219274059", "6955311520133973510",
      "111", "6778780533849190198", "9946532266546017239", // newest first
    ]);
  });

  it("a single upstream's error is the reply the client got", () => {
    expect(byGuid("9946532266546017239")).toEqual({
      guid: "9946532266546017239",
      time: 1000,
      spec: "ETH1",
      method: "eth_sendRawTransaction",
      attempts: [{
        upstream: "eth-mevblocker", batch: 0, outcome: "failed", replied: true, code: "NODE_SERVER_ERROR", retryable: null,
        message: "Request of eth_sendRawTransaction failed with: typed transaction has unknown type: 0", note: null, atMs: 3, endMs: 87,
      }],
      answeredBy: "eth-mevblocker",
      replyMs: 103,
      outcome: "rejected",
      error: {
        code: "NODE_SERVER_ERROR",
        message: "Request of eth_sendRawTransaction failed with: typed transaction has unknown type: 0",
      },
      note: null,
    });
  });

  it("on a broadcast, the cause is the answering upstream's error, not the first in the log", () => {
    expect(byGuid("6778780533849190198")).toMatchObject({
      spec: "SOLANA",
      method: "sendTransaction", // read from a body the router cut short
      answeredBy: "sol-solana-labs",
      replyMs: 196,
      outcome: "rejected",
      error: { code: "USER_INVALID_PARAMS" },
    });
    // In the capture the answering upstream also erred first; put the other
    // one's error first (Loki returns lines in time order) and the cause must
    // not follow it.
    const [received, choice, labsError, publicnodeError, finished] = SOL_REJECTED;
    const reordered = [received!, choice!, { ...publicnodeError!, tsMs: 2050 }, labsError!, finished!];
    expect(rowsOf(reordered)[0]?.error?.code).toBe("USER_INVALID_PARAMS");
  });

  it("every upstream of a broadcast: sent together, each with its own answer and when it came", () => {
    expect(byGuid("6778780533849190198")?.attempts).toEqual([
      {
        upstream: "sol-solana-labs", batch: 0, outcome: "failed", replied: true, code: "USER_INVALID_PARAMS", retryable: null,
        message: "failed to deserialize solana_transaction::versioned::VersionedTransaction: Attempting to read 32 bytes", note: null, atMs: 1, endMs: 79,
      },
      {
        upstream: "sol-publicnode", batch: 0, outcome: "failed", replied: false, code: "USER_INVALID_REQUEST", retryable: null,
        message: "unable to decode tx.Message: unable to decode mx.RecentBlockhash: short buffer", note: null, atMs: 1, endMs: 180,
      },
    ]);
  });

  it("a 1.5.x router writes a node error only as 'Relay received a node error' - still a rejection", () => {
    const legacy = ETH_REJECTED.map((l) =>
      l.line.includes("received node error reply from provider")
        ? at(l.tsMs, {
            GUID: "9946532266546017239",
            Error: "Request of eth_sendRawTransaction failed with: typed transaction has unknown type: 0",
            provider: "{ProviderAddress:eth-mevblocker ProviderReputationSummary:0 ProviderStake:0 ProviderGroup:mevblocker}",
            Request: "eth_sendRawTransaction",
            message: "Relay received a node error",
          })
        : l,
    );
    const r = rowsOf(legacy)[0];
    expect(r).toMatchObject({
      outcome: "rejected",
      error: { code: "NODE_ERROR", message: "Request of eth_sendRawTransaction failed with: typed transaction has unknown type: 0" },
    });
    expect(r?.attempts[0]).toMatchObject({ outcome: "failed", replied: true, code: null });
  });

  it("accepted when the answering upstream replied cleanly, whatever a slower one said", () => {
    expect(byGuid("111")).toMatchObject({
      spec: "ETH1", // from the values file: the loser's error line is not the reply
      answeredBy: "eth-tenderly",
      outcome: "accepted",
      error: null,
      note: null,
      replyMs: 150,
    });
    expect(byGuid("111")?.attempts.map((a) => [a.upstream, a.outcome, a.replied, a.message, a.endMs])).toEqual([
      ["eth-publicnode", "failed", false, "already known", 190], // after the reply went back
      ["eth-tenderly", "ok", true, null, 150],
    ]);
  });

  it("failed when the router got no usable reply, with the cause it classified", () => {
    expect(byGuid("6955311520133973510")).toMatchObject({
      spec: "BTC",
      method: "sendrawtransaction",
      outcome: "failed",
      answeredBy: null,
      error: {
        code: "NODE_INTERNAL_ERROR",
        message: "failed relay, insufficient results ErrMsg: HTTP 500 500: Internal node error",
      },
    });
  });

  it("finds a transaction by its method when the spec doesn't mark it a write", () => {
    expect(byGuid("10227923066219274059")).toMatchObject({
      spec: "HYPERLIQUID",
      outcome: "rejected",
      error: { code: "USER_INVALID_PARAMS", message: "failed to decode signed transaction" },
    });
  });

  it("unknown, with the reason, when the logs can't tell how it ended", () => {
    // A Cosmos chain puts its refusal inside a normal reply the router doesn't log.
    expect(byGuid("6810719827514354696")).toMatchObject({
      spec: "COSMOSHUB",
      method: "unknown", // Tendermint RPC logs no received line
      answeredBy: "cosmos-tendermintrpc-publicnode",
      outcome: "unknown",
      note: NOTE.replyNotLogged,
    });
    // It replied, and that's all the logs say: not a ✓.
    expect(byGuid("6810719827514354696")?.attempts[0]).toMatchObject({ outcome: "no-result", replied: true });
    expect(byGuid("333")).toMatchObject({ outcome: "unknown", replyMs: null, error: null, note: NOTE.noEnd });
  });

  it("the success rate leaves out transactions whose end can't be told", () => {
    const s = summarize(rowsOf(ALL));
    expect(s).toMatchObject({ total: 7, accepted: 1, rejected: 3, failed: 1 });
    expect(s.successRate).toBeCloseTo(1 / 5);
  });
});

describe("TransactionsService", () => {
  /** A Loki stub for the three reads: writes by flag, methods by name, then
   *  every line of the GUIDs asked for - filtered, as Loki does. */
  function lokiStub(lines: LokiLine[]) {
    const queries: string[] = [];
    const loki = {
      async queryRange(query: string, startMs: number, endMs: number, limit: number) {
        queries.push(query);
        const asked = /`"GUID":"\(([^)]*)\)"`/.exec(query)?.[1]?.split("|");
        if (asked) return lines.filter((l) => asked.some((g) => l.line.includes(`"GUID":"${g}"`)));
        const one = /\|= `"GUID":"([^"]+)"`/.exec(query)?.[1];
        if (one) return lines.filter((l) => l.line.includes(`"GUID":"${one}"`));
        // The two finding reads: newest first, in the range, at most `limit`.
        const inRange = (ls: LokiLine[]) => ls.filter((l) => l.tsMs >= startMs && l.tsMs < endMs).sort((a, b) => b.tsMs - a.tsMs).slice(0, limit);
        if (query.includes('|= "Choosing providers"')) return inRange(lines.filter((l) => l.line.includes("Choosing providers") && l.line.includes('"stateful":"1"')));
        if (query.includes('|= "Consumer received a new"')) return inRange(lines.filter((l) => l.line.includes("Consumer received") && /sendRawTransaction|sendTransaction|sendrawtransaction/.test(l.line)));
        return [];
      },
    } as unknown as LokiClient;
    return { loki, queries };
  }
  const node = (name: string, iface = "jsonrpc") => ({ name, endpoints: [{ interface: iface }] });
  const configSvc = {
    getRouters: () => [
      { id: "eth", spec: "ETH1", nodes: [node("eth-mevblocker"), node("eth-tenderly"), node("eth-publicnode")] },
      { id: "btc", spec: "BTC", nodes: [node("btc-publicnode")] },
    ],
  } as unknown as ConfigurationService;
  const TXS = [...ETH_REJECTED, ...ETH_ACCEPTED, ...BTC_FAILED, ...HL_REJECTED];
  const RANGE = { startMs: 0, endMs: 100_000 };

  it("finds transactions two ways, then reads every line of them by GUID", async () => {
    const { loki, queries } = lokiStub(TXS);
    const r = await new TransactionsService(loki, '{service="router"}', configSvc).report(RANGE);
    expect(queries[0]).toBe('{service="router"} |= "Choosing providers" |= `"stateful":"1"`');
    expect(queries[1]).toContain('{service="router"} |= "Consumer received a new" |~ `(eth_sendRawTransaction|');
    expect(queries[2]).toContain("10227923066219274059"); // found by method name only
    expect(r).toMatchObject({ available: true, total: 4, accepted: 1, rejected: 2, failed: 1, more: false, nextBefore: null });
  });

  it("a chain narrows the query to its upstreams, so the cap applies to that chain", async () => {
    const { loki, queries } = lokiStub(TXS);
    const r = await new TransactionsService(loki, '{service="router"}', configSvc).report(RANGE, "BTC");
    expect(queries[0]).toContain('|~ `"chosenProviders":"([^"]*,)?(btc-publicnode)[,"]`');
    expect(r.rows.map((x) => x.spec)).toEqual(["BTC"]);
  });

  it("reads the newest first, and says where to read on for the older ones", async () => {
    const { loki } = lokiStub(TXS);
    const svc = new TransactionsService(loki, '{service="router"}', configSvc, 3);
    const first = await svc.report(RANGE);
    expect(first.rows.map((x) => x.guid)).toEqual(["10227923066219274059", "6955311520133973510", "111"]);
    expect(first).toMatchObject({ more: true, nextBefore: 4000, total: 3 }); // the oldest line kept: "111" arriving
    const older = await svc.report(RANGE, undefined, undefined, first.nextBefore!);
    expect(older.rows.map((x) => x.guid)).toEqual(["9946532266546017239"]);
    expect(older).toMatchObject({ more: false, nextBefore: null });
  });

  it("an exact range reads only that range", async () => {
    const { loki } = lokiStub(TXS);
    const r = await new TransactionsService(loki, '{service="router"}', configSvc).report({ startMs: 4500, endMs: 5500 });
    expect(r.rows.map((x) => x.method)).toEqual(["sendrawtransaction"]);
  });

  it("looks one transaction up by its request ID; a request that isn't one is found, without a row", async () => {
    const { loki, queries } = lokiStub([...TXS, ...SOL_READ]);
    const svc = new TransactionsService(loki, '{service="router"}', configSvc);
    expect(await svc.lookup("9946532266546017239", RANGE)).toMatchObject({
      available: true, found: true, row: { method: "eth_sendRawTransaction", outcome: "rejected", answeredBy: "eth-mevblocker" },
    });
    expect(queries.at(-1)).toBe('{service="router"} |= `"GUID":"9946532266546017239"`');
    expect(await svc.lookup("13101775707732352358", RANGE)).toEqual({ available: true, found: true, row: null }); // a read
    expect(await svc.lookup("424242", RANGE)).toEqual({ available: true, found: false, row: null });
  });

  it("an ID that could reach into the query is never sent", async () => {
    const { loki, queries } = lokiStub(TXS);
    const r = await new TransactionsService(loki, '{service="router"}', configSvc).lookup('1"} |= `x', RANGE);
    expect(r).toEqual({ available: true, found: false, row: null });
    expect(queries).toEqual([]);
  });

  it("no log store, or one that does not answer, is 'not available' - never 'no transactions'", async () => {
    expect((await new TransactionsService(null, '{service="router"}').report(RANGE)).available).toBe(false);
    const down = { async queryRange() { return null; } } as unknown as LokiClient;
    expect((await new TransactionsService(down, '{service="router"}').report(RANGE)).available).toBe(false);
    const { loki } = lokiStub([]);
    expect(await new TransactionsService(loki, '{service="router"}').report(RANGE)).toMatchObject({ available: true, total: 0, more: false });
  });
});

describe("LokiClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks query_range in nanoseconds and reads lines back in ms; an error is null, not empty", async () => {
    const urls: URL[] = [];
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(input.toString());
      urls.push(url);
      if (url.searchParams.get("query") === "bad") return new Response("parse error", { status: 400 });
      return Response.json({ status: "success", data: { result: [{ values: [["1790539228476571721", "a line"]] }] } });
    });
    const client = new LokiClient("http://loki:3100", 1000);
    const lines = await client.queryRange('{x="y"}', 1000, 2000, 50, "backward");
    expect(lines?.map((l) => l.line)).toEqual(["a line"]);
    expect(lines?.[0]?.tsMs).toBeCloseTo(1790539228476.57, 1); // the fraction kept, not ...476
    expect(urls[0]?.pathname).toBe("/loki/api/v1/query_range");
    expect(Object.fromEntries(urls[0]!.searchParams)).toMatchObject({
      start: "1000000000",
      end: "2000000000",
      limit: "50",
      direction: "backward",
    });
    expect(await client.queryRange("bad", 0, 1, 1, "forward")).toBeNull();
  });

  it("sends Loki exact nanoseconds, fraction kept, so a read can end at a line's own time", () => {
    expect(msToNs(1790539228476)).toBe("1790539228476000000");
    expect(msToNs(1000.5)).toBe("1000500000");
    expect(msToNs(5081.094)).toBe("5081094000");
    expect(msToNs(1.9999999)).toBe("2000000"); // the fraction's rounding carries
  });

  it("keeps the fraction of a millisecond: lines one ms shares, in two streams, still sort", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ status: "success", data: { result: [
        { values: [["1759000970011460400", "info line"]] },
        { values: [["1759000970011320600", "debug line"]] },
      ] } }),
    );
    const lines = await new LokiClient("http://loki:3100", 1000).queryRange("q", 0, 1, 10, "forward");
    expect([...(lines ?? [])].sort((a, b) => a.tsMs - b.tsMs).map((l) => l.line)).toEqual(["debug line", "info line"]);
  });
});

describe("GET /api/transactions", () => {
  let app: FastifyInstance;
  const ns = (ls: LokiLine[]) => ls.map((l) => [`${l.tsMs}000000`, l.line]);

  beforeEach(() => {
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(input.toString());
      if (!url.pathname.endsWith("/loki/api/v1/query_range")) {
        return Response.json({ status: "success", data: { resultType: "vector", result: [] } });
      }
      const q = url.searchParams.get("query") ?? "";
      const lines = q.includes('`"GUID":"(') || q.includes('|= `"GUID":"')
        ? ETH_REJECTED
        : q.includes('|= "Choosing providers"')
          ? ETH_REJECTED.filter((l) => l.line.includes("Choosing providers"))
          : [];
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
    const res = await app.inject({ method: "GET", url: "/api/transactions?window=1h" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: false, total: 0, rows: [] });
  });

  it("GET /api/transactions/:guid looks one transaction up; a malformed ID is a 400", async () => {
    process.env.LOKI_URL = "http://loki.test:3100";
    app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/transactions/not%20an%20id" })).statusCode).toBe(400);
    const res = await app.inject({ method: "GET", url: "/api/transactions/9946532266546017239?window=1d" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, found: true, row: { guid: "9946532266546017239", outcome: "rejected" } });
  });

  it("with LOKI_URL it lists the transactions from the router's logs", async () => {
    process.env.LOKI_URL = "http://loki.test:3100";
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/transactions?window=1h" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ available: true, total: 1, rejected: 1, successRate: 0 });
    expect(body.rows[0]).toMatchObject({ method: "eth_sendRawTransaction", spec: "ETH1", answeredBy: "eth-mevblocker" });
  });
});
