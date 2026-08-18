/**
 * `POST /api/upstreams/relay` — the route that dials a configured upstream
 * with the router out of the path.
 *
 * The values dir is pointed at a temp mount BEFORE the app (and its config
 * snapshot) is imported, so these run against a values file we control.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const VALUES = `
endpoints:
  - listen-address: "0.0.0.0:3360"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
  - listen-address: "0.0.0.0:3364"
    chain-id: "COSMOSHUB"
    api-interface: "rest"
direct-rpc:
  - name: "eth-vendor"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://rpc.vendor.example/v2/sk-live-abcdef123456"
      - url: "wss://rpc.vendor.example/v2/sk-live-abcdef123456"
  - name: "cosmos-rest"
    chain-id: "COSMOSHUB"
    api-interface: "rest"
    node-urls:
      - url: "https://rest.vendor.example/apikey-abcdef12"
  - name: "cosmos-grpc"
    chain-id: "COSMOSHUB"
    api-interface: "grpc"
    node-urls:
      - url: "grpcs://grpc.vendor.example:443"
`;

const dir = mkdtempSync(join(tmpdir(), "srdash-relay-"));
mkdirSync(join(dir, "core"), { recursive: true });
writeFileSync(join(dir, "core", "values.yml"), VALUES);
process.env.HELM_VALUES_DIR = dir;

const { buildApp } = await import("../app.js");

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

function relay(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/upstreams/relay", payload });
}

describe("POST /api/upstreams/relay", () => {
  it("dials the FULL url from the values file — the one the browser never sees", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ result: "0x1" }), { status: 200 });
    });

    const res = await relay({
      routerId: "ETH1",
      node: "eth-vendor",
      endpointIndex: 0,
      httpMethod: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.httpStatus).toBe(200);
    expect(json.body).toEqual({ result: "0x1" });
    expect(json.transport).toBe("http");
    expect(typeof json.latencyMs).toBe("number");
    expect(seen).toEqual(["https://rpc.vendor.example/v2/sk-live-abcdef123456"]);
    // The response must not carry the url back out in any form.
    expect(res.body).not.toContain("sk-live-abcdef123456");
  });

  it("appends a REST path to the key-bearing base path", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ block: {} }), { status: 200 });
    });

    const res = await relay({
      routerId: "COSMOSHUB",
      node: "cosmos-rest",
      endpointIndex: 0,
      httpMethod: "GET",
      path: "/cosmos/base/tendermint/v1beta1/blocks/latest",
    });

    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([
      "https://rest.vendor.example/apikey-abcdef12/cosmos/base/tendermint/v1beta1/blocks/latest",
    ]);
  });

  it("scrubs a key the upstream echoed back before returning the body", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(`{"error":"bad project sk-live-abcdef123456"}`, { status: 401 }),
    );
    const res = await relay({ routerId: "ETH1", node: "eth-vendor", endpointIndex: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.json().httpStatus).toBe(401);
    expect(res.body).not.toContain("sk-live-abcdef123456");
    expect(res.body).toContain("redacted");
  });

  it("404s on an endpoint that isn't in the mounted config", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    for (const payload of [
      { routerId: "NOPE", node: "eth-vendor", endpointIndex: 0 },
      { routerId: "ETH1", node: "not-a-node", endpointIndex: 0 },
      { routerId: "ETH1", node: "eth-vendor", endpointIndex: 9 },
    ]) {
      const res = await relay(payload);
      expect(res.statusCode).toBe(404);
      // Same message for all three — no probing the config through it.
      expect(res.json().message).toBe("No such upstream endpoint in the mounted config.");
    }
  });

  it("rejects a path that tries to escape the upstream's own path", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 200 });
    });
    for (const path of ["/../../admin", "//evil.example.com/x", "blocks"]) {
      const res = await relay({
        routerId: "COSMOSHUB",
        node: "cosmos-rest",
        endpointIndex: 0,
        httpMethod: "GET",
        path,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it("refuses a transport that doesn't match the endpoint's scheme", async () => {
    const ws = await relay({ routerId: "ETH1", node: "eth-vendor", endpointIndex: 1, transport: "http" });
    expect(ws.statusCode).toBe(400);
    expect(ws.json().message).toContain("WebSocket url");

    const http = await relay({ routerId: "ETH1", node: "eth-vendor", endpointIndex: 0, transport: "ws" });
    expect(http.statusCode).toBe(400);
    expect(http.json().message).toContain("HTTP url");
  });

  it("refuses a grpc upstream — the relay has no gRPC client", async () => {
    const res = await relay({ routerId: "COSMOSHUB", node: "cosmos-grpc", endpointIndex: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("grpcs");
  });

  it("answers 504 when the upstream never does", async () => {
    vi.stubGlobal("fetch", async () => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    });
    const res = await relay({ routerId: "ETH1", node: "eth-vendor", endpointIndex: 0 });
    expect(res.statusCode).toBe(504);
  });

  it("answers 502 when the upstream can't be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    const res = await relay({ routerId: "ETH1", node: "eth-vendor", endpointIndex: 0 });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).not.toContain("sk-live");
  });

  it("rejects a body that names no endpoint", async () => {
    const res = await relay({ routerId: "ETH1" });
    expect(res.statusCode).toBe(400);
  });

  it("ignores a caller-supplied url — the target is never taken from input", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 200 });
    });
    const res = await relay({
      routerId: "ETH1",
      node: "eth-vendor",
      endpointIndex: 0,
      url: "https://evil.example.com",
    });
    // `additionalProperties: false` + fastify's `removeAdditional` strips the
    // field before the handler runs, so the only address the relay can dial
    // is still the one the values file names.
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual(["https://rpc.vendor.example/v2/sk-live-abcdef123456"]);
  });
});

describe("POST /api/upstreams/relay · UPSTREAM_RELAY_ENABLED=false", () => {
  let disabled: FastifyInstance;

  beforeAll(async () => {
    vi.resetModules();
    process.env.UPSTREAM_RELAY_ENABLED = "false";
    const mod = await import("../app.js");
    disabled = await mod.buildApp();
    await disabled.ready();
  });

  afterAll(async () => {
    await disabled.close();
    delete process.env.UPSTREAM_RELAY_ENABLED;
    vi.resetModules();
  });

  it("404s the whole route so the deployment can opt out", async () => {
    const res = await disabled.inject({
      method: "POST",
      url: "/api/upstreams/relay",
      payload: { routerId: "ETH1", node: "eth-vendor", endpointIndex: 0 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("UPSTREAM_RELAY_ENABLED=false");
  });
});
