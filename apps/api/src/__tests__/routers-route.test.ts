/**
 * `POST /api/routers/relay` and `POST /api/routers/ws-probe` — the Try-me
 * drawer's "via router" leg, sent by the api.
 *
 * The values dir is pointed at a temp mount BEFORE the app (and its config
 * snapshot) is imported, so these run against a values file we control. The
 * routes exist only with accounts on, so the main block boots the api with
 * AUTH_MODE=enabled against an in-process Postgres and signs a user in.
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
    expect(calls[0]!.init.headers).toEqual({
      "lava-select-provider": "eth-publicnode",
      "lava-force-cache-refresh": "true",
      "content-type": "application/json",
    });
  });

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
    for (const path of ["//evil.example/x", "/a/../b", "no-slash"]) {
      const res = await post("/api/routers/relay", { routerId: "ETH1", iface: "jsonrpc", path });
      expect(res.statusCode, path).toBe(400);
    }
    expect(calls).toEqual([]);
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
    expect(calls[0]!.init.headers).toMatchObject({ "lava-select-provider": "café eth-1" });
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

  it("does not exist, so nobody can reach a gated tenant's routers through an anonymous api", async () => {
    const calls = stubRouter(() => new Response("{}"));
    for (const url of ["/api/routers/relay", "/api/routers/ws-probe"]) {
      const res = await app.inject({ method: "POST", url, payload: { routerId: "ETH1", iface: "jsonrpc" } });
      expect(res.statusCode, url).toBe(404);
    }
    expect(calls).toEqual([]);
  });
});
