/**
 * `GET /api/metrics/routers-rollup` — ONE ROW PER CONFIG ROUTER.
 *
 * The bug this pins: the Routers table used to key on the chain, so two
 * routers serving one chain collapsed into a single row that wore the first
 * router's name beside both routers' traffic. The values file below is exactly
 * that shape — `eth-prod` and `eth-staging`, both on eth1 — because it is the
 * case the dev config does not contain.
 *
 * The values dir is pointed at a temp mount BEFORE the app (and its config
 * snapshot) is imported.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const VALUES = `
routers:
  - id: "eth-prod"
    network: "eth1"
    nodes:
      - name: "eth-publicnode"
        endpoints:
          - url: "https://ethereum-rpc.publicnode.com"
            interface: "jsonrpc"
      - name: "eth-mevblocker"
        endpoints:
          - url: "https://rpc.mevblocker.io"
            interface: "jsonrpc"
  - id: "eth-staging"
    network: "eth1"
    nodes:
      - name: "eth-tenderly"
        endpoints:
          - url: "https://gateway.tenderly.co/public/mainnet"
            interface: "jsonrpc"
  - id: "sol-main"
    network: "solana"
    nodes:
      - name: "sol-publicnode"
        endpoints:
          - url: "https://solana-rpc.publicnode.com"
            interface: "jsonrpc"
`;

const dir = mkdtempSync(join(tmpdir(), "srdash-rollup-"));
mkdirSync(join(dir, "core"), { recursive: true });
writeFileSync(join(dir, "core", "values.yml"), VALUES);
process.env.HELM_VALUES_DIR = dir;

const { buildApp } = await import("../app.js");

/**
 * The canned series for one query. Every branch returns, so there is no dead
 * initial value to fall through to — the chain below is exhaustive by
 * construction. The table reads grouped series (MAG-4295): one row per chain
 * from `by (spec)`, one row per (chain, target) from `by (spec, service)`.
 */
function seriesFor(query: string, scopeValues: string[]): unknown[] {
  // Which routers the collector can tell apart.
  if (query.startsWith("count by (service)")) {
    return scopeValues.map((v) => ({ metric: { service: v }, value: [1, "1"] }));
  }
  if (query.startsWith("count by (spec)")) {
    return [
      { metric: { spec: "ETH1" }, value: [1, "1"] },
      { metric: { spec: "SOLANA" }, value: [1, "1"] },
    ];
  }
  // Per-target rows — deliberately a different number from the chain's, so a
  // test can tell "this router's own row" from "the whole chain".
  if (query.includes("by (spec, service")) {
    if (query.startsWith("count by (spec, service, endpoint_id)")) {
      return scopeValues.flatMap((v) => [
        { metric: { spec: "ETH1", service: v, endpoint_id: "eth-publicnode" }, value: [1, "1"] },
        { metric: { spec: "ETH1", service: v, endpoint_id: "eth-mevblocker" }, value: [1, "1"] },
      ]);
    }
    return scopeValues.map((v) => ({ metric: { spec: "ETH1", service: v }, value: [1, "700"] }));
  }
  // Per-chain rows.
  if (query.startsWith("count by (spec, endpoint_id)")) {
    return [
      { metric: { spec: "ETH1", endpoint_id: "eth-publicnode" }, value: [1, "1"] },
      { metric: { spec: "ETH1", endpoint_id: "eth-mevblocker" }, value: [1, "1"] },
      { metric: { spec: "ETH1", endpoint_id: "eth-tenderly" }, value: [1, "1"] },
      { metric: { spec: "SOLANA", endpoint_id: "sol-publicnode" }, value: [1, "1"] },
    ];
  }
  return [
    { metric: { spec: "ETH1" }, value: [1, "1000"] },
    { metric: { spec: "SOLANA" }, value: [1, "1000"] },
  ];
}

/** Every PromQL expression the api sent since the last `mockPrometheus()`. */
let sent: string[] = [];

/** Canned Prometheus: chain-level numbers per spec, and no per-target label. */
function mockPrometheus(scopeValues: string[] = []): void {
  sent = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = typeof input === "string" ? input : input.toString();
    const query = new URL(url).searchParams.get("query") ?? "";
    sent.push(query);
    return new Response(
      JSON.stringify({
        status: "success",
        data: { resultType: "vector", result: seriesFor(query, scopeValues) },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rollup() {
  const res = await app.inject({ method: "GET", url: "/api/metrics/routers-rollup" });
  expect(res.statusCode).toBe(200);
  return res.json().routers as {
    routerId: string;
    spec: string;
    attribution: string;
    sharedWith: string[];
    upstreamCount: number;
    requests: number;
    latestBlock: number | null;
  }[];
}

describe("GET /api/metrics/routers-rollup", () => {
  it("gives two routers on one chain a row EACH — the collapse this replaces", async () => {
    mockPrometheus();
    const rows = await rollup();
    expect(rows.map((r) => r.routerId).sort()).toEqual(["eth-prod", "eth-staging", "sol-main"]);
    // Both eth rows survive, and each carries its own chain.
    expect(rows.filter((r) => r.spec === "ETH1")).toHaveLength(2);
  });

  it("counts each router's OWN upstreams, not the chain's", async () => {
    mockPrometheus();
    const rows = await rollup();
    // eth-prod declares 2 nodes, eth-staging 1 — the collapsed row showed 3
    // (every endpoint_id on the chain) against the first router's name.
    expect(rows.find((r) => r.routerId === "eth-prod")!.upstreamCount).toBe(2);
    expect(rows.find((r) => r.routerId === "eth-staging")!.upstreamCount).toBe(1);
  });

  it("marks shared numbers as shared, and names who else is in them", async () => {
    mockPrometheus(); // no per-target label ⇒ the eth rows read one series
    const rows = await rollup();
    const prod = rows.find((r) => r.routerId === "eth-prod")!;
    const staging = rows.find((r) => r.routerId === "eth-staging")!;
    expect(prod.attribution).toBe("shared");
    expect(prod.sharedWith).toEqual(["eth-staging"]);
    expect(staging.sharedWith).toEqual(["eth-prod"]);
    // Same figure on both rows: that is the truth, and summing them would
    // double the deployment's traffic.
    expect(prod.requests).toBe(staging.requests);
  });

  it("a router alone on its chain owns its numbers", async () => {
    mockPrometheus();
    const rows = await rollup();
    const sol = rows.find((r) => r.routerId === "sol-main")!;
    expect(sol.attribution).toBe("own");
    expect(sol.sharedWith).toEqual([]);
  });

  it("scopes to the collector's target label when it reports one", async () => {
    mockPrometheus(["eth-prod-router"]); // only eth-prod is split out
    const rows = await rollup();
    const prod = rows.find((r) => r.routerId === "eth-prod")!;
    const staging = rows.find((r) => r.routerId === "eth-staging")!;
    // eth-prod's numbers came back through its own label…
    expect(prod.attribution).toBe("own");
    expect(prod.requests).toBe(700);
    // …while eth-staging, which the collector does not report, still reads the
    // chain series — and still says so.
    expect(staging.attribution).toBe("shared");
    expect(staging.requests).toBe(1000);
  });

  // MAG-4295: eight reads per router, all at once, was ~350 queries on a
  // 44-router deployment; the store rejected part of each burst and the rows
  // rendered "unknown" and 0. The table now reads at most two grouped sets.
  it("reads one grouped set per chain when the collector reports no targets", async () => {
    mockPrometheus();
    await rollup();
    // The target discovery, then the seven chain-level reads by spec.
    expect(sent).toHaveLength(1 + 7);
    expect(sent.filter((q) => /\bby \(spec[,)]/.test(q))).toHaveLength(7);
    // The target discovery is the only read that names the target label.
    expect(sent.filter((q) => q.includes("by (spec, service"))).toHaveLength(0);
  });

  it("adds one grouped set per (chain, target) when it does — never a read per router", async () => {
    mockPrometheus(["eth-prod-router"]);
    const rows = await rollup();
    expect(sent).toHaveLength(1 + 7 + 7);
    expect(sent.filter((q) => q.includes("by (spec, service"))).toHaveLength(7);
    // The per-target row joins on BOTH labels: a READ field (the config
    // overrides upstreamCount) comes from eth-prod's own (ETH1, target) row,
    // while its sibling, which the collector does not split, reads the chain's.
    expect(rows.find((r) => r.routerId === "eth-prod")!.latestBlock).toBe(700);
    expect(rows.find((r) => r.routerId === "eth-staging")!.latestBlock).toBe(1000);
  });

  it("every row of a fully split deployment comes from the per-target set", async () => {
    mockPrometheus(["eth-prod-router", "eth-staging-router", "sol-main-router"]);
    const rows = await rollup();
    // No router shares a chain row, so the per-chain set is not read at all.
    expect(sent).toHaveLength(1 + 7);
    expect(sent.filter((q) => q.includes("by (spec, service"))).toHaveLength(7);
    expect(rows.every((r) => r.attribution === "own")).toBe(true);
    // sol-main has a target but the fake only answers ETH1 rows for it: the
    // nulls a missing read always gave, never another chain's figures.
    expect(rows.find((r) => r.routerId === "sol-main")!.requests).toBe(0);
  });
});
