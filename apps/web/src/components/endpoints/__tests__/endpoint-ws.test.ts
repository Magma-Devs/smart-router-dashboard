import { describe, expect, it } from "vitest";
import {
  epHasWs,
  epHasWsUpstream,
  epLocalWs,
  epPublicWs,
  epWsUrl,
  ifaceServesWs,
  type EndpointRowModel,
} from "@/components/endpoints/bits";

function row(over: Partial<EndpointRowModel> = {}): EndpointRowModel {
  return {
    id: "eth1|jsonrpc",
    routerId: "eth1",
    spec: "ETH1",
    network: "mainnet",
    iface: "jsonrpc",
    port: 3360,
    publicUrl: null,
    nodes: [],
    ...over,
  };
}

describe("ifaceServesWs", () => {
  it("covers the interfaces whose listener registers the upgrade", () => {
    expect(ifaceServesWs("jsonrpc")).toBe(true);
    expect(ifaceServesWs("jsonrpc-ws")).toBe(true);
    expect(ifaceServesWs("tendermintrpc")).toBe(true);
    expect(ifaceServesWs("tendermintrpc-ws")).toBe(true);
    expect(ifaceServesWs("websocket")).toBe(true);
  });

  it("excludes the interfaces that have no ws form", () => {
    expect(ifaceServesWs("rest")).toBe(false);
    expect(ifaceServesWs("grpc")).toBe(false);
    expect(ifaceServesWs("grpc-web")).toBe(false);
  });
});

describe("epHasWs", () => {
  it("holds for a jsonrpc endpoint whose upstreams are all HTTP", () => {
    // The router serves /ws on every jsonrpc listener — a wss:// upstream in
    // the values is not what turns it on.
    expect(epHasWs(row({ nodes: [{ name: "publicnode", isBackup: false, urlHost: "https://ethereum-rpc.publicnode.com", addons: [] }] }))).toBe(true);
  });

  it("holds for tendermintrpc and stays false for rest / grpc", () => {
    expect(epHasWs(row({ iface: "tendermintrpc" }))).toBe(true);
    expect(epHasWs(row({ iface: "rest" }))).toBe(false);
    expect(epHasWs(row({ iface: "grpc" }))).toBe(false);
  });
});

describe("epHasWsUpstream", () => {
  it("is the separate fact of an upstream ws leg (what subscriptions need)", () => {
    const httpOnly = row({ nodes: [{ name: "polkachu", isBackup: false, urlHost: "https://cosmos-rpc.polkachu.com", addons: [] }] });
    const withWs = row({
      nodes: [
        { name: "publicnode", isBackup: false, urlHost: "https://ethereum-rpc.publicnode.com", addons: [] },
        { name: "publicnode", isBackup: false, urlHost: "wss://ethereum-rpc.publicnode.com", addons: [] },
      ],
    });
    expect(epHasWsUpstream(httpOnly)).toBe(false);
    expect(epHasWsUpstream(withWs)).toBe(true);
  });
});

describe("epWsUrl", () => {
  it("is the base interface's own address, path-scoped per interface", () => {
    expect(epWsUrl(row())).toBe("ws://localhost:3360/ws");
    expect(epWsUrl(row({ iface: "tendermintrpc", port: 3365 }))).toBe("ws://localhost:3365/websocket");
  });

  it("prefers the published gateway URL and keeps TLS", () => {
    expect(epWsUrl(row({ publicUrl: "https://eth1.jsonrpc.example.com" }))).toBe(
      "wss://eth1.jsonrpc.example.com/ws",
    );
  });

  it("is null when the mounted config publishes no address", () => {
    expect(epWsUrl(row({ port: null }))).toBeNull();
  });
});

describe("ws url helpers", () => {
  it("path-scope the upgrade (a bare host handshake is refused with 405)", () => {
    expect(epLocalWs(3360, "jsonrpc")).toBe("ws://localhost:3360/ws");
    expect(epPublicWs("https://cosmoshub.tendermintrpc.example.com", "tendermintrpc")).toBe(
      "wss://cosmoshub.tendermintrpc.example.com/websocket",
    );
  });
});
