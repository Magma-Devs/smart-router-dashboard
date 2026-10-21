import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { RouterTopology, TxResult } from "@sr/shared";
import { buildApp } from "../app.js";
import { RECORDED_TX, TransactionsOverTimeService } from "../services/transactions-over-time.js";
import { buildTxRows, TX_EVENT_FILTER, txResultOf } from "../services/transactions.js";
import { parseRouterLine, UpstreamIndex, type RouterLine } from "../services/router-log.js";
import type { PrometheusClient, PromMatrixSample, PromVectorSample } from "../services/prometheus-client.js";
import type { LokiClient, LokiLine, LokiSeries } from "../services/loki-client.js";
import type { ConfigurationService } from "../services/configuration.js";

/* The clock: 430 s into a 10-minute bar. A 1 h window is seven bars of
   10 minutes, on the clock (bucketGrid): the first ends at START, the sixth
   at T0, the seventh is still filling. The recorded counts are read up to
   two minutes ago, rounded down to the minute (LAG_FROM): the bar ending at
   T0 whole, the running one up to LAG_FROM. The ruler evaluates at second 17
   of each minute (WRITTEN is a sample it wrote), so its newest count read
   ends at COVERED, and the logs count from there. */
const T0 = 1_760_000_400; // a multiple of 600
const NOW = T0 + 430;
const START = T0 - 5 * 600;
const LAG_FROM = T0 + 300;
const WRITTEN = LAG_FROM - 120 + 17;
const COVERED = LAG_FROM + 17 - 30;
const SEL = '{component="router"}';
const BY = "cluster, service_name, api_interface, outcome, tx_status, tx_refused";

const node = (name: string) => ({ name, endpoints: [{ interface: "jsonrpc" }] });
const ROUTERS = [
  { id: "eth-prod", spec: "ETH1", nodes: [node("eth-a")] },
  { id: "eth-canary", spec: "ETH1", nodes: [node("eth-b")] },
  { id: "Sui", spec: "SUI", nodes: [node("sui-a")] },
] as unknown as RouterTopology[];
const cfg = { getRouters: () => ROUTERS } as unknown as ConfigurationService;

interface Calls { prom: string[]; loki: string[] }

/** A store that answers the range read with `matrix`, the instant read with
 *  `vector`, and the newest sample's timestamp with `written` (none: no sample
 *  in the lookback); null = no answer. */
function promOf(matrix: PromMatrixSample[] | null, vector: PromVectorSample[] | null, calls: Calls, written: number | null = WRITTEN) {
  return {
    async queryRangeOrNull(expr: string, start: number, end: number, step: string) {
      calls.prom.push(`range ${expr} ${start} ${end} ${step}`);
      return matrix;
    },
    async queryAtOrNull(expr: string, time: number) {
      calls.prom.push(`at ${expr} ${time}`);
      if (expr.startsWith("max(timestamp(")) return vector === null ? null : written === null ? [] : [{ metric: {}, value: [time, String(written)] }];
      return vector;
    },
  } as unknown as PrometheusClient;
}

/** A Loki that answers metric range reads with `range` and instant ones with `now`; null = no answer. */
function lokiOf(range: LokiSeries[] | null, now: LokiSeries[] | null, calls: Calls) {
  return {
    async metricRange(query: string, start: number, end: number, step: number) {
      calls.loki.push(`range ${query} ${start} ${end} ${step}`);
      return range;
    },
    async metricAt(query: string, time: number) {
      calls.loki.push(`at ${query} ${time}`);
      return now;
    },
  } as unknown as LokiClient;
}

const m = (metric: Record<string, string>, values: [number, string][]): PromMatrixSample => ({ metric, values });
const v = (metric: Record<string, string>, at: number, n: string): PromVectorSample => ({ metric, value: [at, n] });
const eth = (labels: Record<string, string>) => ({ cluster: "demo", service_name: "demo-eth-prod", api_interface: "jsonrpc", ...labels });
const bars = (fill: Record<number, number>) => Array.from({ length: 7 }, (_, i) => fill[i] ?? 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => vi.useRealTimers());

describe("a transaction's result, as the list and the chart both map it", () => {
  const of = (outcome: string, more: Partial<Parameters<typeof txResultOf>[0]> = {}): TxResult =>
    txResultOf({ outcome, txRefused: false, apiInterface: "jsonrpc", ...more });

  it("by the event's outcome, and on ok by what the reply said", () => {
    expect(of("write_unknown")).toBe("unknown");
    expect(of("node_error")).toBe("rejected");
    expect(["no_answer", "rejected_before_dispatch", "router_error"].map((o) => of(o))).toEqual(["failed", "failed", "failed"]);
    expect(of("ok")).toBe("accepted");
    expect(of("ok", { txRefused: true, apiInterface: "tendermintrpc" })).toBe("rejected");
    expect(of("ok", { apiInterface: "grpc" })).toBe("unknown"); // no code read out of a protobuf reply
    expect(of("ok", { apiInterface: "grpc", txStatus: "success" })).toBe("accepted");
    expect(of("ok", { txStatus: "failure" })).toBe("failed-on-chain");
    expect(of("ok", { txStatus: "success" })).toBe("accepted");
    expect(of("something_new")).toBe("unknown");
  });

  it("the list's rows agree with it", () => {
    const ev = (guid: string, f: Record<string, unknown>): LokiLine => ({
      tsMs: 1000, line: JSON.stringify({ event: "relay_end", schema: 1, GUID: guid, stateful: true, method: "eth_sendRawTransaction", chain: "ETH1", api_interface: "jsonrpc", error: "", error_code: "", served_by: "", latency_ms: 5, ...f, message: "relay_end" }),
    });
    const lines = [
      ev("1", { outcome: "ok", served_by: "eth-a" }),
      ev("2", { outcome: "node_error", error_code: "CHAIN_NONCE_TOO_LOW", error: "nonce too low" }),
      ev("3", { outcome: "no_answer", error: "failed relay" }),
      ev("4", { outcome: "write_unknown" }),
      ev("5", { outcome: "ok", api_interface: "tendermintrpc", tx_code: 5 }),
      ev("6", { outcome: "ok", api_interface: "grpc" }),
      ev("7", { outcome: "ok", api_interface: "tendermintrpc", tx_code: 0 }),
    ];
    const rows = buildTxRows(lines.map(parseRouterLine).filter((l): l is RouterLine => l !== null), new UpstreamIndex(ROUTERS));
    const byGuid = Object.fromEntries(rows.map((r) => [r.guid, r.outcome]));
    const facts = lines.map((l) => JSON.parse(l.line) as { GUID: string; outcome: string; api_interface: string; tx_code?: number });
    for (const f of facts) {
      expect(byGuid[f.GUID]).toBe(txResultOf({ outcome: f.outcome, txRefused: (f.tx_code ?? 0) !== 0, apiInterface: f.api_interface }));
    }
  });
});

describe("transactions over time, from the store's recorded counts", () => {
  const MATRIX = [
    // Each bar's samples read 30 s after it ends.
    m(eth({ outcome: "ok" }), [[START + 30, "3"], [T0 + 30, "2"]]),
    m(eth({ outcome: "node_error" }), [[T0 + 30, "1"]]),
    m({ ...eth({ outcome: "ok", tx_refused: "true" }), api_interface: "tendermintrpc" }, [[START + 600 + 30, "1"]]),
  ];
  const VECTOR = [v(eth({ outcome: "write_unknown" }), LAG_FROM + 30, "1")];
  // The newest minutes from the logs: label_format leaves an empty tx_refused, which is none.
  const TAIL: LokiSeries[] = [{ metric: { outcome: "ok", api_interface: "jsonrpc", tx_refused: "" }, values: [[COVERED + 60, 1]] }];
  const RUNNING: LokiSeries[] = [{ metric: { outcome: "ok", api_interface: "jsonrpc", tx_status: "failure", tx_refused: "" }, values: [[NOW, 1]] }];

  it("reads the whole bars, then the running one up to two minutes ago, then the lines since from the logs", async () => {
    const calls: Calls = { prom: [], loki: [] };
    const svc = new TransactionsOverTimeService(promOf(MATRIX, VECTOR, calls), lokiOf(TAIL, RUNNING, calls), SEL, cfg);
    const r = await svc.overTime("1h", "ETH1");
    expect(calls.prom).toEqual([
      `range sum by (${BY}) (sum_over_time(${RECORDED_TX}{chain="eth1"}[600s])) ${START + 30} ${T0 + 30} 600s`,
      `at sum by (${BY}) (sum_over_time(${RECORDED_TX}{chain="eth1"}[300s])) ${LAG_FROM + 30}`,
      `at max(timestamp(${RECORDED_TX}{chain="eth1"})) ${LAG_FROM + 30}`,
    ]);
    const count = (range: number) =>
      `sum by (api_interface, outcome, tx_status, tx_refused) (count_over_time(${SEL} ${TX_EVENT_FILTER} |= \`"chain":"ETH1"\`` +
      ' | json outcome="outcome", tx_status="tx_status", tx_code="tx_code", api_interface="api_interface" | __error__=""' +
      ` | label_format tx_refused=\`{{ if and .tx_code (ne .tx_code "0") }}true{{ end }}\` [${range}s]))`;
    // From where the ruler's newest count ends, a minute at a time, then the seconds since.
    expect(calls.loki).toEqual([`range ${count(60)} ${COVERED + 60} ${COVERED + 120} 60`, `at ${count(NOW - COVERED - 120)} ${NOW}`]);
    expect(r).toMatchObject({ available: true, source: "recorded", partialFrom: null, asOf: NOW, grid: { start: START, end: T0 + 600, stepSec: 600 } });
    expect(r.counts).toEqual({
      accepted: bars({ 0: 3, 5: 2, 6: 1 }),
      rejected: bars({ 1: 1, 5: 1 }),
      unknown: bars({ 6: 1 }),
      "failed-on-chain": bars({ 6: 1 }),
    });
  });

  it("the newest minutes the logs didn't count are marked, not shown short in silence", async () => {
    const calls: Calls = { prom: [], loki: [] };
    const r = await new TransactionsOverTimeService(promOf(MATRIX, VECTOR, calls), lokiOf(null, RUNNING, calls), SEL, cfg).overTime("1h", "ETH1");
    expect(r).toMatchObject({ source: "recorded", partialFrom: COVERED });
    expect(r.counts.accepted).toEqual(bars({ 0: 3, 5: 2 }));
    const noLoki = await new TransactionsOverTimeService(promOf(MATRIX, VECTOR, calls), null, SEL, cfg).overTime("1h", "ETH1");
    expect(noLoki).toMatchObject({ available: true, source: "recorded", partialFrom: COVERED });
  });

  it("with no sample in the five minutes before, nothing recorded ends there: the logs count from a minute back", async () => {
    const calls: Calls = { prom: [], loki: [] };
    await new TransactionsOverTimeService(promOf(MATRIX, VECTOR, calls, null), lokiOf(TAIL, RUNNING, calls), SEL, cfg).overTime("1h", "ETH1");
    expect(calls.loki[0]).toMatch(new RegExp(` ${LAG_FROM} ${LAG_FROM + 120} 60$`));
  });

  it("is kept for 30 seconds: every open page shares one read", async () => {
    const calls: Calls = { prom: [], loki: [] };
    const svc = new TransactionsOverTimeService(promOf(MATRIX, VECTOR, calls), lokiOf(TAIL, RUNNING, calls), SEL, cfg);
    await svc.overTime("1h", "ETH1");
    await svc.overTime("1h", "ETH1");
    expect(calls.prom).toHaveLength(3);
    vi.setSystemTime((NOW + 31) * 1000);
    await svc.overTime("1h", "ETH1");
    expect(calls.prom).toHaveLength(6);
  });
});

describe("transactions over time, where the store records none", () => {
  const WHOLE: LokiSeries[] = [
    { metric: { outcome: "ok", api_interface: "jsonrpc", tx_refused: "" }, values: [[START, 4], [T0, 1]] },
    { metric: { outcome: "no_answer", api_interface: "jsonrpc", tx_refused: "" }, values: [[T0 - 600, 2]] },
  ];
  const FILLING: LokiSeries[] = [{ metric: { outcome: "write_unknown", api_interface: "jsonrpc" }, values: [[NOW, 1]] }];

  it("counts the whole window from the logs, with the same filter: the whole bars, then the one filling", async () => {
    const calls: Calls = { prom: [], loki: [] };
    const r = await new TransactionsOverTimeService(promOf([], [], calls), lokiOf(WHOLE, FILLING, calls), SEL, cfg).overTime("1h");
    const count = (range: number) =>
      `sum by (api_interface, outcome, tx_status, tx_refused) (count_over_time(${SEL} ${TX_EVENT_FILTER}` +
      ' | json outcome="outcome", tx_status="tx_status", tx_code="tx_code", api_interface="api_interface" | __error__=""' +
      ` | label_format tx_refused=\`{{ if and .tx_code (ne .tx_code "0") }}true{{ end }}\` [${range}s]))`;
    expect(calls.loki).toEqual([`range ${count(600)} ${START} ${T0} 600`, `at ${count(430)} ${NOW}`]);
    expect(calls.prom[0]).toContain(`(sum_over_time(${RECORDED_TX}[600s]))`); // no chain asked for
    expect(r).toMatchObject({ available: true, source: "logs", partialFrom: null });
    expect(r.counts).toEqual({ accepted: bars({ 0: 4, 5: 1 }), failed: bars({ 4: 2 }), unknown: bars({ 6: 1 }) });
  });

  it("a store that doesn't answer is read around the same way; logs that don't answer are 'not available', never zero", async () => {
    const calls: Calls = { prom: [], loki: [] };
    expect(await new TransactionsOverTimeService(promOf(null, null, calls), lokiOf(WHOLE, FILLING, calls), SEL, cfg).overTime("1h"))
      .toMatchObject({ available: true, source: "logs" });
    expect(await new TransactionsOverTimeService(promOf([], [], calls), lokiOf(null, FILLING, calls), SEL, cfg).overTime("3h"))
      .toMatchObject({ available: false, reason: "unreachable", counts: {} });
    expect(await new TransactionsOverTimeService(promOf([], [], calls), null, SEL, cfg).overTime("1h"))
      .toMatchObject({ available: false, reason: "unconfigured" });
  });
});

describe("transactions over time, for a router", () => {
  const SIBLINGS = [
    m(eth({ outcome: "ok" }), [[T0 + 30, "2"]]),
    m(eth({ outcome: "ok", service_name: "demo-eth-canary" }), [[T0 + 30, "7"]]),
  ];

  it("alone on its chain, it is its chain: no split needed", async () => {
    const calls: Calls = { prom: [], loki: [] };
    const sui = [m({ cluster: "demo", service_name: "demo-sui", api_interface: "jsonrpc", outcome: "ok", tx_status: "success" }, [[T0 + 30, "5"]])];
    const r = await new TransactionsOverTimeService(promOf(sui, [], calls), lokiOf([], [], calls), SEL, cfg).overTime("1h", undefined, "Sui");
    expect(calls.prom[0]).toContain(`${RECORDED_TX}{chain="sui"}`);
    expect(calls.loki[0]).toContain(`${SEL} ${TX_EVENT_FILTER} |= \`"chain":"SUI"\``);
    expect(r.counts).toEqual({ accepted: bars({ 5: 5 }) });
  });

  it("sharing its chain, its own counts by service_name - <tenant>-<router id> - and its own newest minutes", async () => {
    const calls: Calls = { prom: [], loki: [] };
    const r = await new TransactionsOverTimeService(promOf(SIBLINGS, [], calls), lokiOf([], [], calls), SEL, cfg).overTime("1h", undefined, "eth-prod");
    expect(r).toMatchObject({ available: true, source: "recorded", partialFrom: null });
    expect(r.counts).toEqual({ accepted: bars({ 5: 2 }) });
    expect(calls.loki[0]).toContain('{component="router", service_name="demo-eth-prod"}');
    const canary = await new TransactionsOverTimeService(promOf(SIBLINGS, [], calls), lokiOf([], [], calls), SEL, cfg).overTime("1h", undefined, "eth-canary");
    expect(canary.counts).toEqual({ accepted: bars({ 5: 7 }) });
  });

  it("sharing its chain with nothing of its own recorded: none of its newest minutes can be told apart either", async () => {
    const calls: Calls = { prom: [], loki: [] };
    const r = await new TransactionsOverTimeService(promOf([SIBLINGS[1]!], [], calls), lokiOf([], [], calls), SEL, cfg).overTime("1h", undefined, "eth-prod");
    expect(r).toMatchObject({ available: true, counts: {}, partialFrom: COVERED });
    expect(calls.loki).toEqual([]);
  });

  it("sharing its chain, when no count names a router the values file has, or only the logs can answer: shared-chain", async () => {
    const calls: Calls = { prom: [], loki: [] };
    const unnamed = [m(eth({ outcome: "ok", service_name: "other-eth" }), [[T0 + 30, "2"]])];
    expect(await new TransactionsOverTimeService(promOf(unnamed, [], calls), lokiOf([], [], calls), SEL, cfg).overTime("1h", undefined, "eth-prod"))
      .toMatchObject({ available: false, reason: "shared-chain", counts: {} });
    const before = calls.loki.length;
    expect(await new TransactionsOverTimeService(promOf([], [], calls), lokiOf([], [], calls), SEL, cfg).overTime("1h", undefined, "eth-prod"))
      .toMatchObject({ available: false, reason: "shared-chain" });
    expect(calls.loki).toHaveLength(before); // the logs aren't read for an answer they can't give
  });

  it("an unknown router, one off the chain asked for, or a chain that isn't a plain token: nothing, without a read", async () => {
    const calls: Calls = { prom: [], loki: [] };
    const svc = new TransactionsOverTimeService(promOf(SIBLINGS, [], calls), lokiOf([], [], calls), SEL, cfg);
    expect(await svc.overTime("1h", undefined, "nope")).toMatchObject({ available: true, counts: {}, source: null });
    expect(await svc.overTime("1h", "SUI", "eth-prod")).toMatchObject({ available: true, counts: {} });
    expect(await svc.overTime("1h", 'ETH1"} or vector(1) #')).toMatchObject({ available: true, counts: {} });
    expect(calls).toEqual({ prom: [], loki: [] });
  });
});

describe("GET /api/transactions/over-time", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
    delete process.env.LOKI_URL;
    vi.unstubAllGlobals();
  });

  it("answers with the bars; a chain that isn't a plain token is a 400", async () => {
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/api/v1/query_range") && url.searchParams.get("query")?.includes(RECORDED_TX)) {
        return Response.json({ status: "success", data: { resultType: "matrix", result: [{ metric: eth({ outcome: "ok" }), values: [[T0 + 30, "2"]] }] } });
      }
      return Response.json({ status: "success", data: { resultType: "vector", result: [] } });
    });
    process.env.LOKI_URL = "http://loki.test:3100";
    app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/transactions/over-time?spec=ETH1%60" })).statusCode).toBe(400);
    const res = await app.inject({ method: "GET", url: "/api/transactions/over-time?window=1h&spec=ETH1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, source: "recorded", counts: { accepted: bars({ 5: 2 }) } });
  });
});
