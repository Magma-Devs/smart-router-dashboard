/**
 * Every request value that can reach a store query, against hostile input:
 * quotes, braces, `"}`, line filters, backslashes, line breaks, regex
 * metacharacters and over-long values. Each is either a 400 before any read,
 * or reaches the store as one escaped literal - checked on the query the
 * stubbed store received.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { RouterTopology } from "@sr/shared";
import { buildApp } from "../app.js";

// Hundreds of requests from one address: lift the per-minute limit. And no
// recorded-series probe: its reads are the api's own, on a timer, not a
// request's. Both read at import.
const hoistedEnv = vi.hoisted(() => {
  const saved = { RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX, METRICS_RECORDED_FROM: process.env.METRICS_RECORDED_FROM };
  process.env.RATE_LIMIT_MAX = "1000000";
  process.env.METRICS_RECORDED_FROM = "off";
  return saved;
});

interface Read {
  store: "prometheus" | "loki";
  path: string;
  query: string;
}

let reads: Read[] = [];

function stubStores(): void {
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const loki = url.pathname.includes("/loki/");
    reads.push({ store: loki ? "loki" : "prometheus", path: url.pathname, query: url.searchParams.get("query") ?? "" });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/index/stats")) return json({ bytes: 1000 });
    if (url.pathname.includes("/label/")) return json({ status: "success", data: [] });
    if (loki) return json({ status: "success", data: { resultType: "streams", result: [] } });
    const matrix = url.pathname.endsWith("/query_range");
    return json({ status: "success", data: { resultType: matrix ? "matrix" : "vector", result: [] } });
  });
}

/** Values that would end a literal, open a selector or start a pipeline if spliced as written. */
const HOSTILE = [
  'ETH1"}',
  'ETH1"} or up{x="',
  "ETH1`",
  "ETH1{}",
  "ETH1\\",
  "ETH1\nup",
  "ETH1\r",
  'ETH1 |= "x"',
  "ETH1 |~ `.*`",
  ".*",
  "ETH1|BASE",
  "(?i)eth",
  "x".repeat(300),
];

let app: FastifyInstance;
const savedLoki = process.env.LOKI_URL;

beforeAll(async () => {
  process.env.LOKI_URL = "http://loki.test:3100";
  stubStores();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries({ ...hoistedEnv, LOKI_URL: savedLoki })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  reads = [];
  vi.restoreAllMocks();
});

const q = (v: string) => encodeURIComponent(v);

/** Every route and parameter a request value reaches a query through, with what else the route needs. */
const CASES: { url: string; param: string }[] = [
  ...[
    "dashboard-summary",
    "pulse",
    "dashboard",
    "upstreams",
    "block-heights",
    "rps",
    "methods",
    "error-incidents",
    "errors",
    "retries",
  ].map((r) => ({ url: `/api/metrics/${r}?window=1h`, param: "spec" })),
  ...["chain-series", "upstream-timeline", "upstream-mix", "upstream-peers"].map((r) => ({ url: `/api/metrics/${r}?window=1h`, param: "spec" })),
  { url: "/api/metrics/upstream-detail?window=1h&endpointId=eth-a", param: "spec" },
  ...[
    "specs",
    "dashboard-summary",
    "pulse",
    "dashboard",
    "routers-rollup",
    "chains",
    "upstreams",
    "block-heights",
    "rps",
    "traffic",
    "methods",
    "errors",
    "retries",
    "unavailable",
    "cross-validation",
    "websocket",
    "error-incidents",
  ].map((r) => ({ url: `/api/metrics/${r}?window=1h`, param: "router" })),
  ...["chain-series", "upstream-timeline", "upstream-mix", "upstream-peers"].map((r) => ({ url: `/api/metrics/${r}?window=1h&spec=ETH1`, param: "router" })),
  ...["pulse", "upstreams", "block-heights", "errors", "error-incidents"].map((r) => ({ url: `/api/metrics/${r}?window=1h`, param: "routerId" })),
  { url: "/api/metrics/upstream-timeline?window=1h&spec=ETH1", param: "routerId" },
  { url: "/api/metrics/upstream-detail?window=1h&spec=ETH1", param: "endpointId" },
  ...["/api/error-requests?window=1h", "/api/error-requests/count?window=1h", "/api/transactions?window=1h", "/api/transactions/over-time?window=1h"].flatMap(
    (url) => [
      { url, param: "spec" },
      { url, param: "routerId" },
    ],
  ),
  { url: "/api/error-requests?window=1h", param: "upstream" },
];

describe("a hostile value is a 400 before any read", () => {
  it.each(CASES)("$url · $param", async ({ url, param }) => {
    for (const v of HOSTILE) {
      reads = [];
      const res = await app.inject({ method: "GET", url: `${url}&${param}=${q(v)}` });
      expect(res.statusCode, `${param}=${JSON.stringify(v)}`).toBe(400);
      expect(reads, `${param}=${JSON.stringify(v)}`).toEqual([]);
    }
  });

  it.each(["/api/requests", "/api/transactions"])("%s/:guid", async (base) => {
    for (const v of HOSTILE) {
      reads = [];
      const res = await app.inject({ method: "GET", url: `${base}/${q(v)}?window=1h` });
      // 414 for the over-long one: the router refuses a path parameter past 128.
      expect([400, 414], JSON.stringify(v)).toContain(res.statusCode);
      expect(reads).toEqual([]);
    }
  });

  it("a plain value still reads", async () => {
    for (const { url, param } of CASES) {
      const plain = param === "router" ? "eth-router" : param === "routerId" ? "eth-prod" : param === "endpointId" || param === "upstream" ? "eth-a" : "ETH1";
      const res = await app.inject({ method: "GET", url: `${url}&${param}=${q(plain)}` });
      expect(res.statusCode, `${url} ${param}`).toBe(200);
    }
  });
});

/* ── A configured name reaches the store as one literal ──────────────────── */

/** The query with every string literal emptied: what a value can't change if it only ever sits inside one. */
function structure(query: string): string {
  return query.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""');
}

/** Upstream names a values file may carry - free text the chart allows. */
const ODD_NAMES = ['Example "archive" node', "eth\\node", "a`b", "node (eu) #1", "x\"} or up{y=\"", "a.b*c|d"];

function withNodes(names: string[]): void {
  const router: RouterTopology = {
    id: "eth-prod",
    spec: "ETH1",
    network: "eth1",
    pathBased: false,
    customUrlPrefix: null,
    publicUrls: {},
    localPorts: {},
    nodes: names.map((name) => ({ name, isBackup: false, endpoints: [] })),
  } as unknown as RouterTopology;
  vi.spyOn(app.routerConfig, "getRouters").mockReturnValue([router]);
}

async function readsFor(url: string): Promise<Read[]> {
  reads = [];
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode, url).toBe(200);
  return reads;
}

describe("a name the values file lists reaches the store as one escaped literal", () => {
  it.each(ODD_NAMES)("upstream-detail endpointId %j", async (name) => {
    withNodes(["eth-a", name]);
    const plain = (await readsFor("/api/metrics/upstream-detail?window=1h&spec=ETH1&endpointId=eth-a")).map((r) => structure(r.query)).sort();
    expect(plain.length).toBeGreaterThan(0);
    const odd = await readsFor(`/api/metrics/upstream-detail?window=1h&spec=ETH1&endpointId=${q(name)}`);
    // The value changes what is inside literals, never the query around them.
    expect(odd.map((r) => structure(r.query)).sort()).toEqual(plain);
    // And it is there, escaped: Go's quoting of these names is JSON's.
    const literal = JSON.stringify(name);
    expect(odd.some((r) => r.query.includes(`endpoint_id=${literal}`))).toBe(true);
    expect(odd.some((r) => r.query.includes(`provider_address=${literal}`))).toBe(true);
  });

  it.each(ODD_NAMES.map((name, i) => [name, i] as const))("error-requests upstream %j", async (name, i) => {
    // A name of its own per case: the list keeps its last read per filter.
    const own = `eth-plain-${i}`;
    withNodes([own, name]);
    const plain = (await readsFor(`/api/error-requests?window=1h&upstream=${own}`)).filter((r) => r.store === "loki").map((r) => structure(r.query)).sort();
    expect(plain.length).toBeGreaterThan(0);
    const odd = (await readsFor(`/api/error-requests?window=1h&upstream=${q(name)}`)).filter((r) => r.store === "loki");
    expect(odd.map((r) => structure(r.query)).sort()).toEqual(plain);
    // The relay_end filter names the upstream as the line writes it, JSON-encoded, in one literal.
    const filter = odd.map((r) => r.query).find((s) => s.includes("relay_end"));
    expect(filter).toBeDefined();
    const want = `"upstream":${JSON.stringify(name)}`;
    expect(filter!.includes(`|= \`${want}\``) || filter!.includes(`|= ${JSON.stringify(want)}`), filter).toBe(true);
  });

  it("a name the values file doesn't list, and that isn't a plain token, is a 400", async () => {
    withNodes(["eth-a"]);
    for (const name of ODD_NAMES) {
      reads = [];
      expect((await app.inject({ method: "GET", url: `/api/metrics/upstream-detail?window=1h&spec=ETH1&endpointId=${q(name)}` })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `/api/error-requests?window=1h&upstream=${q(name)}` })).statusCode).toBe(400);
      expect(reads).toEqual([]);
    }
  });
});
