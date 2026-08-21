import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import {
  VendorStatusService,
  normalizeVendors,
  providerStatusUrl,
} from "../services/vendor-status.js";

/**
 * One row of the SPI list route, verbatim in shape: the official block is
 * FLAT here (`official_*`), nested only on the per-slug detail route. Both
 * shapes are normalized, so the dashboard survives either build of SPI.
 */
const SPI_ROW = {
  slug: "drpc",
  name: "dRPC",
  website: "https://drpc.org",
  status_page: "https://status.drpc.org",
  paused: false,
  official_status: "minor",
  official_description: "SOMEDEGRADEDPERFORMANCE · 44/45 components operational",
  official_fetched_at: "2026-08-21T15:20:00.018790Z",
  official_last_change_at: "2026-08-21T07:07:00.038588Z",
  measured_status: "unconfigured",
  measured_last_change_at: null,
};

/** Answers the SPI list route with `body`; counts the calls it took. */
function stubSpi(body: unknown, init?: ResponseInit): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    calls.push(typeof input === "string" ? input : input.toString());
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });
  });
  return { calls };
}

describe("GET /api/vendors/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("hands back the index's rows camel-cased, and nothing else", async () => {
    const { calls } = stubSpi([SPI_ROW]);
    const res = await app.inject({ method: "GET", url: "/api/vendors/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(calls[0]).toContain("/v1/public/provider-status");
    expect(body.vendors).toEqual([
      {
        slug: "drpc",
        name: "dRPC",
        statusPage: "https://status.drpc.org",
        website: "https://drpc.org",
        paused: false,
        official: {
          status: "minor",
          description: "SOMEDEGRADEDPERFORMANCE · 44/45 components operational",
          fetchedAt: "2026-08-21T15:20:00.018790Z",
        },
        measuredStatus: "unconfigured",
        officialLastChangeAt: "2026-08-21T07:07:00.038588Z",
        measuredLastChangeAt: null,
      },
    ]);
    expect(Date.parse(body.fetchedAt)).not.toBeNaN();
  });

  it("answers 200 with vendors:null when the index is unreachable", async () => {
    // Someone else's outage is not a dashboard error: a 5xx here would light
    // up the browser's error state on every page.
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const res = await app.inject({ method: "GET", url: "/api/vendors/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().vendors).toBeNull();
  });

  it("answers vendors:null when the index answers something that isn't JSON", async () => {
    stubSpi("<html>502 Bad Gateway</html>");
    const res = await app.inject({ method: "GET", url: "/api/vendors/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().vendors).toBeNull();
  });

  it("answers vendors:null on a non-2xx from the index", async () => {
    stubSpi({ detail: "rate limited" }, { status: 429 });
    const res = await app.inject({ method: "GET", url: "/api/vendors/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().vendors).toBeNull();
  });

  it("serves a second caller from the cache — SPI allows 30 reads a minute", async () => {
    const { calls } = stubSpi([SPI_ROW]);
    const first = await app.inject({ method: "GET", url: "/api/vendors/status" });
    const second = await app.inject({ method: "GET", url: "/api/vendors/status" });
    expect(calls).toHaveLength(1);
    expect(second.json()).toEqual(first.json());
  });
});

describe("VendorStatusService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const service = (ttlMs: number) =>
    new VendorStatusService({ baseUrl: "http://spi.test/", timeoutMs: 5000, ttlMs });

  it("reads the list route off the configured base, trailing slash or not", () => {
    expect(providerStatusUrl("http://spi.test")).toBe("http://spi.test/v1/public/provider-status");
    expect(providerStatusUrl("http://spi.test///")).toBe("http://spi.test/v1/public/provider-status");
  });

  it("re-reads once the cache expires", async () => {
    vi.useFakeTimers();
    const { calls } = stubSpi([SPI_ROW]);
    const svc = service(60_000);
    await svc.read();
    vi.advanceTimersByTime(59_000);
    await svc.read();
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    await svc.read();
    expect(calls).toHaveLength(2);
  });

  it("caches a failure too — a down index costs one attempt a minute", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL | string) => {
      calls.push(String(input));
      throw new Error("nope");
    });
    const svc = service(60_000);
    expect((await svc.read()).vendors).toBeNull();
    expect((await svc.read()).vendors).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("deadlines the call rather than holding a dashboard open", async () => {
    const signals: (AbortSignal | undefined | null)[] = [];
    vi.stubGlobal("fetch", async (_input: URL | string, init: RequestInit) => {
      signals.push(init.signal);
      return new Response("[]", { status: 200 });
    });
    await service(60_000).read();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("normalizeVendors", () => {
  it("reads the detail route's NESTED official block, and forwards no components", () => {
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
          components: [{ name: "Ethereum Mainnet", status: "operational" }],
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
    expect(JSON.stringify(vendors)).not.toContain("components");
  });

  it("calls a missing official block `unknown` rather than dropping the vendor", () => {
    const vendors = normalizeVendors([{ slug: "tenderly" }]);
    expect(vendors?.[0]).toMatchObject({
      slug: "tenderly",
      name: "tenderly",
      official: { status: "unknown", description: null, fetchedAt: null },
      measuredStatus: null,
    });
  });

  it("drops rows with no slug — nothing can join them to an upstream", () => {
    expect(normalizeVendors([{ name: "Nameless" }, SPI_ROW])).toHaveLength(1);
  });

  it("is null for a payload that isn't a list, and empty for an empty one", () => {
    // "SPI knows no vendors" and "we could not read SPI" are different states.
    expect(normalizeVendors({ detail: "Not Found" })).toBeNull();
    expect(normalizeVendors([])).toEqual([]);
  });
});
