import { afterEach, describe, expect, it, vi } from "vitest";
import { PrometheusClient, RANGE_REUSE_MAX_MS, RANGE_SETTLE_MS, buildAuthHeaders, type PromLogger } from "../services/prometheus-client.js";

/**
 * Records every fetch the client makes so a test can assert on the exact
 * headers sent. Answers every query with a one-sample vector.
 */
function captureFetch(status = 200, body = "unauthorized") {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });
    if (status !== 200) return new Response(body, { status });
    return Response.json({
      status: "success",
      data: { resultType: "vector", result: [{ metric: {}, value: [1, "1"] }] },
    });
  });
  return calls;
}

const BASE = "http://prom.test:9090";
const AUTH = { username: "tenant-a", password: "s3cret", orgId: "tenant-a" };
const ZONE = { label: "zone", value: "eu-west" };

/** The PromQL the client actually sent on call `i`. */
const sentQuery = (calls: { url: string }[], i = 0): string | null =>
  new URL(calls[i]!.url).searchParams.get("query");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("buildAuthHeaders", () => {
  it("sends nothing when nothing is configured", () => {
    expect(buildAuthHeaders({})).toEqual({});
  });

  it("needs BOTH halves of the basic-auth pair", () => {
    expect(buildAuthHeaders({ username: "u" })).toEqual({});
    expect(buildAuthHeaders({ password: "p" })).toEqual({});
    expect(buildAuthHeaders({ username: "u", password: "p" })).toEqual({
      Authorization: `Basic ${Buffer.from("u:p").toString("base64")}`,
    });
  });

  it("maps orgId to X-Scope-OrgID independently of the credential", () => {
    expect(buildAuthHeaders({ orgId: "acme" })).toEqual({ "X-Scope-OrgID": "acme" });
  });
});

describe("PrometheusClient auth", () => {
  it("attaches the headers to instant and range queries", async () => {
    const calls = captureFetch();
    const client = new PrometheusClient(BASE, 1000, null, AUTH);
    await client.query("up");
    await client.queryRange("up", 0, 60, "15s");

    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.headers.Authorization).toBe(`Basic ${Buffer.from("tenant-a:s3cret").toString("base64")}`);
      expect(c.headers["X-Scope-OrgID"]).toBe("tenant-a");
    }
  });

  it("sends no auth headers at all when unconfigured — today's behaviour", async () => {
    const calls = captureFetch();
    await new PrometheusClient(BASE, 1000, null, {}).query("up");
    expect(calls[0]?.headers).toEqual({});
  });

  it("keeps the credential through withScope", async () => {
    const calls = captureFetch();
    const scoped = new PrometheusClient(BASE, 1000, null, AUTH).withScope({ label: "service", value: "eth" });
    await scoped.query("up");
    expect(calls[0]?.headers["X-Scope-OrgID"]).toBe("tenant-a");
    expect(calls[0]?.headers.Authorization).toBeDefined();
  });

  it("readiness is an instant query that carries the credential", async () => {
    const calls = captureFetch();
    expect(await new PrometheusClient(BASE, 1000, null, AUTH).ping()).toBe(true);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/query");
    expect(url.searchParams.get("query")).toBe("vector(1)");
    expect(calls[0]?.headers.Authorization).toBeDefined();
  });

  it("readiness fails on a rejected credential", async () => {
    captureFetch(401);
    expect(await new PrometheusClient(BASE, 1000, null, AUTH).ping()).toBe(false);
  });
});

describe("PrometheusClient deployment scope (METRICS_SCOPE_*)", () => {
  it("puts the matcher on instant and range queries", async () => {
    const calls = captureFetch();
    const client = new PrometheusClient(BASE, 1000, null, {}, { baseScope: ZONE });
    await client.query('sum(smartrouter_requests_total{spec="ETH1"})');
    await client.queryRange("rate(smartrouter_requests_total[5m])", 0, 60, "15s");

    expect(sentQuery(calls, 0)).toBe('sum(smartrouter_requests_total{zone="eu-west",spec="ETH1"})');
    expect(sentQuery(calls, 1)).toBe('rate(smartrouter_requests_total{zone="eu-west"}[5m])');
  });

  it("reaches the cache sidecar's families, which the router scope leaves alone", async () => {
    const calls = captureFetch();
    // Both reads end up as the same URL (that is the point), so the second
    // would be answered from memory — keep every read live to see it sent.
    const base = new PrometheusClient(BASE, 1000, null, {}, { baseScope: ZONE, cacheTtlMs: 0 });
    await base.query("increase(cache_total_hits[300s])");
    await base.withScope({ label: "service", value: "eth-router" }).query("increase(cache_total_hits[300s])");

    expect(sentQuery(calls, 0)).toBe('increase(cache_total_hits{zone="eu-west"}[300s])');
    // Router scope on top: still only the zone on the cache metric.
    expect(sentQuery(calls, 1)).toBe('increase(cache_total_hits{zone="eu-west"}[300s])');
  });

  it("survives withScope — the router matcher stacks on top of it", async () => {
    const calls = captureFetch();
    const scoped = new PrometheusClient(BASE, 1000, null, {}, { baseScope: ZONE }).withScope({
      label: "service",
      value: "eth-router",
    });
    await scoped.query("smartrouter_overall_health");
    expect(sentQuery(calls)).toBe('smartrouter_overall_health{service="eth-router",zone="eu-west"}');
  });

  it("leaves the readiness probe alone — vector(1) has no selector to scope", async () => {
    const calls = captureFetch();
    await new PrometheusClient(BASE, 1000, null, {}, { baseScope: ZONE }).ping();
    expect(sentQuery(calls)).toBe("vector(1)");
  });

  it("ignores a malformed base scope rather than sending a broken matcher", async () => {
    // config.ts refuses such a pair at boot; the client is the second line.
    const calls = captureFetch();
    const client = new PrometheusClient(BASE, 1000, null, {}, { baseScope: { label: "zone", value: 'x" or a="b' } });
    await client.query("smartrouter_overall_health");
    expect(sentQuery(calls)).toBe("smartrouter_overall_health");
  });

  it("sends nothing extra when unset — today's behaviour", async () => {
    const calls = captureFetch();
    await new PrometheusClient(BASE, 1000, null, {}).query("smartrouter_overall_health");
    expect(sentQuery(calls)).toBe("smartrouter_overall_health");
  });
});

describe("PrometheusClient failure logging", () => {
  function captureLogger(): { logger: PromLogger; lines: { obj: Record<string, unknown>; msg: string }[] } {
    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    return { logger: { warn: (obj, msg) => lines.push({ obj, msg }) }, lines };
  }

  it("still answers a failed call with an empty result", async () => {
    captureFetch(401);
    const { logger } = captureLogger();
    expect(await new PrometheusClient(BASE, 1000, null, {}, { logger }).query("up")).toEqual([]);
  });

  it("warns with the status, the body and the query on a non-2xx", async () => {
    captureFetch(400, '{"status":"error","errorType":"bad_data","error":"parse error at char 5"}');
    const { logger, lines } = captureLogger();
    await new PrometheusClient(BASE, 1000, null, {}, { logger }).query("up{");

    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toBe("prometheus call failed");
    expect(lines[0]!.obj).toMatchObject({ status: 400, query: "up{", url: `${BASE}/api/v1/query` });
    expect(String(lines[0]!.obj.body)).toContain("parse error");
  });

  it("warns when the store is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const { logger, lines } = captureLogger();
    expect(await new PrometheusClient(BASE, 1000, null, {}, { logger }).query("up")).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toBe("prometheus unreachable");
    expect(lines[0]!.obj.error).toBe("connect ECONNREFUSED");
  });

  it("warns on a 200 whose envelope says error", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ status: "error", errorType: "execution", error: "query timed out" }));
    const { logger, lines } = captureLogger();
    expect(await new PrometheusClient(BASE, 1000, null, {}, { logger }).query("up")).toEqual([]);
    expect(lines).toEqual([{ obj: { error: "query timed out", query: "up" }, msg: "prometheus returned an error" }]);
  });

  it("logs each distinct failure once a minute, across scoped copies", async () => {
    vi.useFakeTimers();
    captureFetch(401);
    const { logger, lines } = captureLogger();
    const client = new PrometheusClient(BASE, 1000, null, {}, { logger });
    const scoped = client.withScope({ label: "service", value: "eth-router" });

    await client.query("up");
    await scoped.query("up");
    await client.queryRange("up", 0, 60, "15s");
    expect(lines).toHaveLength(1);

    vi.advanceTimersByTime(61_000);
    await scoped.query("up");
    expect(lines).toHaveLength(2);
  });

  it("stays silent without a logger", async () => {
    captureFetch(500);
    expect(await new PrometheusClient(BASE, 1000, null, {}).query("up")).toEqual([]);
  });
});

describe("PrometheusClient base URL", () => {
  it("keeps a path prefix and the base's query string on every call", async () => {
    const calls = captureFetch();
    const client = new PrometheusClient("https://mimir.test/prometheus?tenant=acme", 1000, null, {});
    await client.query("up");
    await client.queryRange("up", 0, 60, "15s");

    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/prometheus/api/v1/query");
    expect(first.searchParams.get("tenant")).toBe("acme");
    expect(first.searchParams.get("query")).toBe("up");
    const second = new URL(calls[1]!.url);
    expect(second.pathname).toBe("/prometheus/api/v1/query_range");
    expect(second.searchParams.get("tenant")).toBe("acme");
  });

  it("is unchanged for a bare base — no stray parameters", async () => {
    const calls = captureFetch();
    await new PrometheusClient(BASE, 1000, null, {}).query("up");
    expect([...new URL(calls[0]!.url).searchParams.keys()]).toEqual(["query"]);
  });
});

/** Counts the requests that reach the store; answers each after a tick so concurrent reads overlap. */
function countingFetch(answer: () => Response = () => Response.json({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [1, "1"] }] } })) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    calls.push(typeof input === "string" ? input : input.toString());
    await new Promise((r) => setTimeout(r, 5));
    return answer();
  });
  return calls;
}

// MAG-4297: every read went straight to the store — two tabs, two panels or
// two polls asking the same thing in one interval each cost a query, and the
// store answered part of them with 429. Identical reads now share one
// request in flight and reuse a successful answer briefly.
describe("PrometheusClient read coalescing + cache (MAG-4297)", () => {
  const fresh = (ttl: number, auth = {}) => new PrometheusClient(BASE, 1000, null, auth, { cacheTtlMs: ttl });

  it("identical reads in flight together share one request, even with the cache off", async () => {
    const calls = countingFetch();
    const client = fresh(0);
    const answers = await Promise.all([client.query("up"), client.query("up"), client.scalar("up")]);
    expect(calls).toHaveLength(1);
    expect(answers[0]).toEqual([{ metric: {}, value: [1, "1"] }]);
    expect(answers[2]).toBe(1);
  });

  it("reuses a successful answer within the TTL and reads again after it", async () => {
    const calls = countingFetch();
    const client = fresh(40);
    await client.query("up");
    await client.query("up");
    expect(calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    await client.query("up");
    expect(calls).toHaveLength(2);
  });

  it("with the TTL at 0 every sequential read is live", async () => {
    const calls = countingFetch();
    const client = fresh(0);
    await client.query("up");
    await client.query("up");
    expect(calls).toHaveLength(2);
  });

  it("keys a range read by its window and step too", async () => {
    const calls = countingFetch();
    const client = fresh(10_000);
    await client.queryRange("up", 1, 2, "15s");
    await client.queryRange("up", 1, 2, "15s");
    expect(calls).toHaveLength(1);
    await client.queryRange("up", 1, 3, "15s");
    await client.queryRange("up", 1, 2, "30s");
    expect(calls).toHaveLength(3);
  });

  it("a scoped copy shares the store but not the answers — its query text differs", async () => {
    const calls = countingFetch();
    const client = fresh(10_000);
    await client.query("smartrouter_overall_health");
    await client.withScope({ label: "service", value: "eth" }).query("smartrouter_overall_health");
    await client.withScope({ label: "service", value: "eth" }).query("smartrouter_overall_health");
    expect(calls).toHaveLength(2);
    expect(sentQuery(calls.map((url) => ({ url })), 1)).toBe('smartrouter_overall_health{service="eth"}');
  });

  it("never hands one credential's answer to another", async () => {
    const calls = countingFetch();
    const reads = { inflight: new Map(), remembered: new Map() };
    const a = new PrometheusClient(BASE, 1000, null, AUTH, { cacheTtlMs: 10_000, reads });
    const b = new PrometheusClient(BASE, 1000, null, { ...AUTH, username: "tenant-b" }, { cacheTtlMs: 10_000, reads });
    await a.query("up");
    await b.query("up");
    await a.query("up");
    expect(calls).toHaveLength(2);
  });

  it("never keeps a failure — the next caller retries", async () => {
    let n = 0;
    const calls = countingFetch(() =>
      n++ === 0
        ? new Response('{"status":"error","errorType":"too_many_requests","error":"too many outstanding requests"}', { status: 429 })
        : Response.json({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [1, "7"] }] } }),
    );
    const client = fresh(10_000);
    expect(await client.query("up")).toEqual([]);
    expect(await client.scalar("up")).toBe(7);
    expect(calls).toHaveLength(2);
    // A 200 whose envelope says error is a failure too.
    const again = countingFetch(() => Response.json({ status: "error", errorType: "execution", error: "query timed out" }));
    const other = fresh(10_000);
    await other.query("down");
    await other.query("down");
    expect(again).toHaveLength(2);
  });

  it("answers a refused refresh from the last good read, and retries next time", async () => {
    let n = 0;
    const calls = countingFetch(() =>
      n++ === 1
        ? new Response('{"status":"error","errorType":"too_many_requests","error":"too many outstanding requests"}', { status: 429 })
        : Response.json({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [1, String(n)] }] } }),
    );
    const warnings: string[] = [];
    const logger: PromLogger = { warn: (_obj, msg) => void warnings.push(msg) };
    const client = new PrometheusClient(BASE, 1000, null, {}, { cacheTtlMs: 20, staleMaxMs: 10_000, logger });
    expect(await client.scalar("up")).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    // The refresh is refused: the failure is logged as ever, and the first
    // answer stands in, logged once more.
    expect(await client.scalar("up")).toBe(1);
    expect(warnings).toEqual(["prometheus call failed", "prometheus refused a refresh — answered from the last good read"]);
    await new Promise((r) => setTimeout(r, 30));
    // The refusal was not kept: the next refresh goes out and wins.
    expect(await client.scalar("up")).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("past the stale cap a refused refresh is empty again", async () => {
    let n = 0;
    const calls = countingFetch(() =>
      n++ === 0
        ? Response.json({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [1, "1"] }] } })
        : new Response("busy", { status: 503 }),
    );
    const client = new PrometheusClient(BASE, 1000, null, {}, { cacheTtlMs: 10, staleMaxMs: 40 });
    expect(await client.scalar("up")).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(await client.scalar("up")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("forgets answers no refresh could use any more", async () => {
    countingFetch();
    const reads = { inflight: new Map(), remembered: new Map() };
    const client = new PrometheusClient(BASE, 1000, null, {}, { cacheTtlMs: 10, staleMaxMs: 40, reads });
    await client.query("a");
    await client.query("b");
    await client.query("c");
    expect(reads.remembered.size).toBe(3);
    await new Promise((r) => setTimeout(r, 50));
    await client.query("d");
    expect([...reads.remembered.keys()].map((k) => new URL(k.split("\n")[1]!).searchParams.get("query"))).toEqual(["d"]);
  });

  it("the readiness probe is always live", async () => {
    const calls = countingFetch();
    const client = fresh(10_000);
    expect(await client.ping()).toBe(true);
    expect(await client.ping()).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("forgets the oldest answer past the cap", async () => {
    const calls = countingFetch();
    const client = fresh(10_000);
    for (let i = 0; i < 4097; i++) await client.query(`up{i="${i}"}`);
    expect(calls).toHaveLength(4097);
    // The first read is gone; the last 4096 are kept.
    await client.query('up{i="0"}');
    await client.query('up{i="4096"}');
    expect(calls).toHaveLength(4098);
  });
});

// MAG-4571: range reads now end on a step boundary, so the same chart read
// asks for the same window until the next one. Once its newest point has
// settled, its answer is reused for that long rather than for the instant
// reads' TTL. (Most cases below read windows that ended long ago.)
describe("PrometheusClient range-read reuse (MAG-4571)", () => {
  const T0 = Date.UTC(2026, 9, 22, 12, 0);
  const fresh = (ttl: number, opts = {}) => new PrometheusClient(BASE, 1000, null, {}, { cacheTtlMs: ttl, ...opts });
  /** Fake only the clock the cache reads: the fetch stub's own timers stay real. */
  const at = (ms: number) => vi.setSystemTime(T0 + ms);
  const answer = (v: string) => Response.json({ status: "success", data: { resultType: "matrix", result: [{ metric: {}, values: [[1, v]] }] } });

  it("is reused for its step, longer than the instant TTL, and read again at the step", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const calls = countingFetch();
    const client = fresh(10_000);
    await client.queryRange("up", 0, 1800, "15s");
    await client.query("up");
    at(14_999);
    await client.queryRange("up", 0, 1800, "15s");
    expect(calls).toHaveLength(2);
    // The instant read keeps its 10 s; the range read is still current.
    await client.query("up");
    expect(calls).toHaveLength(3);
    at(15_000);
    await client.queryRange("up", 0, 1800, "15s");
    expect(calls).toHaveLength(4);
  });

  it("a step past five minutes is reused for five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const calls = countingFetch();
    const client = fresh(10_000);
    await client.queryRange("up", 0, 2_592_000, "4h");
    at(RANGE_REUSE_MAX_MS - 1);
    await client.queryRange("up", 0, 2_592_000, "4h");
    expect(calls).toHaveLength(1);
    at(RANGE_REUSE_MAX_MS);
    await client.queryRange("up", 0, 2_592_000, "4h");
    expect(calls).toHaveLength(2);
  });

  it("never less than the instant TTL, and live with the cache off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const calls = countingFetch();
    const slow = fresh(30_000);
    await slow.queryRange("up", 0, 1800, "15s");
    at(29_999);
    await slow.queryRange("up", 0, 1800, "15s");
    expect(calls).toHaveLength(1);
    // PROMETHEUS_CACHE_TTL_MS=0 keeps range reads live too: the route tests rely on it.
    const off = fresh(0);
    await off.queryRange("up", 0, 1800, "15s");
    await off.queryRange("up", 0, 1800, "15s");
    expect(await off.queryRangeOrNull("up", 0, 1800, "15s")).not.toBeNull();
    expect(calls).toHaveLength(4);
  });

  it("keeps the instant TTL until its end is three minutes old, then is reused for its step", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const calls = countingFetch();
    const client = fresh(10_000);
    const end = T0 / 1000; // a 4-hour boundary
    const read = () => client.queryRange("up", end - 2_592_000, end, "4h");
    at(30_000); // the end is 30 s old: the newest point may still change
    await read();
    at(39_999);
    await read();
    expect(calls).toHaveLength(1);
    at(40_000);
    await read();
    expect(calls).toHaveLength(2);
    // Three minutes on, the answer read 40 s in is too young to keep: read once more.
    at(RANGE_SETTLE_MS);
    await read();
    expect(calls).toHaveLength(3);
    // That one had settled: reused for its step, five minutes at most.
    at(RANGE_SETTLE_MS + RANGE_REUSE_MAX_MS - 1);
    await read();
    expect(calls).toHaveLength(3);
    at(RANGE_SETTLE_MS + RANGE_REUSE_MAX_MS);
    await read();
    expect(calls).toHaveLength(4);
  });

  it("a refused refresh of a read that had not settled is still answered from it, for 60 s past its reuse", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let n = 0;
    const calls = countingFetch(() => (n++ === 0 ? answer("5") : new Response("busy", { status: 503 })));
    const client = fresh(10_000);
    const end = T0 / 1000;
    const read = () => client.queryRangeOrNull("up", end - 2_592_000, end, "4h");
    at(5_000);
    const first = await read();
    expect(first).toEqual([{ metric: {}, values: [[1, "5"]] }]);
    at(5_000 + 10_000 + 59_999);
    expect(await read()).toEqual(first);
    at(5_000 + 10_000 + 60_000);
    expect(await read()).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("a refused refresh is answered from the last good read for staleMaxMs past its reuse", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    let n = 0;
    const calls = countingFetch(() => (n++ === 0 ? answer("7") : new Response("busy", { status: 503 })));
    const client = fresh(10_000);
    const first = await client.queryRangeOrNull("up", 0, 2_592_000, "4h");
    expect(first).toEqual([{ metric: {}, values: [[1, "7"]] }]);
    // Reused for five minutes; then a refused refresh still gets the answer for a minute more.
    at(RANGE_REUSE_MAX_MS + 59_999);
    expect(await client.queryRangeOrNull("up", 0, 2_592_000, "4h")).toEqual(first);
    at(RANGE_REUSE_MAX_MS + 60_000);
    expect(await client.queryRangeOrNull("up", 0, 2_592_000, "4h")).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("forgets each answer when its own span ends, wherever it sits in the store", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    countingFetch();
    const reads = { inflight: new Map(), remembered: new Map() };
    const client = fresh(10_000, { reads });
    const queryOf = (k: string) => new URL(k.split("\n")[1]!).searchParams.get("query");
    await client.queryRange("long", 0, 2_592_000, "4h"); // kept 5 min + 1 min
    await client.queryRange("short", 0, 1800, "15s"); // kept 15 s + 1 min
    await client.query("a"); // kept 1 min
    at(60_000);
    await client.query("b");
    // "a" went although an answer kept longer sits in front of it.
    expect([...reads.remembered.keys()].map(queryOf)).toEqual(["long", "short", "b"]);
    at(75_000);
    await client.query("c");
    expect([...reads.remembered.keys()].map(queryOf)).toEqual(["long", "b", "c"]);
  });
});
