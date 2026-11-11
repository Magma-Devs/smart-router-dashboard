import { describe, expect, it } from "vitest";
import {
  routerFailureIsResult,
  routerPathOf,
  routerRelayPayload,
  routerReplyErrored,
} from "../router-relay";
import type { ResolvedGrpc, ResolvedHttp, ResolvedWs } from "../build-request";

const POST: ResolvedHttp = {
  transport: "http",
  httpMethod: "POST",
  url: "https://ethereum.jsonrpc.rpc.example.com",
  body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
  contentType: "application/json",
};

const REST_GET: ResolvedHttp = {
  transport: "http",
  httpMethod: "GET",
  url: "https://cosmos.rest.rpc.example.com/cosmos/base/tendermint/v1beta1/blocks/latest?x=1",
  body: null,
  contentType: null,
};

const WS: ResolvedWs = {
  transport: "ws",
  url: "wss://ethereum.jsonrpc.rpc.example.com/ws",
  body: { jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] },
};

describe("routerPathOf", () => {
  it("keeps the path and query, and drops the public host", () => {
    expect(routerPathOf("https://ethereum.jsonrpc.rpc.example.com")).toBe("/");
    expect(routerPathOf(REST_GET.url)).toBe("/cosmos/base/tendermint/v1beta1/blocks/latest?x=1");
    expect(routerPathOf("ws://localhost:3361/websocket")).toBe("/websocket");
  });

  it("falls back to the root for something that is not a url", () => {
    expect(routerPathOf("not a url")).toBe("/");
  });
});

describe("routerRelayPayload", () => {
  it("names the router and the listener, and carries the envelope and both directives", () => {
    const out = routerRelayPayload({
      routerId: "ETH1",
      iface: "jsonrpc",
      resolved: POST,
      selectUpstream: "eth-publicnode",
      skipCache: true,
    });
    expect(out).toEqual({
      ok: true,
      payload: {
        routerId: "ETH1",
        iface: "jsonrpc",
        transport: "http",
        httpMethod: "POST",
        path: "/",
        body: POST.body,
        selectProvider: "eth-publicnode",
        forceCacheRefresh: true,
      },
    });
  });

  it("leaves out a directive that is unset, and a body a REST call does not have", () => {
    const out = routerRelayPayload({ routerId: "COSMOSHUB", iface: "rest", resolved: REST_GET, skipCache: false });
    expect(out).toEqual({
      ok: true,
      payload: {
        routerId: "COSMOSHUB",
        iface: "rest",
        transport: "http",
        httpMethod: "GET",
        path: "/cosmos/base/tendermint/v1beta1/blocks/latest?x=1",
      },
    });
  });

  it("sends a socket on the base listener's path, with no directives — the router reads none there", () => {
    const out = routerRelayPayload({
      routerId: "ETH1",
      iface: "jsonrpc",
      resolved: WS,
      selectUpstream: "eth-publicnode",
      skipCache: true,
    });
    expect(out).toEqual({
      ok: true,
      payload: { routerId: "ETH1", iface: "jsonrpc", transport: "ws", path: "/ws", body: WS.body },
    });
  });

  it("refuses gRPC, which neither transport can carry", () => {
    const grpc: ResolvedGrpc = {
      transport: "grpc",
      url: "cosmos.grpc.rpc.example.com:443",
      service: "cosmos.base.tendermint.v1beta1.Service",
      methodName: "GetLatestBlock",
      fqMethod: "cosmos.base.tendermint.v1beta1.Service/GetLatestBlock",
      body: {},
    };
    expect(routerRelayPayload({ routerId: "COSMOSHUB", iface: "grpc", resolved: grpc, skipCache: false }).ok).toBe(
      false,
    );
  });
});

describe("routerFailureIsResult", () => {
  it("shows a router that never answered as a result, on either transport", () => {
    expect(routerFailureIsResult(504, "http")).toBe(true);
    expect(routerFailureIsResult(504, "ws")).toBe(true);
  });

  it("shows a refused or dropped socket as a result, as a browser socket that fails to open is", () => {
    expect(routerFailureIsResult(502, "ws")).toBe(true);
  });

  it("raises an HTTP send that cannot reach the router, and anything the relay refuses", () => {
    expect(routerFailureIsResult(502, "http")).toBe(false);
    for (const status of [400, 401, 404, 429, 500]) {
      expect(routerFailureIsResult(status, "ws"), String(status)).toBe(false);
      expect(routerFailureIsResult(status, "http"), String(status)).toBe(false);
    }
  });
});

describe("routerReplyErrored", () => {
  it("is an error outside 2xx, on a JSON-RPC error, or on GraphQL errors", () => {
    expect(routerReplyErrored({ httpStatus: 503, body: { _raw: "busy" } })).toBe(true);
    expect(routerReplyErrored({ httpStatus: 200, body: { error: { code: -32000 } } })).toBe(true);
    expect(routerReplyErrored({ httpStatus: 200, body: { errors: [{ message: "x" }] } })).toBe(true);
  });

  it("is fine on a 2xx with a result, and on a socket reply with no status", () => {
    expect(routerReplyErrored({ httpStatus: 200, body: { result: "0x1" } })).toBe(false);
    expect(routerReplyErrored({ httpStatus: null, body: { result: "0x1" } })).toBe(false);
    expect(routerReplyErrored({ httpStatus: null, body: { error: { code: -32601 } } })).toBe(true);
  });
});
