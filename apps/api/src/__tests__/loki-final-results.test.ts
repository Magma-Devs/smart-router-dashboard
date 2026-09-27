import { describe, it, expect, afterEach, vi } from "vitest";
import { LokiService, flowOf, methodOfRequest, outcomeWord, routerOfPod, traceFromLines } from "../services/loki.js";

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

  it("reads the method from a body the log cut short", () => {
    // A large request is logged truncated, and a cut body is not JSON.
    const cut = { message: "Consumer received a new JSON-RPC request", body: '{"id":7,"jsonrpc":"2.0","method":"debug_traceBlockByHash","params":["0x4f1a' };
    expect(methodOfRequest(cut)).toBe("debug_traceBlockByHash");
  });
});

describe("request traces — was it the same request?", () => {
  // One request, as the router logs it: the first provider times out, the
  // router moves to a backup, the backup times out too, the caller gets an
  // error. Timestamps in nanoseconds, the way Loki returns them.
  const s = (sec: number) => BigInt(1_700_000_000 + sec) * 1_000_000_000n;
  const lines = [
    { atNs: s(0), line: { message: "Consumer received a new JSON-RPC request", body: '{"method":"starknet_getEvents","params":[]}' } },
    { atNs: s(0), line: { message: "Choosing providers", chosenProviders: "alchemy" } },
    // The router re-validates and logs the same choice again — not a new step.
    { atNs: s(1), line: { message: "Choosing providers", chosenProviders: "alchemy" } },
    { atNs: s(7), line: { message: "could not send relay to provider", provider: "alchemy", error_name: "PROTOCOL_CONTEXT_DEADLINE",
      error: "Post \"https://starknet-mainnet.g.alchemy.com/v2/SECRETKEY\": context deadline exceeded" } },
    { atNs: s(7), line: { message: "Optimizer selected backup provider", selected: "quicknode" } },
    { atNs: s(14), line: { message: "could not send relay to provider", provider: "quicknode", error_name: "PROTOCOL_CONTEXT_DEADLINE" } },
    { atNs: s(14), line: { message: "ProcessingResult RETURNED", error: "failed relay", has_reply: "false" } },
  ];

  it("rebuilds one request's path through the router, in order, with when each step started", () => {
    // Shuffled on purpose: Loki returns streams newest-first.
    const t = traceFromLines("42", [...lines].reverse());
    expect(t).toMatchObject({ id: "42", method: "starknet_getEvents", failed: true, seconds: 14 });
    expect(t.attempts.map((a) => [a.provider, a.role, a.outcome, a.startSec, a.endSec])).toEqual([
      ["alchemy", "primary", "timed out", 0, 7],
      ["quicknode", "backup", "timed out", 7, 14],
    ]);
    expect(flowOf(t)).toBe("alchemy ✕ timed out → +7s quicknode (backup) ✕ timed out → failed");
    // Without the times: what requests that went the same way share.
    expect(flowOf(t, { times: false })).toBe("alchemy ✕ timed out → quicknode (backup) ✕ timed out → failed");
  });

  it("never carries the error text — it holds the provider's url, key included", () => {
    expect(JSON.stringify(traceFromLines("42", lines))).not.toMatch(/SECRETKEY|alchemy\.com/);
  });

  it("a provider the router gave up on said nothing — 'no answer', never 'replied'", () => {
    // Taken from a production request. The router adds a backup every 7s
    // WITHOUT cancelling the earlier attempts, and gives up at 30s. Only
    // blockdaemon logged a failure; the others were still working on it. The
    // first version of this line printed "lava replied → quicknode replied"
    // — which reads as "they answered, so why did it fail?". Nobody answered.
    const t = traceFromLines("44", [
      { atNs: s(0), line: { message: "Consumer received a new JSON-RPC request", body: '{"method":"getBlock"}' } },
      { atNs: s(0), line: { message: "Choosing providers", chosenProviders: "tatum" } },
      { atNs: s(7), line: { message: "Optimizer selected backup provider", selected: "blockdaemon" } },
      { atNs: s(14), line: { message: "Optimizer selected backup provider", selected: "lava" } },
      { atNs: s(21), line: { message: "Optimizer selected backup provider", selected: "quicknode" } },
      { atNs: s(24), line: { message: "could not send relay to provider", provider: "blockdaemon", error_name: "PROTOCOL_CONTEXT_DEADLINE" } },
      { atNs: s(30), line: { message: "ProcessingResult RETURNED", error: "failed relay", has_reply: "false", has_result: "true" } },
    ]);
    expect(t.attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual([
      "tatum:no answer",
      "blockdaemon:timed out",
      "lava:no answer",
      "quicknode:no answer",
    ]);
    // Three backups are one step: which one the router picks first changes
    // from request to request, and the story does not.
    expect(flowOf(t)).toBe("tatum ✕ no answer → +7s 3 backups (blockdaemon, lava, quicknode) ✕ none worked → failed");
    expect(flowOf(t)).not.toMatch(/replied|answered/);
  });

  it("when a reply did come back, the one provider with no failure logged sent it", () => {
    const t = traceFromLines("45", [
      lines[0]!,
      lines[1]!,
      { atNs: s(2), line: { message: "ProcessingResult RETURNED", has_reply: "true", has_result: "false" } },
    ]);
    expect(flowOf(t)).toBe("alchemy ✕ answered with an error → failed");
  });

  it("with two such providers, which one sent it is not known — and the line says so", () => {
    const t = traceFromLines("46", [
      lines[0]!,
      lines[1]!,
      { atNs: s(7), line: { message: "Optimizer selected backup provider", selected: "quicknode" } },
      { atNs: s(9), line: { message: "ProcessingResult RETURNED", has_reply: "true", error: "failed relay" } },
    ]);
    expect(flowOf(t)).toBe("alchemy ? result unknown → +7s quicknode (backup) ? result unknown → failed");
  });

  it("names a failure in words a customer reads", () => {
    expect(outcomeWord("PROTOCOL_CONTEXT_DEADLINE")).toBe("timed out");
    expect(outcomeWord("PROTOCOL_CONNECTION_RESET")).toBe("connection dropped");
    expect(outcomeWord("", "429")).toBe("rate-limited");
    expect(outcomeWord("", "503")).toBe("server error");
    expect(outcomeWord("CHAIN_NONCE_TOO_LOW")).toBe("nonce too low");
    expect(outcomeWord("")).toBe("failed");
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

  it("traces each failed request on its own pod, by its id", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      queries.push(url.searchParams.get("query") ?? "");
      return ok({ resultType: "streams", result: [{ stream: {}, values: [
        ["1700000014000000000", JSON.stringify({ GUID: "111", message: "ProcessingResult RETURNED", error: "failed relay" })],
        ["1700000007000000000", JSON.stringify({ GUID: "111", message: "could not send relay to provider", provider: "alchemy", error_name: "PROTOCOL_CONTEXT_DEADLINE" })],
        ["1700000000000000000", JSON.stringify({ GUID: "111", message: "Choosing providers", chosenProviders: "alchemy" })],
        // Another request on the same pod that happens to match the filter.
        ["1700000001000000000", JSON.stringify({ GUID: "999", message: "Choosing providers", chosenProviders: "tatum" })],
      ] }] });
    });
    const traces = await new LokiService("http://loki.test").traceRequests([
      { id: "111", pod: "starknet-mainnet-router-aa11-bb22", atUnix: 1_700_000_014 },
    ]);
    expect([...traces.keys()]).toEqual(["111"]);
    expect(flowOf(traces.get("111")!)).toBe("alchemy ✕ timed out → failed");
    expect(queries).toEqual(['{service_name="router", pod="starknet-mainnet-router-aa11-bb22"} |~ "111"']);
  });

  it("returns nothing without a log store", async () => {
    const loki = new LokiService(undefined);
    expect(await loki.routersWithLogs(1800)).toBeNull();
    expect((await loki.failedRequests(1800)).byRouter.size).toBe(0);
  });
});
