/**
 * `POST /api/routers/relay` and `POST /api/routers/ws-probe` — the Try-me
 * drawer's "via router" leg, sent by the api.
 *
 * The values dir is pointed at a temp mount BEFORE the app (and its config
 * snapshot) is imported, so these run against a values file we control. The
 * main block boots the api with AUTH_MODE=enabled against an in-process
 * Postgres and signs a user in; the blocks after it run with accounts off,
 * and with the relay switched off.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { users } from "@sr/db";

const VALUES = `
routers:
  - id: ETH1
    network: eth
    nodes:
      - name: eth-publicnode
        endpoints:
          - url: https://ethereum-rpc.publicnode.com
            interface: jsonrpc
  - id: Cosmos
    network: cosmoshub
    nodes:
      - name: cosmos-vendor
        endpoints:
          - url: https://rest.vendor.example
            interface: rest
          - url: grpcs://grpc.vendor.example:443
            interface: grpc
`;

const dir = mkdtempSync(join(tmpdir(), "srdash-router-relay-"));
mkdirSync(join(dir, "core"), { recursive: true });
writeFileSync(join(dir, "core", "values.yml"), VALUES);
process.env.HELM_VALUES_DIR = dir;

const SECRET = "test-secret-for-auth-tests-32-chars!";
const TOTP_KEY = "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=";
// Unroutable per RFC 5737 — the lazy connect loop fails fast and pglite is
// swapped in by hand.
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";

const { config } = await import("../config.js");
const { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } = await import("../plugins/auth.js");
const { createSession } = await import("../services/sessions.js");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The dashboard's own api calls go through `inject`, never fetch, so a stub
 *  sees only what the relay dials. */
function stubRouter(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  });
  return calls;
}

/**
 * A router of one generation, as far as the relay can tell them apart: it
 * acts on its own spelling of the directives and on no other, and answers in
 * its own header family. Pinned, it is served by the upstream named; unpinned
 * it picks `picked-by-router`. A request it isn't told to refresh is a cache
 * hit.
 */
function stubRouterOf(generation: "current" | "legacy") {
  const mine =
    generation === "current"
      ? { pin: "smartrouter-select-provider", refresh: "smartrouter-force-cache-refresh", served: "Smart-Router-Provider-Address", retries: "Smart-Router-Retries" }
      : { pin: "lava-select-provider", refresh: "lava-force-cache-refresh", served: "Lava-Provider-Address", retries: "Lava-Retries" };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const sent = new Headers(init.headers);
    const upstream = sent.get(mine.pin) ?? "picked-by-router";
    const servedBy = sent.has(mine.refresh) ? upstream : "Cached";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }), {
      status: 200,
      headers: { [mine.served]: servedBy, [mine.retries]: "0" },
    });
  });
}

/** A router that takes the request and answers only when told to. */
function stubHeldRouter() {
  const waiting: (() => void)[] = [];
  vi.stubGlobal(
    "fetch",
    () => new Promise<Response>((resolve) => waiting.push(() => resolve(new Response("{}")))),
  );
  return {
    held: () => waiting.length,
    answerAll: () => {
      for (const answer of waiting.splice(0)) answer();
    },
  };
}

describe("router relay · AUTH_MODE=enabled", () => {
  let app: FastifyInstance;
  let t: TestDb;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      AUTH_MODE: "enabled",
      AUTH_SECRET: SECRET,
      TOTP_ENCRYPTION_KEY: TOTP_KEY,
      DATABASE_URL: DEAD_DB,
      INTERNAL_AUTH_SECRET: "internal-secret-for-tests",
    })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    t = await createTestDb();
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    app.db = t.db;
    await app.ready();

    token = await signIn("viewer@example.com");
  });

  /** A session token for a new user of the lowest role: any signed-in user
   *  may send through the router. */
  async function signIn(email: string): Promise<string> {
    const [user] = await t.db
      .insert(users)
      .values({ email, name: "Viewer", role: "read_only", ...enrolledTwoFactor() })
      .returning();
    const session = await createSession(t.db, {
      userId: user!.id,
      authMethod: "password",
      client: { ip: "203.0.113.9", userAgent: "test" },
    });
    return new SignJWT({ sub: user!.id, email: user!.email, role: "read_only", sid: session.id })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(SESSION_JWT_ISSUER)
      .setAudience(SESSION_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
  }

  afterAll(async () => {
    await app.close();
    await t.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** `as`: `true` is the viewer, `false` nobody, a string another user's token. */
  function post(url: string, payload: Record<string, unknown>, as: boolean | string = true) {
    const opts: InjectOptions = { method: "POST", url, payload };
    if (as !== false) opts.headers = { authorization: `Bearer ${as === true ? token : as}` };
    return app.inject(opts);
  }

  it("refuses an anonymous caller before anything is dialled", async () => {
    const calls = stubRouter(() => new Response("{}"));
    const res = await post("/api/routers/relay", { routerId: "ETH1", iface: "jsonrpc" }, false);
    expect(res.statusCode).toBe(401);
    const probe = await post("/api/routers/ws-probe", { routerId: "ETH1", iface: "jsonrpc", path: "/ws" }, false);
    expect(probe.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("sends a signed-in user's request to the router's in-cluster Service and returns its telemetry", async () => {
    const calls = stubRouter(
      () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }), {
          status: 200,
          headers: { "Lava-Provider-Address": "eth-publicnode", "Lava-Retries": "0" },
        }),
    );
    const res = await post("/api/routers/relay", {
      routerId: "ETH1",
      iface: "jsonrpc",
      path: "/",
      body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      selectProvider: "eth-publicnode",
      forceCacheRefresh: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      httpStatus: 200,
      body: { result: "0x10" },
      transport: "http",
      servedBy: "eth-publicnode",
      retries: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://eth1-router:3000/");
    // Both spellings of each directive: the router reads its generation's.
    expect(calls[0]!.init.headers).toEqual({
      "smartrouter-select-provider": "eth-publicnode",
      "lava-select-provider": "eth-publicnode",
      "smartrouter-force-cache-refresh": "true",
      "lava-force-cache-refresh": "true",
      "content-type": "application/json",
    });
  });

  it.each(["current", "legacy"] as const)(
    "pins the relay and skips the cache on a %s-generation router, and reads its telemetry",
    async (generation) => {
      stubRouterOf(generation);
      const body = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };

      const pinned = await post("/api/routers/relay", {
        routerId: "ETH1",
        iface: "jsonrpc",
        body,
        selectProvider: "eth-publicnode",
        forceCacheRefresh: true,
      });
      expect(pinned.statusCode).toBe(200);
      expect(pinned.json()).toMatchObject({ httpStatus: 200, servedBy: "eth-publicnode", retries: 0 });

      // Without the cache skip the router answers from its cache, and without
      // the pin it picks the upstream: the directives above did the work.
      const cached = await post("/api/routers/relay", { routerId: "ETH1", iface: "jsonrpc", body, selectProvider: "eth-publicnode" });
      expect(cached.json()).toMatchObject({ servedBy: "Cached", retries: 0 });
      const unpinned = await post("/api/routers/relay", { routerId: "ETH1", iface: "jsonrpc", body, forceCacheRefresh: true });
      expect(unpinned.json()).toMatchObject({ servedBy: "picked-by-router", retries: 0 });
    },
  );

  it("puts a REST path and its query on the router's listener for that interface", async () => {
    const calls = stubRouter(() => new Response("{}"));
    const res = await post("/api/routers/relay", {
      routerId: "Cosmos",
      iface: "rest",
      httpMethod: "GET",
      path: "/cosmos/base/tendermint/v1beta1/blocks/latest?x=1",
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.url).toBe("http://cosmos-router:3000/cosmos/base/tendermint/v1beta1/blocks/latest?x=1");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("answers 200 with the router's own error status inside", async () => {
    stubRouter(() => new Response("upstream busy", { status: 503 }));
    const res = await post("/api/routers/relay", { routerId: "ETH1", iface: "jsonrpc", body: { id: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ httpStatus: 503, body: { _raw: "upstream busy" } });
  });

  it("404s a router or an interface the values file does not declare", async () => {
    const calls = stubRouter(() => new Response("{}"));
    expect((await post("/api/routers/relay", { routerId: "SOLANA", iface: "jsonrpc" })).statusCode).toBe(404);
    expect((await post("/api/routers/relay", { routerId: "ETH1", iface: "rest" })).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it("404s an interface named after a key every object inherits", async () => {
    // `ports.constructor` is a function, not a port: the lookup must read the
    // values file's own interfaces only.
    const calls = stubRouter(() => new Response("{}"));
    for (const iface of ["constructor", "toString", "__proto__"]) {
      const res = await post("/api/routers/relay", { routerId: "ETH1", iface });
      expect(res.statusCode, iface).toBe(404);
      const probe = await post("/api/routers/ws-probe", { routerId: "ETH1", iface, path: "/ws" });
      expect(probe.statusCode, iface).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a gRPC listener, which neither transport can speak", async () => {
    const res = await post("/api/routers/relay", { routerId: "Cosmos", iface: "grpc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("gRPC");
  });

  it("refuses a path that could leave the router's listener", async () => {
    const calls = stubRouter(() => new Response("{}"));
    for (const path of ["//evil.example/x", "/a/../b", "/a/%2e%2E/b", "/a\\b", "/a b", "no-slash"]) {
      const res = await post("/api/routers/relay", { routerId: "ETH1", iface: "jsonrpc", path });
      expect(res.statusCode, path).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("puts a REST query on the wire as written, as a browser does", async () => {
    const calls = stubRouter(() => new Response("{}"));
    const path = "/cosmos/tx/v1beta1/txs?events=tx.height=5&q=a%20b&bin=%FF%FE&flag&range=1..5&x=a/b,c:d";
    const res = await post("/api/routers/relay", { routerId: "Cosmos", iface: "rest", httpMethod: "GET", path });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.url).toBe(`http://cosmos-router:3000${path}`);
  });

  it("lets one caller hold two relays in flight, and no third", async () => {
    const router = stubHeldRouter();
    const send = { routerId: "ETH1", iface: "jsonrpc", body: { id: 1 } };
    const first = Promise.resolve(post("/api/routers/relay", send));
    const second = Promise.resolve(post("/api/routers/relay", send));
    await vi.waitFor(() => expect(router.held()).toBe(2));

    const third = await post("/api/routers/relay", send);
    expect(third.statusCode).toBe(429);
    expect(third.json().message).toContain("still on their way");
    expect(router.held()).toBe(2);

    router.answerAll();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    // Both slots are back.
    stubRouter(() => new Response("{}"));
    expect((await post("/api/routers/relay", send)).statusCode).toBe(200);
  });

  it("gives a slot back when the router cannot be reached", async () => {
    const send = { routerId: "ETH1", iface: "jsonrpc", body: { id: 1 } };
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    for (let i = 0; i < 3; i++) expect((await post("/api/routers/relay", send)).statusCode).toBe(502);
  });

  it("refuses a pin that would not survive as a header value", async () => {
    // A line break would inject a header; a character past U+00FF is one the
    // HTTP client cannot encode, and would read as the router being down.
    const calls = stubRouter(() => new Response("{}"));
    for (const selectProvider of ["eth-publicnode\r\nx-injected: 1", "eth\tpublicnode", "eth-节点", "eth-😀"]) {
      const res = await post("/api/routers/relay", { routerId: "ETH1", iface: "jsonrpc", selectProvider });
      expect(res.statusCode, selectProvider).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("sends a pin in the bytes a header can carry", async () => {
    const calls = stubRouter(() => new Response("{}"));
    const res = await post("/api/routers/relay", { routerId: "ETH1", iface: "jsonrpc", selectProvider: "café eth-1" });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.init.headers).toMatchObject({
      "smartrouter-select-provider": "café eth-1",
      "lava-select-provider": "café eth-1",
    });
  });

  it("is a 502 when the router cannot be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    const res = await post("/api/routers/relay", { routerId: "ETH1", iface: "jsonrpc", body: { id: 1 } });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("ENOTFOUND");
  });

  it("probes a listener the values file does not declare as a 404, not as offline", async () => {
    const res = await post("/api/routers/ws-probe", { routerId: "SOLANA", iface: "jsonrpc", path: "/ws" });
    expect(res.statusCode).toBe(404);
  });

  it("reports a listener nobody answers on as offline", async () => {
    // eth1-router does not resolve outside a cluster, which is the case this
    // reads as: the upgrade was not served.
    const res = await post("/api/routers/ws-probe", { routerId: "ETH1", iface: "jsonrpc", path: "/ws" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ online: false });
  });

  it("budgets each signed-in user on their own, and each route on its own", async () => {
    stubRouter(() => new Response("{}"));
    const other = await signIn("second@example.com");
    const send = { routerId: "ETH1", iface: "jsonrpc", body: { id: 1 } };
    for (let i = 0; i < config.routerRelay.rateLimitMax; i++) {
      expect((await post("/api/routers/relay", send, other)).statusCode, `send ${i + 1}`).toBe(200);
    }
    expect((await post("/api/routers/relay", send, other)).statusCode).toBe(429);
    // Every inject comes from 127.0.0.1, so a budget kept per address would
    // have spent the viewer's too.
    expect((await post("/api/routers/relay", send)).statusCode).toBe(200);
    // The probe counts apart from the relay: this is its own 404, not a 429.
    const probe = await post("/api/routers/ws-probe", { routerId: "SOLANA", iface: "jsonrpc" }, other);
    expect(probe.statusCode).toBe(404);
  });
});

describe("router relay · AUTH_MODE=disabled", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const send = { routerId: "ETH1", iface: "jsonrpc", body: { id: 1 } };

  it("sends for anyone who reaches the api, as every other route there answers", async () => {
    const calls = stubRouter(() => new Response(JSON.stringify({ result: "0x10" })));
    const res = await app.inject({ method: "POST", url: "/api/routers/relay", payload: send });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ httpStatus: 200, body: { result: "0x10" } });
    expect(calls.map((c) => c.url)).toEqual(["http://eth1-router:3000/"]);
  });

  it("tells the drawer that the api sends the router leg", async () => {
    const res = await app.inject({ method: "GET", url: "/api/config/routers" });
    expect(res.json().routerRelay).toBe(true);
    expect(res.json().routers).toHaveLength(2);
  });

  it("budgets a caller with no account by address", async () => {
    stubRouter(() => new Response("{}"));
    const from = (remoteAddress: string) =>
      app.inject({ method: "POST", url: "/api/routers/relay", payload: send, remoteAddress });
    for (let i = 0; i < config.routerRelay.rateLimitMax; i++) {
      expect((await from("198.51.100.7")).statusCode, `send ${i + 1}`).toBe(200);
    }
    expect((await from("198.51.100.7")).statusCode).toBe(429);
    expect((await from("198.51.100.8")).statusCode).toBe(200);
  });
});

describe("router relay · ROUTER_RELAY_ENABLED=false", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.resetModules();
    process.env.ROUTER_RELAY_ENABLED = "false";
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ROUTER_RELAY_ENABLED;
    vi.resetModules();
  });

  it("404s both routes, so nobody reaches the routers through the api", async () => {
    const calls = stubRouter(() => new Response("{}"));
    for (const url of ["/api/routers/relay", "/api/routers/ws-probe"]) {
      const res = await app.inject({ method: "POST", url, payload: { routerId: "ETH1", iface: "jsonrpc" } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().message, url).toContain("ROUTER_RELAY_ENABLED=false");
    }
    expect(calls).toEqual([]);
  });

  it("tells the drawer to send the router leg from the browser", async () => {
    const res = await app.inject({ method: "GET", url: "/api/config/routers" });
    expect(res.json().routerRelay).toBe(false);
  });
});

describe("router relay · ROUTER_RELAY_MAX_IN_FLIGHT", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.resetModules();
    process.env.ROUTER_RELAY_MAX_IN_FLIGHT = "1";
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ROUTER_RELAY_MAX_IN_FLIGHT;
    vi.resetModules();
  });

  it("answers 503 to a second caller while the one slot is held", async () => {
    const router = stubHeldRouter();
    const from = (remoteAddress: string) =>
      app.inject({
        method: "POST",
        url: "/api/routers/relay",
        payload: { routerId: "ETH1", iface: "jsonrpc", body: { id: 1 } },
        remoteAddress,
      });
    const first = Promise.resolve(from("198.51.100.20"));
    await vi.waitFor(() => expect(router.held()).toBe(1));
    expect((await from("198.51.100.21")).statusCode).toBe(503);
    router.answerAll();
    expect((await first).statusCode).toBe(200);
  });
});
