import { describe, expect, it } from "vitest";
import {
  directAvailableFor,
  relayPayloadFor,
  withUpstreamPlaceholder,
  UPSTREAM_URL_PLACEHOLDER,
  type DirectTarget,
} from "../direct-request";
import type { ResolvedHttp, ResolvedWs, ResolvedGrpc } from "../build-request";

const TARGET: DirectTarget = {
  routerId: "ETH1",
  node: "eth-publicnode",
  httpIndex: 0,
  wsIndex: 1,
  httpHost: "https://ethereum-rpc.publicnode.com",
  wsHost: "wss://ethereum-rpc.publicnode.com",
};

const POST: ResolvedHttp = {
  transport: "http",
  httpMethod: "POST",
  url: "http://localhost:3360",
  body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
  contentType: "application/json",
};

const GET: ResolvedHttp = {
  transport: "http",
  httpMethod: "GET",
  url: "http://localhost:3364/cosmos/base/tendermint/v1beta1/blocks/latest",
  body: null,
  contentType: null,
};

const WS: ResolvedWs = {
  transport: "ws",
  url: "ws://localhost:3360/ws",
  body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
};

const GRPC: ResolvedGrpc = {
  transport: "grpc",
  url: "localhost:3366",
  service: "cosmos.base.tendermint.v1beta1.Service",
  methodName: "GetLatestBlock",
  fqMethod: "cosmos.base.tendermint.v1beta1.Service/GetLatestBlock",
  body: {},
};

describe("relayPayloadFor", () => {
  it("addresses the upstream by identity, never by url", () => {
    const out = relayPayloadFor({ resolved: POST, paramsText: "[]", iface: "jsonrpc", target: TARGET });
    expect(out).toEqual({
      ok: true,
      payload: {
        routerId: "ETH1",
        node: "eth-publicnode",
        endpointIndex: 0,
        transport: "http",
        httpMethod: "POST",
        body: POST.body,
      },
    });
    // Nothing dialable may appear in the payload — the api resolves the url.
    expect(JSON.stringify(out)).not.toContain("localhost:3360");
  });

  it("passes a REST path through as a path, not a url", () => {
    const out = relayPayloadFor({
      resolved: GET,
      paramsText: " /cosmos/base/tendermint/v1beta1/blocks/latest ",
      iface: "rest",
      target: { ...TARGET, httpIndex: 0 },
    });
    expect(out).toMatchObject({
      ok: true,
      payload: { httpMethod: "GET", path: "/cosmos/base/tendermint/v1beta1/blocks/latest" },
    });
  });

  it("does not treat jsonrpc params as a path", () => {
    const out = relayPayloadFor({ resolved: POST, paramsText: '["latest"]', iface: "jsonrpc", target: TARGET });
    expect(out.ok).toBe(true);
    expect(out.ok && out.payload.path).toBeUndefined();
  });

  it("switches to the node's ws endpoint on the ws transport", () => {
    const out = relayPayloadFor({ resolved: WS, paramsText: "[]", iface: "jsonrpc-ws", target: TARGET });
    expect(out).toMatchObject({ ok: true, payload: { endpointIndex: 1, transport: "ws" } });
  });

  it("explains itself when the upstream has no url for the transport", () => {
    const noWs = { ...TARGET, wsIndex: null, wsHost: null };
    expect(relayPayloadFor({ resolved: WS, paramsText: "", iface: "jsonrpc-ws", target: noWs })).toEqual({
      ok: false,
      error: "This upstream has no WebSocket url in the values file.",
    });
    const noHttp = { ...TARGET, httpIndex: null, httpHost: null };
    expect(relayPayloadFor({ resolved: POST, paramsText: "", iface: "jsonrpc", target: noHttp })).toMatchObject({
      ok: false,
    });
  });

  it("refuses gRPC — the relay has no gRPC client", () => {
    const out = relayPayloadFor({ resolved: GRPC, paramsText: "{}", iface: "grpc", target: TARGET });
    expect(out.ok).toBe(false);
  });
});

describe("withUpstreamPlaceholder", () => {
  it("replaces the router address so no snippet prints a dialable upstream url", () => {
    const out = withUpstreamPlaceholder(POST, "http://localhost:3360");
    expect(out.url).toBe(UPSTREAM_URL_PLACEHOLDER);
  });

  it("keeps the REST path after the placeholder", () => {
    const out = withUpstreamPlaceholder(GET, "http://localhost:3364");
    expect(out.url).toBe(`${UPSTREAM_URL_PLACEHOLDER}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  });

  it("falls back to the bare placeholder when the base doesn't match", () => {
    expect(withUpstreamPlaceholder(POST, "http://elsewhere:9999").url).toBe(UPSTREAM_URL_PLACEHOLDER);
  });
});

describe("directAvailableFor", () => {
  it("follows the transport currently selected", () => {
    expect(directAvailableFor(TARGET, false)).toBe(true);
    expect(directAvailableFor(TARGET, true)).toBe(true);
    expect(directAvailableFor({ ...TARGET, wsIndex: null }, true)).toBe(false);
    expect(directAvailableFor({ ...TARGET, httpIndex: null }, false)).toBe(false);
    expect(directAvailableFor(null, false)).toBe(false);
  });
});
