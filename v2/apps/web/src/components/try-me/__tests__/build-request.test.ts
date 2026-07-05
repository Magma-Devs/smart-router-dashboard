import { describe, expect, it } from "vitest";
import { buildRequest, paramsKindFor } from "../build-request";
import type { AddonCommand } from "../chain-methods";

const ENDPOINT = "http://localhost:3360";
const COSMOS_REST = "http://localhost:3362";
const ETH_WS = "ws://localhost:3360/websocket";
const COSMOS_GRPC = "localhost:3363";
const COSMOS_GRPCWEB = "http://localhost:3363";

const ETH_BLOCK_NUMBER: AddonCommand = {
  method: "eth_blockNumber",
  label: "eth_blockNumber",
  params: "[]",
};

const ETH_GET_BALANCE: AddonCommand = {
  method: "eth_getBalance",
  label: "eth_getBalance",
  params: '["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"]',
};

const NEAR_BLOCK: AddonCommand = {
  method: "block",
  label: "block",
  params: '{"block_id":"latest"}',
};

const COSMOS_LATEST: AddonCommand = {
  method: "GET",
  label: "/blocks/latest",
  params: "/cosmos/base/tendermint/v1beta1/blocks/latest",
};

const TENDERMINT_STATUS: AddonCommand = {
  method: "abci_info",
  label: "abci_info",
  params: "[]",
};

const COSMOS_GRPC_LATEST: AddonCommand = {
  method: "/cosmos.base.tendermint.v1beta1.Service/GetLatestBlock",
  label: "Get Latest Block",
  params: "{}",
};

const COSMOS_GRPC_HEIGHT: AddonCommand = {
  method: "/cosmos.base.tendermint.v1beta1.Service/GetBlockByHeight",
  label: "Get Block By Height",
  params: '{"height":"340801"}',
};

describe("buildRequest — JSON-RPC (HTTP)", () => {
  it("wraps the catalog params (array) into a JSON-RPC 2.0 envelope", () => {
    const result = buildRequest("jsonrpc", ETH_BLOCK_NUMBER, "[]", ENDPOINT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.transport).toBe("http");
    if (result.request.transport !== "http") return;
    expect(result.request.httpMethod).toBe("POST");
    expect(result.request.url).toBe(ENDPOINT);
    expect(result.request.contentType).toBe("application/json");
    expect(result.request.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    });
  });

  it("preserves user edits to params", () => {
    const result = buildRequest(
      "jsonrpc",
      ETH_GET_BALANCE,
      '["0xdeadbeef", "0x1234"]',
      ENDPOINT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toMatchObject({
      method: "eth_getBalance",
      params: ["0xdeadbeef", "0x1234"],
    });
  });

  it("accepts object params (NEAR-style)", () => {
    const result = buildRequest("jsonrpc", NEAR_BLOCK, '{"block_id":"latest"}', ENDPOINT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "block",
      params: { block_id: "latest" },
    });
  });

  it("treats empty paramsText as an empty params array", () => {
    const result = buildRequest("jsonrpc", ETH_BLOCK_NUMBER, "", ENDPOINT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toMatchObject({ params: [] });
  });

  it("returns a parse error when paramsText isn't valid JSON", () => {
    const result = buildRequest("jsonrpc", ETH_BLOCK_NUMBER, "{not json", ENDPOINT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON/i);
  });
});

describe("buildRequest — Tendermint RPC (HTTP)", () => {
  it("uses JSON-RPC envelope identical to jsonrpc transport", () => {
    const result = buildRequest("tendermintrpc", TENDERMINT_STATUS, "[]", ENDPOINT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.transport).toBe("http");
    if (result.request.transport !== "http") return;
    expect(result.request.httpMethod).toBe("POST");
    expect(result.request.body).toMatchObject({
      jsonrpc: "2.0",
      method: "abci_info",
      params: [],
    });
  });
});

describe("buildRequest — REST", () => {
  it("appends the path to the endpoint URL", () => {
    const result = buildRequest("rest", COSMOS_LATEST, COSMOS_LATEST.params, COSMOS_REST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.transport).toBe("http");
    if (result.request.transport !== "http") return;
    expect(result.request.httpMethod).toBe("GET");
    expect(result.request.url).toBe(
      `${COSMOS_REST}/cosmos/base/tendermint/v1beta1/blocks/latest`,
    );
    expect(result.request.body).toBeNull();
    expect(result.request.contentType).toBeNull();
  });

  it("strips a trailing slash on the endpoint URL to avoid '//' duplication", () => {
    const result = buildRequest("rest", COSMOS_LATEST, "/x", `${COSMOS_REST}/`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.url).toBe(`${COSMOS_REST}/x`);
  });

  it("rejects a path that doesn't start with '/'", () => {
    const result = buildRequest("rest", COSMOS_LATEST, "blocks/latest", COSMOS_REST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/start with '\/'/);
  });

  it("allows an empty path (= bare endpoint)", () => {
    const result = buildRequest("rest", COSMOS_LATEST, "", COSMOS_REST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.url).toBe(COSMOS_REST);
  });
});

describe("buildRequest — WebSocket", () => {
  it("packs jsonrpc-ws into a ws transport with the same JSON-RPC envelope", () => {
    const result = buildRequest("jsonrpc-ws", ETH_BLOCK_NUMBER, "[]", ETH_WS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.transport).toBe("ws");
    if (result.request.transport !== "ws") return;
    expect(result.request.url).toBe(ETH_WS);
    expect(result.request.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    });
  });

  it("packs tendermintrpc-ws the same way", () => {
    const result = buildRequest("tendermintrpc-ws", TENDERMINT_STATUS, "[]", ETH_WS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.transport).toBe("ws");
  });

  it("returns a parse error when params aren't valid JSON", () => {
    const result = buildRequest("jsonrpc-ws", ETH_BLOCK_NUMBER, "{nope", ETH_WS);
    expect(result.ok).toBe(false);
  });
});

describe("buildRequest — gRPC", () => {
  it("parses '/service/Method' into service + methodName + fqMethod", () => {
    const result = buildRequest("grpc", COSMOS_GRPC_LATEST, "{}", COSMOS_GRPC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.transport).toBe("grpc");
    if (result.request.transport !== "grpc" && result.request.transport !== "grpc-web") return;
    expect(result.request.service).toBe("cosmos.base.tendermint.v1beta1.Service");
    expect(result.request.methodName).toBe("GetLatestBlock");
    expect(result.request.fqMethod).toBe(
      "cosmos.base.tendermint.v1beta1.Service/GetLatestBlock",
    );
    expect(result.request.body).toEqual({});
    expect(result.request.url).toBe(COSMOS_GRPC);
  });

  it("forwards the parsed JSON body verbatim", () => {
    const result = buildRequest("grpc", COSMOS_GRPC_HEIGHT, '{"height":"340801"}', COSMOS_GRPC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.request.transport !== "grpc" && result.request.transport !== "grpc-web") return;
    expect(result.request.body).toEqual({ height: "340801" });
  });

  it("normalises an empty paramsText to an empty object (gRPC has no array params)", () => {
    const result = buildRequest("grpc", COSMOS_GRPC_LATEST, "", COSMOS_GRPC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.request.transport !== "grpc" && result.request.transport !== "grpc-web") return;
    expect(result.request.body).toEqual({});
  });

  it("rejects a malformed method name (no service separator)", () => {
    const bad: AddonCommand = { method: "/NoSlashAfterThis", label: "Bad", params: "{}" };
    const result = buildRequest("grpc", bad, "{}", COSMOS_GRPC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Malformed gRPC method/);
  });

  it("uses the grpc-web transport tag and the URL it gets passed", () => {
    const result = buildRequest("grpc-web", COSMOS_GRPC_LATEST, "{}", COSMOS_GRPCWEB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.transport).toBe("grpc-web");
    expect(result.request.url).toBe(COSMOS_GRPCWEB);
  });
});

describe("paramsKindFor", () => {
  it("returns 'path' for REST and 'json' for every other transport", () => {
    expect(paramsKindFor("rest")).toBe("path");
    expect(paramsKindFor("jsonrpc")).toBe("json");
    expect(paramsKindFor("jsonrpc-ws")).toBe("json");
    expect(paramsKindFor("tendermintrpc")).toBe("json");
    expect(paramsKindFor("tendermintrpc-ws")).toBe("json");
    expect(paramsKindFor("grpc")).toBe("json");
    expect(paramsKindFor("grpc-web")).toBe("json");
  });
});
