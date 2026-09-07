import { afterEach, describe, expect, it, vi } from "vitest";
import { PrometheusClient, buildAuthHeaders, type PromLogger } from "../services/prometheus-client.js";

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
    const base = new PrometheusClient(BASE, 1000, null, {}, { baseScope: ZONE });
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
