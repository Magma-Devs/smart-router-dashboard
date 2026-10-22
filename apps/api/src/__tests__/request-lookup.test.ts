import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { ErrorRequestsService } from "../services/error-requests.js";
import { TransactionsService } from "../services/transactions.js";
import { MINTED_BEFORE_MS, MINTED_SPAN_MS } from "../services/router-log.js";
import { msToNs, type LokiClient, type LokiLine } from "../services/loki-client.js";

/* A look-up by request ID. smart-router v1.6.1 mints a GUID as the unix
   second over a counter, so the look-up reads that second's minutes first,
   whatever range it was asked for. */

const NOW_SEC = 1_792_323_767; // 2026-10-18
const NOW = NOW_SEC * 1000;
const DAY = 86_400_000;

/** A GUID as smart-router v1.6.1 mints it. */
const mint = (sec: number, counter: number) => ((BigInt(sec) << 32n) | BigInt(counter)).toString();

const ev = (at: number, fields: Record<string, unknown>): LokiLine => ({
  tsMs: at,
  line: JSON.stringify({ level: "info", event: "relay_end", schema: 1, stateful: false, api_interface: "jsonrpc", is_batch: false, error: "", error_code: "", ...fields, message: "relay_end" }),
});
const at = (tsMs: number, fields: Record<string, string>): LokiLine => ({ tsMs, line: JSON.stringify(fields) });

// Two days ago, on a v1.6.1 router: node-a refused, node-b answered the retry.
const SEC = NOW_SEC - 2 * 86_400;
const GUID = mint(SEC, 1_234_567);
const RECOVERED = ev(SEC * 1000 + 420, {
  GUID, method: "eth_getBalance", chain: "ETH1", selection: "stateless", outcome: "ok", stop_reason: "Success", served_by: "node-b", status: 200, has_reply: true, latency_ms: 120,
  attempts: [
    { upstream: "node-a", outcome: "transport_error", error_code: "PROTOCOL_CONNECTION_REFUSED", message: "connection refused", retryable: true, batch: 0, sent_ms: 1, latency_ms: 3, returned_to_client: false },
    { upstream: "node-b", outcome: "ok", error_code: "", message: "", batch: 1, sent_ms: 5, latency_ms: 110, returned_to_client: true },
  ],
});

// A transaction on a v1.6.1 router, an hour ago.
const TX_SEC = NOW_SEC - 3_600;
const TX_GUID = mint(TX_SEC, 77);
const TX_ACCEPTED = ev(TX_SEC * 1000 + 310, {
  GUID: TX_GUID, stateful: true, method: "eth_sendRawTransaction", chain: "ETH1", selection: "stateful", outcome: "ok", stop_reason: "Success", served_by: "node-b", status: 200, has_reply: true, latency_ms: 310,
  attempts: [{ upstream: "node-b", outcome: "ok", error_code: "", message: "", batch: 0, sent_ms: 1, latency_ms: 304, returned_to_client: true }],
});

// An older router's random GUID that happens to decode to a plausible second
// (ten days ago, about 0.06% of them do); its lines are ten minutes old.
const LUCKY_SEC = NOW_SEC - 10 * 86_400;
const LUCKY = mint(LUCKY_SEC, 4_242);
const LUCKY_LINES = [
  at(NOW - 600_000, { GUID: LUCKY, path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}', message: "Consumer received a new JSON-RPC request" }),
  at(NOW - 599_990, { GUID: LUCKY, chosenProviders: "node-a", stateful: "0", message: "Choosing providers" }),
  at(NOW - 599_900, { GUID: LUCKY, served_by: "node-a", stop_reason: "Success", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

// A random GUID of an older router, with its second in 2087: none to read off it.
const RANDOM = "15972212763463815960";
const RANDOM_LINES = [
  at(NOW - 60_000, { GUID: RANDOM, path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}', message: "Consumer received a new JSON-RPC request" }),
  at(NOW - 59_990, { GUID: RANDOM, served_by: "node-a", stop_reason: "Success", status: "200", has_reply: "true", error: "", message: "relay finished" }),
];

// A BTC send a v1.6.1 router held 20 minutes: a hanging call adds two 10-minute blocks to its budget.
const LONG_SEC = NOW_SEC - 86_400;
const LONG = mint(LONG_SEC, 9);
const LONG_LINES = [
  at(LONG_SEC * 1000 + 5, { GUID: LONG, path: "/", body: '{"jsonrpc":"1.0","id":1,"method":"sendrawtransaction"}', message: "Consumer received a new JSON-RPC request" }),
  ev(LONG_SEC * 1000 + 20 * 60_000 + 8, {
    GUID: LONG, stateful: true, method: "sendrawtransaction", chain: "BTC", selection: "stateful", outcome: "no_answer", stop_reason: "ProcessingTimeout", served_by: "", status: 0, has_reply: false, latency_ms: 1_200_000,
    error_code: "PROTOCOL_CONTEXT_DEADLINE", error: "context deadline exceeded",
    attempts: [{ upstream: "btc-a", outcome: "timeout", error_code: "PROTOCOL_CONTEXT_DEADLINE", message: "context deadline exceeded", retryable: true, batch: 0, sent_ms: 1, returned_to_client: false }],
  }),
];

const LINES = [RECOVERED, TX_ACCEPTED, ...LUCKY_LINES, ...RANDOM_LINES, ...LONG_LINES];

/** Loki as a look-up sees it: one request's lines, between two times. */
function lokiOf(lines: LokiLine[], answers = true) {
  const reads: [number, number][] = [];
  const loki = {
    async queryRange(query: string, startMs: number, endMs: number, limit: number) {
      reads.push([startMs, endMs]);
      if (!answers) return null;
      // The look-up's first filter is the value itself (linesOfRequest).
      const id = /\|= `([^`]+)`/.exec(query)?.[1];
      return lines.filter((l) => l.line.includes(`"GUID":"${id}"`) && l.tsMs >= startMs && l.tsMs < endMs).slice(0, limit);
    },
  } as unknown as LokiClient;
  return { loki, reads };
}

const minutesOf = (sec: number): [number, number] => [sec * 1000 - MINTED_BEFORE_MS, sec * 1000 + MINTED_SPAN_MS];
const LAST_30M = { startMs: NOW - 1_800_000, endMs: NOW };
const LAST_30D = { startMs: NOW - 30 * DAY, endMs: NOW };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("looking a request up by a GUID that carries its second", () => {
  it("reads from a minute before that second to five minutes after, whatever the range", async () => {
    const { loki, reads } = lokiOf(LINES);
    const svc = new ErrorRequestsService(loki, '{service="router"}');
    // Two days ago, asked with the last 30 minutes: found all the same.
    expect(await svc.lookup(GUID, LAST_30M)).toMatchObject({ available: true, row: { guid: GUID, method: "eth_getBalance", result: "recovered", resolvedBy: "node-b" } });
    expect(reads).toEqual([minutesOf(SEC)]);
    expect(minutesOf(SEC)).toEqual([SEC * 1000 - 60_000, SEC * 1000 + 300_000]);
  });

  it("a miss there reads the range, as before: an older router's GUID can decode by chance", async () => {
    const { loki, reads } = lokiOf(LINES);
    const r = await new ErrorRequestsService(loki, '{service="router"}').lookup(LUCKY, LAST_30M);
    expect(r).toMatchObject({ available: true, row: { guid: LUCKY, method: "eth_blockNumber", result: "ok" } });
    expect(reads).toEqual([minutesOf(LUCKY_SEC), [LAST_30M.startMs, LAST_30M.endMs]]);
  });

  it("a 30-day range reads only its minutes - the month is never read for it", async () => {
    const { loki, reads } = lokiOf(LINES);
    const svc = new ErrorRequestsService(loki, '{service="router"}');
    expect(await svc.lookup(LUCKY, LAST_30D)).toEqual({ available: true, row: null });
    expect(reads).toEqual([minutesOf(LUCKY_SEC)]);
    expect(await svc.lookup(GUID, LAST_30D)).toMatchObject({ row: { guid: GUID } });
    expect(reads).toEqual([minutesOf(LUCKY_SEC), minutesOf(SEC)]);
  });

  it("found without its relay_end - still running, or longer than the span - it reads the range too", async () => {
    const { loki, reads } = lokiOf(LINES);
    const svc = new ErrorRequestsService(loki, '{service="router"}');
    const around = { startMs: LONG_SEC * 1000 - 3_600_000, endMs: LONG_SEC * 1000 + 3_600_000 };
    expect(await svc.lookup(LONG, around)).toMatchObject({ row: { result: "failed", stopReason: "ProcessingTimeout", totalMs: 1_200_000 } });
    expect(reads).toEqual([minutesOf(LONG_SEC), [around.startMs, around.endMs]]);
    // Over 30 days it keeps what its minutes hold: the request with no end logged.
    expect(await svc.lookup(LONG, LAST_30D)).toMatchObject({ row: { guid: LONG, result: "unknown" } });
    expect(reads).toHaveLength(3);
  });

  it("Loki not answering is unreachable, with nothing more read", async () => {
    const { loki, reads } = lokiOf(LINES, false);
    expect(await new ErrorRequestsService(loki, '{service="router"}').lookup(GUID, LAST_30M)).toEqual({ available: false, reason: "unreachable", row: null });
    expect(reads).toEqual([minutesOf(SEC)]);
  });

  it("a transaction is read the same way", async () => {
    const { loki, reads } = lokiOf(LINES);
    const svc = new TransactionsService(loki, '{service="router"}');
    expect(await svc.lookup(TX_GUID, LAST_30D)).toMatchObject({ available: true, found: true, row: { guid: TX_GUID, outcome: "accepted", answeredBy: "node-b" } });
    expect(reads).toEqual([minutesOf(TX_SEC)]);
    expect(await svc.lookup(LUCKY, LAST_30M)).toEqual({ available: true, found: true, row: null }); // a read, found in the range
    expect(await svc.lookup(mint(NOW_SEC - 60, 1), LAST_30M)).toEqual({ available: true, found: false, row: null });
    expect(reads.slice(1)).toEqual([minutesOf(LUCKY_SEC), [LAST_30M.startMs, LAST_30M.endMs], minutesOf(NOW_SEC - 60), [LAST_30M.startMs, LAST_30M.endMs]]);
  });
});

describe("looking a request up by a GUID with no second in it", () => {
  it("reads the range it was asked for, a month included, as before", async () => {
    const { loki, reads } = lokiOf(LINES);
    const svc = new ErrorRequestsService(loki, '{service="router"}');
    expect(await svc.lookup(RANDOM, LAST_30M)).toMatchObject({ row: { guid: RANDOM, method: "eth_chainId" } });
    expect(await svc.lookup(RANDOM, LAST_30D)).toMatchObject({ row: { guid: RANDOM } });
    expect(await new TransactionsService(loki, '{service="router"}').lookup("424242", LAST_30D)).toEqual({ available: true, found: false, row: null });
    expect(reads).toEqual([[LAST_30M.startMs, LAST_30M.endMs], [LAST_30D.startMs, LAST_30D.endMs], [LAST_30D.startMs, LAST_30D.endMs]]);
  });
});

describe("GET /api/requests/:guid and /api/transactions/:guid with window=30d", () => {
  let app: FastifyInstance;
  const reads: { start: string | null; end: string | null }[] = [];

  beforeEach(async () => {
    reads.length = 0;
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(input.toString());
      const query = url.searchParams.get("query") ?? "";
      if (url.pathname.endsWith("/loki/api/v1/query_range") && query.includes('"(GUID|tx_hash|request_id)":"')) {
        reads.push({ start: url.searchParams.get("start"), end: url.searchParams.get("end") });
      }
      return Response.json({ status: "success", data: { resultType: "streams", result: [] } });
    });
    process.env.LOKI_URL = "http://loki.test:3100";
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.LOKI_URL;
    vi.unstubAllGlobals();
  });

  const ns = ([from, to]: [number, number]) => ({ start: msToNs(from), end: msToNs(to) });

  it("a GUID with its second reads only its minutes", async () => {
    const errors = await app.inject({ method: "GET", url: `/api/requests/${LUCKY}?window=30d` });
    expect(errors.json()).toEqual({ available: true, row: null });
    const txs = await app.inject({ method: "GET", url: `/api/transactions/${TX_GUID}?window=30d` });
    expect(txs.json()).toEqual({ available: true, found: false, row: null });
    expect(reads).toEqual([ns(minutesOf(LUCKY_SEC)), ns(minutesOf(TX_SEC))]);
  });

  it("any other GUID reads the 30 days it was asked for", async () => {
    const res = await app.inject({ method: "GET", url: `/api/requests/${RANDOM}?window=30d` });
    expect(res.json()).toEqual({ available: true, row: null });
    expect(reads).toEqual([ns([NOW - 30 * DAY, NOW])]);
  });
});
