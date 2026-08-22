/**
 * `GET /api/vendors/status` — the route, against a values file we control.
 *
 * The mount matters here: the route reads it to decide whose status page to
 * fetch and for which chains, so the topology IS half the test.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  VendorStatusService,
  normalizeVendorDetail,
  normalizeVendors,
  providerDetailUrl,
  providerStatusUrl,
} from "../services/vendor-status.js";

/** ETH1 through QuickNode (http only), Tenderly (http + ws) and dRPC, plus a
 *  public node no vendor sells. */
const VALUES = `
endpoints:
  - listen-address: "0.0.0.0:3360"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
direct-rpc:
  - name: "eth-quicknode"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://lively-multi-leaf.ethereum-mainnet.quiknode.pro/c127f87db6c3a88970738f5e3d0987aacb63be12/"
  - name: "eth-tenderly"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://mainnet.gateway.tenderly.co"
      - url: "wss://mainnet.gateway.tenderly.co"
  - name: "eth-drpc"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://eth.drpc.org"
  - name: "eth-publicnode"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://ethereum-rpc.publicnode.com"
`;

const dir = mkdtempSync(join(tmpdir(), "srdash-vendors-"));
mkdirSync(join(dir, "core"), { recursive: true });
writeFileSync(join(dir, "core", "values.yml"), VALUES);
process.env.HELM_VALUES_DIR = dir;

const { buildApp } = await import("../app.js");

/** The list route's rows are FLAT (`official_*`); only the detail route nests
 *  the official block and carries components. Both shapes are real. */
const LIST: Record<string, unknown>[] = [
  {
    slug: "quicknode",
    name: "QuickNode",
    website: "https://www.quicknode.com",
    status_page: "https://status.quicknode.com",
    paused: false,
    official_status: "minor",
    official_description: "Partially Degraded Service · 476/504 components operational",
    official_fetched_at: "2026-08-21T15:20:00.018790Z",
    official_last_change_at: "2026-08-21T07:07:00.038588Z",
    measured_status: "unconfigured",
    measured_last_change_at: null,
  },
  {
    slug: "tenderly",
    name: "Tenderly",
    status_page: "https://status.tenderly.co",
    paused: false,
    official_status: "operational",
    official_description: "All Systems Operational",
    official_fetched_at: "2026-08-21T15:20:00.018790Z",
    measured_status: "unconfigured",
  },
  {
    slug: "drpc",
    name: "dRPC",
    status_page: "https://status.drpc.org",
    paused: false,
    official_status: "operational",
    official_description: "44/44 components operational",
    official_fetched_at: "2026-08-21T15:20:00.018790Z",
    measured_status: "unconfigured",
  },
  // Tracked by the index, routed by nobody here.
  {
    slug: "chainstack",
    name: "Chainstack",
    status_page: "https://status.chainstack.com",
    paused: false,
    official_status: "major",
    official_description: "Major outage",
    official_fetched_at: "2026-08-21T15:20:00.018790Z",
    measured_status: "unconfigured",
  },
];

const DETAILS: Record<string, unknown> = {
  quicknode: {
    slug: "quicknode",
    official: {
      status: "minor",
      description: "Partially Degraded Service",
      components: [
        { name: "Ethereum · Mainnet — JSON-RPC API", status: "operational" },
        { name: "Ethereum · Mainnet — Websockets API", status: "minor" },
        { name: "Ethereum · Mainnet — Streams", status: "minor" },
        { name: "Ethereum · Sepolia — JSON-RPC API", status: "major" },
        { name: "BNB Smart Chain (BSC) · Mainnet — JSON-RPC API", status: "minor" },
      ],
    },
  },
  tenderly: {
    slug: "tenderly",
    official: {
      status: "operational",
      components: [{ name: "Boba Ethereum · Node RPC", status: "major" }],
    },
  },
  drpc: {
    slug: "drpc",
    official: {
      status: "operational",
      components: [
        { name: "Ethereum · Ethereum Mainnet", status: "minor" },
        { name: "Ethereum · Ethereum Sepolia", status: "major" },
      ],
    },
  },
};

/** Serves the index: the list on the base path, a vendor object per slug.
 *  Returns the urls it was asked for, in order. */
function stubIndex(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const slug = url.split("/v1/public/provider-status/")[1];
    const body = slug === undefined ? LIST : (DETAILS[slug] ?? { slug });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls };
}

let app: FastifyInstance;

// A fresh app per test, because the vendor caches live on the app: a warm
// cache from the previous test would answer before the stub was consulted.
beforeEach(async () => {
  app = await buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface WireVendor {
  slug: string;
  official: { status: string };
  chains: Record<string, { status: string; components: { name: string }[]; reason: string | null }>;
}

async function readStatus() {
  const res = await app.inject({ method: "GET", url: "/api/vendors/status" });
  return { res, body: res.json() as { vendors: WireVendor[] | null; fetchedAt: string; stale: boolean } };
}

function pick(vendors: WireVendor[] | null, slug: string): WireVendor {
  return (vendors ?? []).find((v) => v.slug === slug) as WireVendor;
}

describe("GET /api/vendors/status · per-chain verdicts", () => {
  it("judges the chain we route, not the vendor's headline", async () => {
    // QuickNode is globally "minor" because of BSC; our Ethereum JSON-RPC is
    // green and this deployment dials no ws there — so the chain is green.
    stubIndex();
    const { res, body } = await readStatus();
    expect(res.statusCode).toBe(200);
    const quicknode = pick(body.vendors, "quicknode");
    expect(quicknode.official.status).toBe("minor");
    expect(quicknode.chains.ETH1).toEqual({
      status: "operational",
      components: [{ name: "Ethereum · Mainnet — JSON-RPC API", status: "operational" }],
      reason: null,
    });
  });

  it("says nothing maps rather than reading a look-alike chain", async () => {
    stubIndex();
    const { body } = await readStatus();
    expect(pick(body.vendors, "tenderly").chains.ETH1).toEqual({
      status: "unknown",
      components: [],
      reason: "No component on their status page maps to this chain.",
    });
  });

  it("carries a real chain incident through", async () => {
    stubIndex();
    const { body } = await readStatus();
    const drpc = pick(body.vendors, "drpc");
    expect(drpc.chains.ETH1?.status).toBe("minor");
    expect(drpc.chains.ETH1?.components.map((c) => c.name)).toEqual(["Ethereum · Ethereum Mainnet"]);
  });

  it("leaves vendors this deployment doesn't route with no chains at all", async () => {
    const { calls } = stubIndex();
    const { body } = await readStatus();
    // Chainstack is in a major outage and is nobody's business here.
    expect(pick(body.vendors, "chainstack").chains).toEqual({});
    expect(calls.some((u) => u.endsWith("/chainstack"))).toBe(false);
    // Exactly one detail read per present vendor, plus the list.
    expect(calls).toHaveLength(4);
  });
});

describe("GET /api/vendors/status · shape and failure", () => {
  it("hands back the index's rows camel-cased, and nothing else", async () => {
    stubIndex();
    const { body } = await readStatus();
    expect(pick(body.vendors, "drpc")).toMatchObject({
      slug: "drpc",
      name: "dRPC",
      statusPage: "https://status.drpc.org",
      paused: false,
      official: {
        status: "operational",
        description: "44/44 components operational",
        fetchedAt: "2026-08-21T15:20:00.018790Z",
      },
      measuredStatus: "unconfigured",
    });
    expect(Date.parse(body.fetchedAt)).not.toBeNaN();
    expect(body.stale).toBe(false);
    // The pages' other 500-odd components never reach the wire: three chains,
    // each carrying only what it matched.
    expect((body.vendors ?? []).flatMap((v) => Object.values(v.chains))).toHaveLength(3);
  });

  it("answers 200 with vendors:null when the index has never answered", async () => {
    // Someone else's outage is not a dashboard error: a 5xx here would light
    // up the browser's error state on every page.
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const { res, body } = await readStatus();
    expect(res.statusCode).toBe(200);
    expect(body.vendors).toBeNull();
  });

  it("answers vendors:null when the index answers something that isn't JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>502 Bad Gateway</html>", { status: 200 }));
    const { res, body } = await readStatus();
    expect(res.statusCode).toBe(200);
    expect(body.vendors).toBeNull();
  });

  it("answers vendors:null on a non-2xx from the index", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 }));
    const { res, body } = await readStatus();
    expect(res.statusCode).toBe(200);
    expect(body.vendors).toBeNull();
  });

  it("serves a second caller from the cache — the index allows 30 reads a minute", async () => {
    const { calls } = stubIndex();
    const first = await readStatus();
    const second = await readStatus();
    expect(calls).toHaveLength(4); // list + three present vendors, once each
    expect(second.body).toEqual(first.body);
  });
});

describe("VendorStatusService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const service = (
    over: Partial<{
      ttlMs: number;
      failureTtlMs: number;
      baseUrl: string;
      timeoutMs: number;
      onError: (reason: string) => void;
    }> = {},
  ) =>
    new VendorStatusService({
      baseUrl: "http://spi.test/",
      timeoutMs: 5000,
      ttlMs: 60_000,
      failureTtlMs: 10_000,
      ...over,
    });

  const USE = [{ slug: "drpc", spec: "ETH1", surfaces: ["rpc" as const] }];

  it("reads the list and the detail routes off the configured base", () => {
    expect(providerStatusUrl("http://spi.test")).toBe("http://spi.test/v1/public/provider-status");
    expect(providerStatusUrl("http://spi.test///")).toBe("http://spi.test/v1/public/provider-status");
    expect(providerDetailUrl("http://spi.test/", "drpc")).toBe(
      "http://spi.test/v1/public/provider-status/drpc",
    );
  });

  it("makes no call at all when the index url is empty", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL | string) => {
      calls.push(String(input));
      return new Response("[]", { status: 200 });
    });
    const svc = service({ baseUrl: "" });
    expect(svc.disabled).toBe(true);
    const report = await svc.read(USE);
    // An air-gapped install must not phone home just because a default exists.
    expect(report).toMatchObject({ vendors: null, disabled: true, stale: false });
    expect(calls).toEqual([]);
  });

  it("serves concurrent callers from ONE read", async () => {
    const { calls } = stubIndex();
    const svc = service();
    await Promise.all([svc.read(USE), svc.read(USE), svc.read(USE)]);
    expect(calls).toEqual([
      "http://spi.test/v1/public/provider-status",
      "http://spi.test/v1/public/provider-status/drpc",
    ]);
  });

  it("re-reads once the cache expires", async () => {
    vi.useFakeTimers();
    const { calls } = stubIndex();
    const svc = service();
    await svc.read(USE);
    expect(calls).toHaveLength(2); // list + drpc
    vi.advanceTimersByTime(59_000);
    await svc.read(USE);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(2_000);
    await svc.read(USE);
    await vi.advanceTimersByTimeAsync(0); // let the background refresh land
    expect(calls).toHaveLength(4);
  });

  it("KEEPS the last good answer when a refresh fails, and says it is stale", async () => {
    // The regression this exists for: one blip used to blank the vendor data
    // for a whole minute — during the incident the feature is meant to explain.
    vi.useFakeTimers();
    stubIndex();
    const svc = service();
    const good = await svc.read(USE);
    expect(good.vendors).not.toBeNull();
    expect(good.stale).toBe(false);

    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    });
    vi.advanceTimersByTime(61_000);
    // First read after expiry serves the good value and refreshes behind it.
    const during = await svc.read(USE);
    await vi.advanceTimersByTimeAsync(0);
    const after = await svc.read(USE);

    expect(during.vendors).not.toBeNull();
    expect(after.vendors).not.toBeNull();
    expect(after.stale).toBe(true);
    expect(after.lastGoodAt).toBe(good.fetchedAt);
    expect(after.vendors?.find((v) => v.slug === "drpc")?.chains.ETH1?.status).toBe("minor");
  });

  it("does not block a caller on a slow index once it has an answer", async () => {
    vi.useFakeTimers();
    stubIndex();
    const svc = service();
    await svc.read(USE);
    // A refresh that never resolves must not hold the next reader.
    vi.stubGlobal("fetch", async () => await new Promise<Response>(() => {}));
    vi.advanceTimersByTime(61_000);
    const served = await svc.read(USE);
    expect(served.vendors).not.toBeNull();
    expect(served.stale).toBe(true);
  });

  it("backs off briefly after a failure instead of retrying every request", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL | string) => {
      calls.push(String(input));
      throw new Error("nope");
    });
    const svc = service();
    expect((await svc.read(USE)).vendors).toBeNull();
    expect((await svc.read(USE)).vendors).toBeNull();
    expect(calls).toHaveLength(1);
    // …and tries again once the short negative TTL is up, not a minute later.
    vi.advanceTimersByTime(11_000);
    await svc.read(USE);
    expect(calls).toHaveLength(2);
  });

  it("states the reason when the list reads but a vendor's detail does not", async () => {
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/drpc")) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify(LIST), { status: 200 });
    });
    const report = await service().read(USE);
    expect(report.vendors?.find((v) => v.slug === "drpc")?.chains.ETH1).toEqual({
      status: "unknown",
      components: [],
      reason: "The status index could not read this vendor's components.",
    });
  });

  it("gives up on a status page that never answers", async () => {
    // Real abort, real timer: the deadline is the only thing between a hung
    // status page and a dashboard request that never returns.
    const reasons: string[] = [];
    vi.stubGlobal("fetch", async (_input: URL | string, init: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      });
    });
    const report = await service({ timeoutMs: 25, onError: (r) => reasons.push(r) }).read(USE);
    expect(report.vendors).toBeNull();
    expect(reasons).toEqual(["timed out reading the provider list"]);
  });
});

describe("normalizeVendors", () => {
  it("reads the detail route's NESTED official block", () => {
    const vendors = normalizeVendors([
      {
        slug: "alchemy",
        name: "Alchemy",
        status_page: "https://status.alchemy.com",
        paused: false,
        official: {
          status: "Operational",
          description: "All Systems Operational",
          fetched_at: "2026-08-21T15:20:00Z",
          fetch_error: null,
          components: [{ name: "Ethereum", status: "operational" }],
        },
        measured: { status: "unconfigured", last_change_at: null, endpoints: [] },
      },
    ]);
    expect(vendors).toEqual([
      {
        slug: "alchemy",
        name: "Alchemy",
        statusPage: "https://status.alchemy.com",
        website: null,
        paused: false,
        chains: {},
        // Lower-cased: a casing change upstream must not read as a new state.
        official: {
          status: "operational",
          description: "All Systems Operational",
          fetchedAt: "2026-08-21T15:20:00Z",
        },
        measuredStatus: "unconfigured",
        officialLastChangeAt: null,
        measuredLastChangeAt: null,
      },
    ]);
    // Components reach the wire only through a chain verdict, never in bulk.
    expect(JSON.stringify(vendors)).not.toContain("components");
  });

  it("drops a status-page link that isn't an http(s) url", () => {
    // These land in an href; `javascript:` is not a link.
    const [vendor] = normalizeVendors([
      { slug: "x", status_page: "javascript:alert(1)", website: "data:text/html,x" },
    ]) as [{ statusPage: string | null; website: string | null }];
    expect(vendor.statusPage).toBeNull();
    expect(vendor.website).toBeNull();
  });

  it("calls a missing official block `unknown` rather than dropping the vendor", () => {
    expect(normalizeVendors([{ slug: "tenderly" }])?.[0]).toMatchObject({
      slug: "tenderly",
      name: "tenderly",
      official: { status: "unknown", description: null, fetchedAt: null },
      measuredStatus: null,
    });
  });

  it("drops rows with no slug — nothing can join them to an upstream", () => {
    expect(normalizeVendors([{ name: "Nameless" }, LIST[0]])).toHaveLength(1);
  });

  it("is null for a payload that isn't a list, and empty for an empty one", () => {
    // "SPI knows no vendors" and "we could not read SPI" are different states.
    expect(normalizeVendors({ detail: "Not Found" })).toBeNull();
    expect(normalizeVendors([])).toEqual([]);
  });
});

describe("normalizeVendorDetail", () => {
  it("keeps names verbatim and lower-cases the states", () => {
    expect(
      normalizeVendorDetail({
        slug: "drpc",
        official: {
          status: "Operational",
          components: [
            { name: "Ethereum · Ethereum Mainnet", status: "Operational", uptime_percentage: 99.9 },
            { name: "   ", status: "major" },
          ],
        },
      }),
    ).toEqual({
      officialStatus: "operational",
      components: [{ name: "Ethereum · Ethereum Mainnet", status: "operational" }],
    });
  });

  it("is an empty component list — not null — for a vendor with no feed", () => {
    expect(normalizeVendorDetail({ slug: "grove", official: { status: "unavailable" } })).toEqual({
      officialStatus: "unavailable",
      components: [],
    });
  });

  it("is null for a body that isn't a provider object", () => {
    expect(normalizeVendorDetail([1, 2, 3])).toBeNull();
    expect(normalizeVendorDetail("nope")).toBeNull();
  });
});
