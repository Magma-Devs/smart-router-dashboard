import { describe, expect, it } from "vitest";
import {
  directAvailableFor,
  relayPayloadFor,
  resolveDirectPath,
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

describe("directAvailableFor", () => {
  it("follows the transport currently selected", () => {
    expect(directAvailableFor(TARGET, false)).toBe(true);
    expect(directAvailableFor(TARGET, true)).toBe(true);
    expect(directAvailableFor({ ...TARGET, wsIndex: null }, true)).toBe(false);
    expect(directAvailableFor({ ...TARGET, httpIndex: null }, false)).toBe(false);
    expect(directAvailableFor(null, false)).toBe(false);
  });
});

/* ── Internal paths ───────────────────────────────────────────────────────
   A spec can split one interface across internal paths (TON's REST /v2 +
   /v3). The ROUTER leg is unaffected — it matches the api name and dials the
   upstream pinned to that name's collection. The DIRECT leg addresses one
   upstream url by hand, so it has to reproduce what the router would have
   built: prefix the path on a shared root, leave it off on a url already
   pinned to that version.                                                   */

describe("resolveDirectPath", () => {
  it("prefixes the method's path when the upstream serves the shared root", () => {
    // chainstack: one url for the whole chain, so the router auto-generates
    // `<url>/v2` and `<url>/v3` — the direct leg appends the same segment.
    expect(resolveDirectPath({ methodPath: "/v2", endpointPath: null })).toEqual({
      ok: true,
      prefix: "/v2",
    });
  });

  it("omits it when the upstream url IS that version's root", () => {
    // tatum: v2 is served at the host root and pinned with internal_path.
    // Prefixing would ask for `…/v2/v2/getMasterchainInfo`.
    expect(resolveDirectPath({ methodPath: "/v2", endpointPath: "/v2" })).toEqual({
      ok: true,
      prefix: "",
    });
  });

  it("refuses a method from another internal path", () => {
    const out = resolveDirectPath({ methodPath: "/v3", endpointPath: "/v2" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("/v2");
      expect(out.error).toContain("/v3");
    }
  });

  it("is a no-op for the chains that declare no internal path at all", () => {
    expect(resolveDirectPath({ methodPath: null, endpointPath: null })).toEqual({
      ok: true,
      prefix: "",
    });
    // A pinned upstream still serves a method the catalog has no path for.
    expect(resolveDirectPath({ methodPath: undefined, endpointPath: "/v2" })).toEqual({
      ok: true,
      prefix: "",
    });
  });
});

describe("relayPayloadFor — internal paths", () => {
  const TON_UNPINNED: DirectTarget = {
    routerId: "TON",
    node: "chainstack",
    httpIndex: 0,
    wsIndex: null,
    httpHost: "https://ton-mainnet.core.chainstack.com",
    wsHost: null,
    httpInternalPath: null,
    wsInternalPath: null,
  };
  const TON_V2: DirectTarget = {
    ...TON_UNPINNED,
    node: "tatum",
    httpHost: "https://ton-mainnet.gateway.tatum.io",
    httpInternalPath: "/v2",
  };
  const REST_GET: ResolvedHttp = {
    transport: "http",
    httpMethod: "GET",
    url: "http://localhost:3460/getMasterchainInfo",
    body: null,
    contentType: null,
  };

  it("prepends the version to the REST path on an unpinned upstream", () => {
    const out = relayPayloadFor({
      resolved: REST_GET,
      paramsText: "/getMasterchainInfo",
      iface: "rest",
      target: TON_UNPINNED,
      methodInternalPath: "/v2",
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload.path).toBe("/v2/getMasterchainInfo");
  });

  it("sends the bare path to an upstream already pinned to that version", () => {
    const out = relayPayloadFor({
      resolved: REST_GET,
      paramsText: "/getMasterchainInfo",
      iface: "rest",
      target: TON_V2,
      methodInternalPath: "/v2",
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload.path).toBe("/getMasterchainInfo");
  });

  it("refuses a /v3 method aimed at the /v2 upstream", () => {
    const out = relayPayloadFor({
      resolved: REST_GET,
      paramsText: "/addressInformation",
      iface: "rest",
      target: TON_V2,
      methodInternalPath: "/v3",
    });
    expect(out.ok).toBe(false);
  });

  it("sends the internal path as the whole path for a JSON-RPC method", () => {
    // AVAX's platform.* lives under /P; an unpinned node url is the C-chain
    // root the router would have appended /P to.
    const out = relayPayloadFor({
      resolved: {
        transport: "http",
        httpMethod: "POST",
        url: "http://localhost:3360",
        body: { jsonrpc: "2.0", id: 1, method: "platform.getHeight", params: {} },
        contentType: "application/json",
      },
      paramsText: "{}",
      iface: "jsonrpc",
      target: { ...TON_UNPINNED, routerId: "AVAX", node: "avax-node" },
      methodInternalPath: "/P",
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload.path).toBe("/P");
  });

  it("leaves the payload alone when nothing declares an internal path", () => {
    const out = relayPayloadFor({
      resolved: POST,
      paramsText: "[]",
      iface: "jsonrpc",
      target: TARGET,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload.path).toBeUndefined();
  });
});
