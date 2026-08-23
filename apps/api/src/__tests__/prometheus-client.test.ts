import { afterEach, describe, expect, it, vi } from "vitest";
import { PrometheusClient, buildAuthHeaders } from "../services/prometheus-client.js";

/**
 * Records every fetch the client makes so a test can assert on the exact
 * headers sent. Answers every query with a one-sample vector.
 */
function captureFetch(status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });
    if (status !== 200) return new Response("unauthorized", { status });
    return Response.json({
      status: "success",
      data: { resultType: "vector", result: [{ metric: {}, value: [1, "1"] }] },
    });
  });
  return calls;
}

const BASE = "http://prom.test:9090";
const AUTH = { username: "tenant-a", password: "s3cret", orgId: "tenant-a" };

afterEach(() => vi.unstubAllGlobals());

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
