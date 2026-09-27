import { describe, it, expect, afterEach, vi } from "vitest";
import { LokiService, methodOfRequest, routerOfPod } from "../services/loki.js";

const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }));

describe("routerOfPod", () => {
  it("strips the replica-set and pod suffix", () => {
    expect(routerOfPod("arbitrum-mainnet-router-6fdddbb79c-fj4kh")).toBe("arbitrum-mainnet");
    expect(routerOfPod("avalanche-c-testnet-router-54d79b4c47-x2p9q")).toBe("avalanche-c-testnet");
  });
});

describe("methodOfRequest", () => {
  it("reads the JSON-RPC method, a batch, or the REST path — nothing else", () => {
    const rpc = { message: "Consumer received a new JSON-RPC request", body: '{"id":1,"jsonrpc":"2.0","method":"eth_sendRawTransaction","params":["0xabc"]}' };
    expect(methodOfRequest(rpc)).toBe("eth_sendRawTransaction");
    expect(methodOfRequest({ message: "Consumer received a new JSON-RPC request", body: '[{"method":"eth_call"}]' })).toBe("batch");
    expect(methodOfRequest({ message: "Consumer received a new REST POST request", path: "/transactions" })).toBe("/transactions");
    expect(methodOfRequest({ message: "something else" })).toBe("unknown");
  });
});

describe("LokiService log reads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("routersWithLogs reads the label index, not the lines", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      urls.push(url.pathname);
      return ok([{ pod: "solana-mainnet-router-aa11-bb22" }, { pod: "solana-mainnet-router-aa11-cc33" }, { pod: "eth-mainnet-router-dd44-ee55" }]);
    });
    expect(await new LokiService("http://loki.test").routersWithLogs(1800)).toEqual(new Set(["solana-mainnet", "eth-mainnet"]));
    expect(urls).toEqual(["/loki/api/v1/series"]);
  });

  it("reads failed requests once, with pod and time, and looks each up on its own pod", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      const q = url.searchParams.get("query") ?? "";
      queries.push(q);
      const result = q.includes("ProcessingResult RETURNED")
        ? [{ stream: { pod: "polygon-mainnet-router-aa11-bb22" }, values: [
            ["1700000100000000000", JSON.stringify({ GUID: "111", error: "failed relay", has_reply: "false" })],
            ["1700000090000000000", JSON.stringify({ GUID: "111", error: "failed relay", has_reply: "false" })],
            ["1700000050000000000", JSON.stringify({ GUID: "222", error: "", has_result: "false" })],
          ] }]
        : [{ stream: {}, values: [
            ["1", JSON.stringify({ GUID: "111", message: "Consumer received a new JSON-RPC request", body: '{"method":"eth_sendRawTransaction"}', headers: "Authorization: secret" })],
            ["2", JSON.stringify({ GUID: "222", message: "Consumer received a new REST POST request", path: "/transactions" })],
          ] }];
      return ok({ resultType: "streams", result });
    });
    const loki = new LokiService("http://loki.test");
    const { byRouter, capped } = await loki.failedRequests(1800);
    expect(capped).toBe(false);
    expect(byRouter.get("polygon-mainnet")?.map((f) => f.id)).toEqual(["111", "222"]);
    const methods = await loki.methodsOf(byRouter.get("polygon-mainnet")!);
    expect(methods).toEqual(new Map([["111", "eth_sendRawTransaction"], ["222", "/transactions"]]));
    // The lookup is narrowed to the failures' own pod — never the fleet.
    expect(queries.at(-1)).toContain('pod="polygon-mainnet-router-aa11-bb22"');
    // Only the method leaves: never the body, never the headers.
    expect(JSON.stringify([...methods])).not.toMatch(/secret|params/);
  });

  it("counts on the router's own pods when a read overflowed", async () => {
    let q = "";
    vi.stubGlobal("fetch", async (url: URL) => {
      q = url.searchParams.get("query") ?? "";
      return ok({ resultType: "vector", result: [{ metric: { pod: "solana-testnet-router-aa11-bb22" }, value: [0, "25046"] }] });
    });
    expect(await new LokiService("http://loki.test").countFailed(["solana-testnet"], 1800)).toEqual(new Map([["solana-testnet", 25_046]]));
    expect(q).toContain('pod=~"(solana-testnet)-router-.*"');
  });

  it("returns nothing without a log store", async () => {
    const loki = new LokiService(undefined);
    expect(await loki.routersWithLogs(1800)).toBeNull();
    expect((await loki.failedRequests(1800)).byRouter.size).toBe(0);
  });
});
