import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorRequestsReport, TransactionsReport } from "@sr/shared";
import { buildErrorRows, ERROR_MSG, ErrorRequestsService } from "../services/error-requests.js";
import { TransactionsService } from "../services/transactions.js";
import { FAILED_KEEP_MS, HEAD_FRESH_MS, HEADS_KEPT, keepFor, LATE_MS, LIVE_KEEP_MS, readList, SETTLED_KEEP_MS, type ListPlan } from "../services/log-list.js";
import { LOG_READ_BUDGET_BYTES, readRange, type ReadRange } from "../services/read-range.js";
import { UpstreamIndex } from "../services/router-log.js";
import type { ErrorRequestRow } from "@sr/shared";
import type { LokiClient } from "../services/loki-client.js";
import type { ConfigurationService } from "../services/configuration.js";

/* A live list polled again must answer what a read of its whole window
   answers at the same moment: the same rows in the same order, the same
   `more` and `nextBefore`. Each case reads a list at T1, polls it at T2 on
   the same service (which builds on its T1 read), and reads it whole at T2 on
   a fresh one. Loki here is a stub that applies each query's line filters,
   range, direction and limit, and returns a line only once it holds it. */

const SEL = '{component="router"}';
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const WINDOW_MS = 30 * MIN;
const RECEIVED = "Consumer received a new JSON-RPC request";
const DECIDE = "[StateMachine] policy.Decide";
const CANT_SEND = "could not send relay to provider";

/** A line as Loki holds it: from `readableMs` on, which is its own time unless it came late. */
interface Logged {
  tsMs: number;
  line: string;
  readableMs: number;
}

const log = (tsMs: number, fields: Record<string, unknown>, lateMs = 0): Logged =>
  ({ tsMs, line: JSON.stringify(fields), readableMs: tsMs + lateMs });

interface Read {
  query: string;
  startMs: number;
  endMs: number;
}

/**
 * Loki as it answers a query_range: the query's line filters, its range (end
 * excluded), newest or oldest first, at most `limit`. `weigh` is what its
 * index says a stretch holds (nothing, by default: every read fits the budget).
 */
function lokiOf(logs: Logged[], down: () => boolean = () => false, weigh: (startMs: number, endMs: number) => number = () => 0) {
  const reads: Read[] = [];
  const weighed: Read[] = [];
  const loki = {
    async labelValues() { return null; }, async volume(selector: string, startMs: number, endMs: number) {
      weighed.push({ query: selector, startMs, endMs });
      return weigh(startMs, endMs);
    },
    async queryRange(query: string, startMs: number, endMs: number, limit: number, direction: "forward" | "backward") {
      reads.push({ query, startMs, endMs });
      if (down()) return null;
      const filters = [...query.matchAll(/(\|=|!=|\|~|!~) (`[^`]*`|"[^"]*")/g)].map(([, op, quoted]) => {
        const text = quoted!.slice(1, -1);
        const re = new RegExp(text);
        return (line: string) =>
          op === "|=" ? line.includes(text) : op === "!=" ? !line.includes(text) : op === "|~" ? re.test(line) : !re.test(line);
      });
      const now = Date.now();
      return logs
        .filter((l) => l.readableMs <= now && l.tsMs >= startMs && l.tsMs < endMs && filters.every((f) => f(l.line)))
        .sort((a, b) => (direction === "backward" ? b.tsMs - a.tsMs : a.tsMs - b.tsMs))
        .slice(0, limit)
        .map(({ tsMs, line }) => ({ tsMs, line }));
    },
  } as unknown as LokiClient;
  return { loki, reads, weighed };
}

const isFollowUp = (r: Read) => r.query.includes('"GUID":"(');
/** The GUIDs a read's follow-ups asked for. */
const followedUp = (reads: Read[]) =>
  reads.filter(isFollowUp).flatMap((r) => /`"GUID":"\(([^)]*)\)"`/.exec(r.query)![1]!.split("|"));

const node = (name: string) => ({ name, endpoints: [{ interface: "jsonrpc" }] });
const config = { getRouters: () => [{ id: "eth", spec: "ETH1", nodes: [node("eth-a"), node("eth-b")] }] } as unknown as ConfigurationService;

/** The page window read now, as the route makes it. */
const live = (window = "30m") => readRange({ window }) as ReadRange;

// ── The router's lines ──────────────────────────────────────────────────────

/** Errors list: a read eth-a refused with a 429, which the router retried at eth-b - its lines before #543. */
function retriedAt(guid: string, t: number, endAt = t + 120, lateMs = 0): Logged[] {
  return [
    log(t, { GUID: guid, path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_call"}', message: RECEIVED }, lateMs),
    log(t + 1, { GUID: guid, chosenProviders: "eth-a", stateful: "0", message: "Choosing providers" }, lateMs),
    log(t + 40, { GUID: guid, error: "HTTP 429", error_name: "NODE_RATE_LIMITED", retryable: "true", chain_id: "ETH1", provider: "eth-a", message: CANT_SEND }, lateMs),
    log(t + 41, { GUID: guid, action: "retry", reason: "Default", batchNumber: "1", message: DECIDE }, lateMs),
    log(t + 42, { GUID: guid, chosenProviders: "eth-b", stateful: "0", message: "Choosing providers" }, lateMs),
    log(endAt, { GUID: guid, served_by: "eth-b", stop_reason: "Success", status: "200", has_reply: "true", error: "", message: "relay finished" }, lateMs),
  ];
}

const TRIES = [
  { upstream: "eth-a", outcome: "transport_error", error_code: "NODE_RATE_LIMITED", node_code: 429, message: "HTTP 429", retryable: true, batch: 0, sent_ms: 1, latency_ms: 39, returned_to_client: false },
  { upstream: "eth-b", outcome: "ok", error_code: "", message: "", batch: 1, sent_ms: 42, latency_ms: 70, returned_to_client: true },
];

/** A request's `relay_end` (#543 on), written at its end. */
const relayEnd = (at: number, guid: string, fields: Record<string, unknown> = {}, lateMs = 0) =>
  log(at, {
    level: "info", event: "relay_end", schema: 1, stateful: false, api_interface: "jsonrpc", is_batch: false, error: "", error_code: "",
    GUID: guid, method: "eth_call", chain: "ETH1", selection: "stateless", outcome: "ok", stop_reason: "Success", served_by: "eth-b",
    status: 200, has_reply: true, latency_ms: 120, attempts: TRIES, ...fields, message: "relay_end",
  }, lateMs);

/** Transactions list: a transaction sent to eth-a, before #543; no end line when `endAt` is null. */
function sentAt(guid: string, t: number, endAt: number | null = t + 100, lateMs = 0): Logged[] {
  return [
    log(t, { GUID: guid, path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x02"]}', message: RECEIVED }, lateMs),
    log(t + 2, { GUID: guid, chosenProviders: "eth-a", stateful: "1", message: "Choosing providers" }, lateMs),
    ...(endAt === null ? [] : [log(endAt, { GUID: guid, served_by: "eth-a", stop_reason: "Stateful", status: "200", has_reply: "true", error: "", message: "relay finished" }, lateMs)]),
  ];
}

const txEnd = (at: number, guid: string, fields: Record<string, unknown> = {}) =>
  relayEnd(at, guid, { stateful: true, method: "eth_sendRawTransaction", selection: "stateful", stop_reason: "Stateful", served_by: "eth-a", latency_ms: 90,
    attempts: [{ upstream: "eth-a", outcome: "ok", error_code: "", message: "", batch: 0, sent_ms: 1, latency_ms: 88, returned_to_client: true }], ...fields });

// ── Polled against whole ────────────────────────────────────────────────────

type Lister<R> = (loki: LokiClient) => { report(range: ReadRange): Promise<R> };
const errorsList = (cap?: number): Lister<ErrorRequestsReport> => (loki) => new ErrorRequestsService(loki, SEL, config, cap);
const txList = (cap?: number): Lister<TransactionsReport> => (loki) => new TransactionsService(loki, SEL, config, cap);

/**
 * The list read at each time in `at` on one service, against a read of the
 * whole window on a fresh service at the same moment. Returns every answer
 * and the polling service's reads.
 */
async function pollEach<R>(make: Lister<R>, logs: Logged[], at: number[]) {
  const polling = lokiOf(logs);
  const svc = make(polling.loki);
  const answers: { at: number; polled: R; whole: R; reads: Read[] }[] = [];
  for (const t of at) {
    vi.setSystemTime(t);
    const before = polling.reads.length;
    const polled = await svc.report(live());
    const whole = await make(lokiOf(logs).loki).report(live());
    answers.push({ at: t, polled, whole, reads: polling.reads.slice(before) });
  }
  return answers;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a polled Errors list answers what a read of its whole window answers", () => {
  const T1 = T0;
  const T2 = T0 + 30_000;
  const S1 = T1 - WINDOW_MS;
  const S2 = T2 - WINDOW_MS;

  // Gives up after T1: its second failure and its end come after the first read.
  const STRADDLES = [
    log(T0 - 2100, { GUID: "300", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs"}', message: RECEIVED }),
    log(T0 - 2000, { GUID: "300", chosenProviders: "eth-a", stateful: "0", message: "Choosing providers" }),
    log(T0 - 1900, { GUID: "300", error: "HTTP 503", error_name: "NODE_UNAVAILABLE", retryable: "true", chain_id: "ETH1", provider: "eth-a", message: CANT_SEND }),
    log(T0 - 1850, { GUID: "300", action: "retry", reason: "Default", batchNumber: "1", message: DECIDE }),
    log(T0 - 1800, { GUID: "300", chosenProviders: "eth-b", stateful: "0", message: "Choosing providers" }),
    log(T0 + 3000, { GUID: "300", error: "HTTP 503", error_name: "NODE_UNAVAILABLE", retryable: "true", chain_id: "ETH1", provider: "eth-b", message: CANT_SEND }),
    log(T0 + 3500, { GUID: "300", endpoint: "ETH1jsonrpc", error: "failed relay, insufficient results", message: "failed processing responses from RPC endpoints" }),
    log(T0 + 3600, { GUID: "300", served_by: "", stop_reason: "AllProvidersExhausted", status: "0", has_reply: "false", error: "failed relay, insufficient results", message: "relay finished" }),
  ];
  // Found by an old line at T1; its relay_end, written after T1, finds it at T2.
  const END_LANDS_LATER = [
    ...retriedAt("400", T0 - 5100, T0 + 9990),
    relayEnd(T0 + 10_000, "400", { latency_ms: 15_100 }),
  ];
  // Found by one line; its end is no line a finder reads, so only reading the rest of it again shows it.
  const ENDS_UNFOUND = [
    log(T0 - 20_100, { GUID: "500", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_call"}', message: RECEIVED }),
    log(T0 - 20_050, { GUID: "500", chosenProviders: "eth-a", stateful: "0", message: "Choosing providers" }),
    log(T0 - 20_000, { GUID: "500", error: "dial tcp: i/o timeout", error_name: "PROTOCOL_CONNECTION_TIMEOUT", retryable: "true", chain_id: "ETH1", provider: "eth-a", message: CANT_SEND }),
    log(T0 - 19_900, { GUID: "500", chosenProviders: "eth-b", stateful: "0", message: "Choosing providers" }),
    log(T0 + 15_000, { GUID: "500", served_by: "eth-b", stop_reason: "Success", status: "200", has_reply: "true", error: "", message: "relay finished" }),
  ];
  // Its lines from 20 s before T1, which Loki holds only 30 s after their time.
  const ARRIVES_LATE = retriedAt("600", T0 - 20_000, T0 - 19_880, 30_000);
  // Found by lines on both sides of where the window starts at T2.
  const ACROSS_START = [
    log(S2 - 6000, { GUID: "700", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_call"}', message: RECEIVED }),
    log(S2 - 5500, { GUID: "700", chosenProviders: "eth-a", stateful: "0", message: "Choosing providers" }),
    log(S2 - 5000, { GUID: "700", error: "HTTP 429", error_name: "NODE_RATE_LIMITED", retryable: "true", chain_id: "ETH1", provider: "eth-a", message: CANT_SEND }),
    log(S2 - 4990, { GUID: "700", action: "retry", reason: "Default", batchNumber: "1", message: DECIDE }),
    log(S2 - 4900, { GUID: "700", chosenProviders: "eth-b", stateful: "0", message: "Choosing providers" }),
    log(S2 + 5000, { GUID: "700", error: "HTTP 503", error_name: "NODE_UNAVAILABLE", retryable: "true", chain_id: "ETH1", provider: "eth-b", message: CANT_SEND }),
    log(S2 + 5100, { GUID: "700", endpoint: "ETH1jsonrpc", error: "failed relay, insufficient results", message: "failed processing responses from RPC endpoints" }),
    log(S2 + 5200, { GUID: "700", served_by: "", stop_reason: "AllProvidersExhausted", status: "0", has_reply: "false", error: "failed relay, insufficient results", message: "relay finished" }),
  ];
  const LOGS = [
    ...retriedAt("100", S1 + 15_000), // slides out of the window by T2
    ...retriedAt("200", T0 - 10 * MIN),
    ...STRADDLES,
    ...END_LANDS_LATER,
    ...ENDS_UNFOUND,
    ...ARRIVES_LATE,
    ...ACROSS_START,
    relayEnd(T0 - 15 * MIN, "800"),
    relayEnd(T0 + 20_000, "900"), // after T1
    relayEnd(S1 + 5000, "1000"), // slides out of the window by T2
  ];

  it("rows, order, more and nextBefore - with the poll reading only the new stretch", async () => {
    const [first, second] = await pollEach(errorsList(), LOGS, [T1, T2]);
    expect(first!.polled).toEqual(first!.whole);
    // What T1 shows: three requests whose ends hadn't come, and none of what came later.
    const at1 = Object.fromEntries(first!.polled.rows.map((r) => [r.guid, r.result]));
    expect(at1).toEqual({ "100": "recovered", "200": "recovered", "300": "unknown", "400": "unknown", "500": "unknown", "700": "failed", "800": "recovered", "1000": "recovered" });

    expect(second!.polled).toEqual(second!.whole);
    // Newest first by when each request came in: a relay_end's time less its latency.
    expect(second!.polled.rows.map((r) => [r.guid, r.result])).toEqual([
      ["900", "recovered"], ["300", "failed"], ["400", "recovered"], ["600", "recovered"], ["500", "recovered"],
      ["200", "recovered"], ["800", "recovered"], ["700", "failed"],
    ]);
    // 400 is read from its relay_end alone now.
    expect(second!.polled.rows.find((r) => r.guid === "400")?.totalMs).toBe(15_100);
    expect(second!.polled).toMatchObject({ more: false, nextBefore: null, range: { startMs: S2, endMs: T2 } });

    // The poll's finders read from LATE_MS before T1, not from the window's start.
    const finds = second!.reads.filter((r) => !isFollowUp(r));
    expect(finds).toHaveLength(2);
    for (const r of finds) expect([r.startMs, r.endMs]).toEqual([T1 - LATE_MS, T2]);
    // ...and read the rest only of requests whose lines could still come, or that are new.
    expect(followedUp(second!.reads).sort()).toEqual(["300", "500", "600"]);
  });

  it("a request whose end reached Loki after its other lines is read again until it can't still come", async () => {
    // Its end line, 55 s after the line that found it, reaches Loki 35 s late: another stream than the rest.
    const logs = [
      ...retriedAt("1", T0 - 70_000, T0 - 15_000).map((l) => (l.line.includes("relay finished") ? { ...l, readableMs: T0 + 20_000 } : l)),
      ...retriedAt("2", T0 - 10 * MIN),
    ];
    const [first, second] = await pollEach(errorsList(), logs, [T1, T2]);
    expect(first!.polled.rows.map((r) => [r.guid, r.result])).toEqual([["1", "unknown"], ["2", "recovered"]]);
    expect(second!.polled).toEqual(second!.whole);
    expect(second!.polled.rows.map((r) => [r.guid, r.result])).toEqual([["1", "recovered"], ["2", "recovered"]]);
    expect(followedUp(second!.reads)).toEqual(["1"]);
  });

  it("a request ID a client sends again is read again when its new lines come", async () => {
    // The router keeps a request ID the client sent: the same ID, two requests five minutes apart.
    const logs = [...retriedAt("client-7", T0 - 5 * MIN), ...retriedAt("client-7", T0 + 10_000, T0 + 10_120)];
    const [first, second] = await pollEach(errorsList(), logs, [T1, T2]);
    expect(first!.polled).toEqual(first!.whole);
    expect(second!.polled).toEqual(second!.whole);
    // One row - the logs can't tell two requests with one ID apart - with both requests' tries.
    expect(second!.polled.rows.map((r) => [r.guid, r.attempts.length])).toEqual([["client-7", 4]]);
  });

  it("at the cap: the same requests kept, the same place to read on from", async () => {
    // Six requests by their lines (three finder lines each: more than the
    // first finder's 12-line limit holds), four by their relay_end (more than
    // the second's 3), then one more of each after T1.
    const logs = [
      ...[25, 20, 15, 10, 5, 1.5].flatMap((m, i) => retriedAt(String(10 + i), T0 - m * MIN)),
      ...[24, 14, 4, 0.5].map((m, i) => relayEnd(T0 - m * MIN, String(20 + i))),
      ...retriedAt("30", T0 + 10_000),
      relayEnd(T0 + 20_000, "31"),
    ].map((l) => (l.line.includes(DECIDE) ? l : l)).flatMap((l) =>
      // a second failure line per request, so each has three finder lines
      l.line.includes(CANT_SEND) ? [l, { ...l, tsMs: l.tsMs + 0.5, readableMs: l.readableMs + 0.5 }] : [l]);
    const [first, second] = await pollEach(errorsList(3), logs, [T1, T2]);
    expect(first!.polled).toEqual(first!.whole);
    expect(first!.polled.rows.map((r) => r.guid)).toEqual(["23", "15", "22"]);
    expect(first!.polled.more).toBe(true);
    expect(second!.polled).toEqual(second!.whole);
    expect(second!.polled.rows.map((r) => r.guid)).toEqual(["31", "30", "23"]);
    expect(second!.polled.more).toBe(true);
    expect(second!.polled.nextBefore).toBe(second!.whole.nextBefore);
    // Built on T1's read, not read whole.
    expect(second!.reads.filter((r) => !isFollowUp(r)).every((r) => r.startMs === T1 - LATE_MS)).toBe(true);
  });
});

describe("a polled Transactions list answers what a read of its whole window answers", () => {
  const T1 = T0;
  const T2 = T0 + 30_000;
  const S1 = T1 - WINDOW_MS;
  const S2 = T2 - WINDOW_MS;

  const LOGS = [
    ...sentAt("100", S1 + 15_000), // slides out of the window by T2
    ...sentAt("200", T0 - 10 * MIN),
    ...sentAt("300", T0 - 2000, T0 + 3000), // its reply comes after T1
    // Found by its old lines at T1; its relay_end comes after T1.
    ...sentAt("400", T0 - 5000, T0 + 9990),
    txEnd(T0 + 10_000, "400", { latency_ms: 15_000 }),
    txEnd(T0 + 20_000, "500"), // after T1
    ...sentAt("600", T0 - 20_000, T0 - 19_900, 30_000), // Loki holds it 30 s late
    txEnd(S1 + 5000, "700"), // slides out of the window by T2
    txEnd(T0 - 12 * MIN, "800", { outcome: "node_error", error_code: "CHAIN_NONCE_TOO_LOW", error: "nonce too low" }),
    // Received before the window starts at T2; a retry's choice after it.
    log(S2 - 1000, { GUID: "900", path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x03"]}', message: RECEIVED }),
    log(S2 - 990, { GUID: "900", chosenProviders: "eth-a", stateful: "1", message: "Choosing providers" }),
    log(S2 + 2000, { GUID: "900", chosenProviders: "eth-b", stateful: "1", message: "Choosing providers" }),
    log(S2 + 3000, { GUID: "900", served_by: "eth-b", stop_reason: "Stateful", status: "200", has_reply: "true", error: "", message: "relay finished" }),
  ];

  it("rows, totals, more and nextBefore - with the poll reading only the new stretch", async () => {
    const [first, second] = await pollEach(txList(), LOGS, [T1, T2]);
    expect(first!.polled).toEqual(first!.whole);
    expect(Object.fromEntries(first!.polled.rows.map((r) => [r.guid, r.outcome]))).toEqual({
      "100": "accepted", "200": "accepted", "300": "unknown", "400": "unknown", "700": "accepted", "800": "rejected", "900": "accepted",
    });

    expect(second!.polled).toEqual(second!.whole);
    expect(second!.polled.rows.map((r) => [r.guid, r.outcome])).toEqual([
      ["500", "accepted"], ["300", "accepted"], ["400", "accepted"], ["600", "accepted"], ["200", "accepted"], ["800", "rejected"], ["900", "accepted"],
    ]);
    expect(second!.polled.rows.find((r) => r.guid === "400")?.replyMs).toBe(15_000);
    expect(second!.polled).toMatchObject({ total: 7, accepted: 6, rejected: 1, failed: 0, more: false, nextBefore: null });

    const finds = second!.reads.filter((r) => !isFollowUp(r));
    expect(finds).toHaveLength(3);
    for (const r of finds) expect([r.startMs, r.endMs]).toEqual([T1 - LATE_MS, T2]);
    expect(followedUp(second!.reads).sort()).toEqual(["300", "600"]);
  });

  it("at the cap: the same transactions kept, the same place to read on from", async () => {
    const logs = [
      ...[25, 20, 15, 10, 5, 1.5].flatMap((m, i) => sentAt(String(10 + i), T0 - m * MIN)),
      ...[24, 14, 4, 0.5].map((m, i) => txEnd(T0 - m * MIN, String(20 + i))),
      ...sentAt("30", T0 + 10_000),
      txEnd(T0 + 20_000, "31"),
    ];
    const [first, second] = await pollEach(txList(3), logs, [T1, T2]);
    expect(first!.polled).toEqual(first!.whole);
    expect(first!.polled.rows.map((r) => r.guid)).toEqual(["23", "15", "22"]);
    expect(second!.polled).toEqual(second!.whole);
    expect(second!.polled.rows.map((r) => r.guid)).toEqual(["31", "30", "23"]);
    expect(second!.polled).toMatchObject({ more: true });
    expect(second!.reads.filter((r) => !isFollowUp(r)).every((r) => r.startMs === T1 - LATE_MS)).toBe(true);
  });
});

describe("polled every 30 seconds for six minutes over traffic of every shape", () => {
  /** A seeded stream of requests: before #543 and after, failing and not, some ending late, some held late by Loki. */
  function traffic(seed: number, from: number, to: number) {
    let s = seed;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const errors: Logged[] = [];
    const txs: Logged[] = [];
    let n = 0;
    for (let t = from; t < to; t += 2000 + rand() * 9000) {
      const guid = String(1_000_000 + n++);
      const late = rand() < 0.15 ? rand() * 40_000 : 0;
      const span = rand() < 0.3 ? 10_000 + rand() * 40_000 : 50 + rand() * 500;
      const t0 = t + n * 0.001; // no two lines share a time
      // Each log level is its own stream: a request's end can reach Loki later than its other lines -
      // within LATE_MS of its time, which is what a poll allows for.
      const endLate = rand() < 0.15 ? Math.min(LATE_MS - 5000, late + rand() * 40_000) : late;
      const endsLate = (l: Logged) => (l.line.includes("relay finished") ? { ...l, readableMs: l.tsMs + endLate } : l);
      // The newer routers' fields on some events: the caller's, the sizes, the blocks, a transaction's hash and status.
      const caller = rand() < 0.5
        ? { customer: `project-${n % 4}`, request_id: `r-${guid}`, request_bytes: 100 + n, reply_bytes: 2000 + n, requested_block: 19_000_000 + n, seen_block: 19_000_002 + n }
        : {};
      const onChain = rand() < 0.3 ? { tx_status: "failure", tx_error: "execution reverted" } : { tx_status: "success" };
      switch (Math.floor(rand() * 4)) {
        case 0:
          errors.push(...retriedAt(guid, t0, t0 + span, late).map(endsLate));
          break;
        case 1:
          errors.push(relayEnd(t0 + span, guid, { latency_ms: Math.round(span), ...caller }, late));
          break;
        case 2:
          txs.push(...sentAt(guid, t0, rand() < 0.2 ? null : t0 + span, late).map(endsLate));
          break;
        default:
          txs.push(...sentAt(guid, t0, t0 + span - 1, late),
            txEnd(t0 + span, guid, { latency_ms: Math.round(span), tx_hash: `0x${guid.padStart(64, "0")}`, ...onChain, ...caller }));
      }
    }
    return { errors, txs };
  }
  const polls = Array.from({ length: 13 }, (_, i) => T0 + i * 30_000);

  for (const seed of [1, 7, 42]) {
    for (const cap of [5, 40]) {
      it(`errors and transactions, seed ${seed}, cap ${cap}`, async () => {
        const { errors, txs } = traffic(seed, T0 - 35 * MIN, T0 + 7 * MIN);
        for (const { at, polled, whole, reads } of await pollEach(errorsList(cap), errors, polls)) {
          expect(polled, `errors at +${(at - T0) / 1000}s`).toEqual(whole);
          if (at > T0) expect(reads.filter((r) => !isFollowUp(r)).every((r) => r.startMs >= at - 30_000 - LATE_MS)).toBe(true);
        }
        for (const { at, polled, whole, reads } of await pollEach(txList(cap), txs, polls)) {
          expect(polled, `transactions at +${(at - T0) / 1000}s`).toEqual(whole);
          if (at > T0) expect(reads.filter((r) => !isFollowUp(r)).every((r) => r.startMs >= at - 30_000 - LATE_MS)).toBe(true);
        }
      });
    }
  }
});

describe("what a poll can't see", () => {
  it("a request whose rest Loki didn't return is read again by the next poll", async () => {
    const logs = [...retriedAt("1", T0 - 10 * MIN), ...retriedAt("2", T0 - 5000, T0 + 10_000)];
    let refuse = false;
    const { loki } = lokiOf(logs);
    const flaky = {
      labelValues: async () => null,
      volume: (...args: [string, number, number]) => loki.volume(...args),
      queryRange: (query: string, ...rest: [number, number, number, "forward" | "backward"]) =>
        refuse && query.includes('"GUID":"(') ? Promise.resolve(null) : loki.queryRange(query, ...rest),
    } as unknown as LokiClient;
    const svc = new ErrorRequestsService(flaky, SEL, config);
    vi.setSystemTime(T0);
    expect((await svc.report(live())).rows.map((r) => [r.guid, r.result])).toEqual([["2", "unknown"], ["1", "recovered"]]);
    // Request 2 can still change, so the poll reads it again - and Loki doesn't answer.
    refuse = true;
    vi.setSystemTime(T0 + 30_000);
    const missing = await svc.report(live());
    expect(missing).toMatchObject({ available: false, reason: "unreachable" });
    // Kept FAILED_KEEP_MS; then the next poll reads it again, and answers what a whole read does.
    refuse = false;
    vi.setSystemTime(T0 + 30_000 + FAILED_KEEP_MS - 1);
    expect(await svc.report(live())).toBe(missing);
    vi.setSystemTime(T0 + 30_000 + FAILED_KEEP_MS);
    const again = await svc.report(live());
    expect(again).toEqual(await new ErrorRequestsService(lokiOf(logs).loki, SEL, config).report(live()));
    expect(again.rows.map((r) => [r.guid, r.result])).toEqual([["2", "recovered"], ["1", "recovered"]]);
  });

  it("a line Loki holds later than LATE_MS after its time shows from the next whole read on", async () => {
    // Its lines reach Loki 90 s after they were written: past the stretch a poll reads again.
    const logs = [...retriedAt("1", T0 - 10 * MIN), ...retriedAt("2", T0 - 10_000, T0 - 9880, 90_000)];
    const svc = new ErrorRequestsService(lokiOf(logs).loki, SEL, config);
    // Polled every 30 s: by the time Loki holds them, no poll reads that far back.
    for (const t of [T0, T0 + 30_000, T0 + 60_000, T0 + 90_000]) {
      vi.setSystemTime(t);
      expect((await svc.report(live())).rows.map((r) => r.guid)).toEqual(["1"]);
    }
    vi.setSystemTime(T0 + HEAD_FRESH_MS + LIVE_KEEP_MS);
    expect((await svc.report(live())).rows.map((r) => r.guid)).toEqual(["2", "1"]);
  });
});

describe("when a poll reads the window whole", () => {
  const logs = [...retriedAt("1", T0 - 10 * MIN), relayEnd(T0 - 5 * MIN, "2")];
  const findsFrom = (reads: Read[]) => [...new Set(reads.filter((r) => !isFollowUp(r)).map((r) => r.startMs))];

  it("on its first read, and once its last whole read is HEAD_FRESH_MS old", async () => {
    const { loki, reads } = lokiOf(logs);
    const svc = new ErrorRequestsService(loki, SEL, config);
    vi.setSystemTime(T0);
    await svc.report(live());
    expect(findsFrom(reads)).toEqual([T0 - WINDOW_MS]);
    // A poll as each answer expires, building on the last, until the whole read is HEAD_FRESH_MS old.
    let t = T0;
    while (t + LIVE_KEEP_MS <= T0 + HEAD_FRESH_MS) {
      t += LIVE_KEEP_MS;
      vi.setSystemTime(t);
      reads.length = 0;
      await svc.report(live());
      expect(findsFrom(reads)).toEqual([t - LIVE_KEEP_MS - LATE_MS]);
    }
    t += LIVE_KEEP_MS;
    vi.setSystemTime(t);
    reads.length = 0;
    await svc.report(live());
    expect(findsFrom(reads)).toEqual([t - WINDOW_MS]);
    // ...and the next poll builds on that one.
    vi.setSystemTime(t + LIVE_KEEP_MS);
    reads.length = 0;
    await svc.report(live());
    expect(findsFrom(reads)).toEqual([t - LATE_MS]);
  });

  it("once more lists are polled than HEADS_KEPT: the one read longest ago", async () => {
    const { loki, reads } = lokiOf(logs);
    const svc = new ErrorRequestsService(loki, SEL, config);
    const windows = ["5m", "15m", "30m", "1h", "3h", "6h", "12h", "1d", "3d", "7d"].slice(0, HEADS_KEPT + 1);
    vi.setSystemTime(T0);
    for (const w of windows) await svc.report(live(w));
    vi.setSystemTime(T0 + LIVE_KEEP_MS);
    reads.length = 0;
    await svc.report(live(windows[1]));
    expect(findsFrom(reads)).toEqual([T0 - LATE_MS]);
    reads.length = 0;
    await svc.report(live(windows[0]));
    expect(findsFrom(reads)).toEqual([T0 + LIVE_KEEP_MS - 5 * MIN]);
  });

  it("when the values file changed: a row's chain and router come from it", async () => {
    let routers = config.getRouters();
    const cfg = { getRouters: () => routers } as unknown as ConfigurationService;
    const { loki, reads } = lokiOf(logs);
    const svc = new ErrorRequestsService(loki, SEL, cfg);
    vi.setSystemTime(T0);
    await svc.report(live());
    routers = [...routers, { id: "base", spec: "BASE", nodes: [node("base-a")] }] as typeof routers;
    vi.setSystemTime(T0 + 30_000);
    reads.length = 0;
    await svc.report(live());
    expect(findsFrom(reads)).toEqual([T0 + 30_000 - WINDOW_MS]);
  });

  it("when the merge can't tell: lines the last read held are gone from Loki", async () => {
    // Twelve finder lines in the last minute: the first finder's limit at cap 3.
    const busy = [0, 1, 2, 3].flatMap((i) => retriedAt(String(50 + i), T0 - 50_000 + i * 1000)).flatMap((l) =>
      l.line.includes(CANT_SEND) ? [l, { ...l, tsMs: l.tsMs + 0.5, readableMs: l.readableMs + 0.5 }] : [l]);
    const held = [...busy, ...retriedAt("40", T0 - 10 * MIN)];
    const { loki, reads } = lokiOf(held);
    const svc = new ErrorRequestsService(loki, SEL, config, 3);
    vi.setSystemTime(T0);
    await svc.report(live());
    held.splice(0, busy.length); // a retention cut, say: the poll finds fewer lines than the head held there
    vi.setSystemTime(T0 + 30_000);
    reads.length = 0;
    const r = await svc.report(live());
    expect(findsFrom(reads)).toEqual([T0 - LATE_MS, T0 + 30_000 - WINDOW_MS]);
    expect(r).toEqual(await new ErrorRequestsService(lokiOf(held).loki, SEL, config, 3).report(live()));
  });
});

describe("a whole read that starts later than the window - a cap on what one read scans", () => {
  const plan = (fromMs: number): ListPlan<ErrorRequestRow> => ({
    finders: [{ query: `${SEL} |~ \`${CANT_SEND}\``, limit: 40 }],
    follow: { messages: Object.values(ERROR_MSG), perGuid: 40, beforeMs: MIN, afterMs: MIN },
    cap: 10,
    rowsOf: (lines) => buildErrorRows(lines, new UpstreamIndex([])),
    basis: "",
    wholeFrom: async () => fromMs,
  });
  const logs = [...retriedAt("1", T0 - 4 * MIN), ...retriedAt("2", T0 - 90_000), ...retriedAt("3", T0 - 20_000)];

  it("leaves the stretch before its start to the next, older read; the polls built on it keep that cut", async () => {
    const { loki, reads } = lokiOf(logs);
    const floor = T0 - 2 * MIN;
    vi.setSystemTime(T0);
    const whole = await readList(loki, SEL, plan(floor), live("5m"));
    expect(reads[0]).toMatchObject({ startMs: floor, endMs: T0 });
    expect(whole!.read.rows.map((r) => r.guid)).toEqual(["3", "2"]);
    expect(whole!.read.nextBefore).toBeCloseTo(floor + 0.001, 6);
    // A poll reads only the new stretch, and still reads on below the floor.
    vi.setSystemTime(T0 + 30_000);
    reads.length = 0;
    const polled = await readList(loki, SEL, plan(floor), live("5m"), whole!.head);
    expect(reads[0]).toMatchObject({ startMs: T0 - LATE_MS });
    expect(polled!.read.rows.map((r) => r.guid)).toEqual(["3", "2"]);
    expect(polled!.read.nextBefore).toBeCloseTo(floor + 0.001, 6);
    // Once the window starts after the floor, nothing in it is unread.
    vi.setSystemTime(T0 + 3.5 * MIN);
    const later = await readList(loki, SEL, plan(floor), live("5m"), polled!.head);
    expect(later!.read.rows.map((r) => r.guid)).toEqual(["3", "2"]);
    expect(later!.read.nextBefore).toBeNull();
  });

  it("the lists weigh a whole read against the budget, and a poll neither weighs nor loses where it started", async () => {
    // The index says the window is three budgets: a whole read covers its newest third.
    const { loki, reads, weighed } = lokiOf(logs, () => false, (a, b) => ((b - a) / (10 * MIN)) * LOG_READ_BUDGET_BYTES);
    const svc = new ErrorRequestsService(loki, SEL, config);
    vi.setSystemTime(T0);
    const whole = await svc.report(live());
    expect(reads.filter((r) => !isFollowUp(r)).map((r) => r.startMs)).toEqual([T0 - 10 * MIN, T0 - 10 * MIN]);
    expect(whole.nextBefore).toBeCloseTo(T0 - 10 * MIN + 0.001, 6);
    const weighs = weighed.length;
    vi.setSystemTime(T0 + 30_000);
    reads.length = 0;
    const polled = await svc.report(live());
    expect(weighed).toHaveLength(weighs);
    expect(reads.filter((r) => !isFollowUp(r)).every((r) => r.startMs === T0 - LATE_MS)).toBe(true);
    expect(polled).toMatchObject({ more: true });
    expect(polled.nextBefore).toBeCloseTo(T0 - 10 * MIN + 0.001, 6);
    expect(polled.rows.map((r) => r.guid)).toEqual(whole.rows.map((r) => r.guid));
  });

  it("finding nothing after its start still says where to read on", async () => {
    vi.setSystemTime(T0);
    const got = await readList(lokiOf(logs.filter((l) => l.tsMs < T0 - 3 * MIN)).loki, SEL, plan(T0 - 2 * MIN), live("5m"));
    expect(got!.read).toMatchObject({ found: false, rows: [] });
    expect(got!.read.nextBefore).toBeCloseTo(T0 - 2 * MIN + 0.001, 6);
  });
});

describe("one read per list on this process", () => {
  const logs = [...retriedAt("1", T0 - 10 * MIN), relayEnd(T0 - 5 * MIN, "2")];
  const finds = (reads: Read[]) => reads.filter((r) => !isFollowUp(r)).length;

  it("viewers of a live list share one read, and its answer for LIVE_KEEP_MS", async () => {
    const { loki, reads } = lokiOf(logs);
    const svc = new ErrorRequestsService(loki, SEL, config);
    vi.setSystemTime(T0);
    const [a, b, c] = await Promise.all([svc.report(live()), svc.report(live()), svc.report(live())]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(finds(reads)).toBe(2);
    vi.setSystemTime(T0 + LIVE_KEEP_MS - 1);
    expect(await svc.report(live())).toBe(a);
    expect(finds(reads)).toBe(2);
    vi.setSystemTime(T0 + LIVE_KEEP_MS);
    expect(await svc.report(live())).toEqual({ ...a, range: { startMs: T0 + LIVE_KEEP_MS - WINDOW_MS, endMs: T0 + LIVE_KEEP_MS } });
    expect(finds(reads)).toBe(4);
    // Another chain is another list.
    await svc.report(live(), "ETH1");
    expect(finds(reads)).toBe(6);
  });

  it("the Transactions list too", async () => {
    const { loki, reads } = lokiOf(sentAt("1", T0 - MIN));
    const svc = new TransactionsService(loki, SEL, config);
    vi.setSystemTime(T0);
    const [a, b] = await Promise.all([svc.report(live()), svc.report(live())]);
    expect(b).toBe(a);
    expect(finds(reads)).toBe(3);
  });

  it("a read Loki didn't answer is kept FAILED_KEEP_MS, so polls don't ask it again", async () => {
    let down = true;
    const { loki, reads } = lokiOf(logs, () => down);
    const svc = new ErrorRequestsService(loki, SEL, config);
    vi.setSystemTime(T0);
    expect(await svc.report(live())).toMatchObject({ available: false, reason: "unreachable" });
    down = false;
    vi.setSystemTime(T0 + FAILED_KEEP_MS - 1);
    expect(await svc.report(live())).toMatchObject({ available: false });
    expect(finds(reads)).toBe(2);
    vi.setSystemTime(T0 + FAILED_KEEP_MS);
    expect(await svc.report(live())).toMatchObject({ available: true, rows: [{ guid: "2" }, { guid: "1" }] });
  });

  it("a range that has settled is kept SETTLED_KEEP_MS; one that ended within LATE_MS, LIVE_KEEP_MS", async () => {
    const { loki, reads } = lokiOf(logs);
    const svc = new ErrorRequestsService(loki, SEL, config);
    vi.setSystemTime(T0);
    const settled = { startMs: T0 - 20 * MIN, endMs: T0 - 2 * MIN };
    const recent = { startMs: T0 - 20 * MIN, endMs: T0 - 1000 };
    await svc.report(settled);
    await svc.report(recent);
    expect(finds(reads)).toBe(4);
    vi.setSystemTime(T0 + LIVE_KEEP_MS);
    await svc.report(settled);
    await svc.report(recent);
    expect(finds(reads)).toBe(6);
    vi.setSystemTime(T0 + SETTLED_KEEP_MS);
    await svc.report(settled);
    expect(finds(reads)).toBe(8);
  });

  it("each read on with Load older is its own key: the range it continues, and where", async () => {
    const { loki, reads } = lokiOf(logs);
    const svc = new ErrorRequestsService(loki, SEL, config);
    vi.setSystemTime(T0);
    const range = { startMs: T0 - 20 * MIN, endMs: T0 - 2 * MIN };
    const older = await svc.report(range, undefined, undefined, T0 - 6 * MIN);
    expect(older.rows.map((r) => r.guid)).toEqual(["1"]);
    expect(await svc.report(range, undefined, undefined, T0 - 6 * MIN)).toBe(older);
    expect((await svc.report(range)).rows.map((r) => r.guid)).toEqual(["2", "1"]);
    expect(finds(reads)).toBe(4);
  });
});

describe("keepFor", () => {
  it("a failure briefly, a live list briefly, a settled range long", () => {
    expect(keepFor({ available: false }, true, T0, T0)).toBe(FAILED_KEEP_MS);
    expect(keepFor({ available: true, unread: 3 }, false, T0 - 10 * MIN, T0)).toBe(FAILED_KEEP_MS);
    expect(keepFor({ available: true }, true, T0, T0)).toBe(LIVE_KEEP_MS);
    expect(keepFor({ available: true }, false, T0 - LATE_MS + 1, T0)).toBe(LIVE_KEEP_MS);
    expect(keepFor({ available: true }, false, T0 - LATE_MS, T0)).toBe(SETTLED_KEEP_MS);
  });
});
