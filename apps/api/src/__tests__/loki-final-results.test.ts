import { describe, it, expect, afterEach, vi } from "vitest";
import { LokiService, routerOfPod } from "../services/loki.js";

describe("routerOfPod", () => {
  it("strips the replica-set and pod suffix", () => {
    expect(routerOfPod("arbitrum-mainnet-router-6fdddbb79c-fj4kh")).toBe("arbitrum-mainnet");
    expect(routerOfPod("avalanche-c-testnet-router-54d79b4c47-x2p9q")).toBe("avalanche-c-testnet");
  });
});

describe("LokiService.finalResults", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts requests and distinct failed request ids per router, pods summed", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      const q = url.searchParams.get("query") ?? "";
      queries.push(q);
      const failedQuery = q.includes("has_result");
      const result = failedQuery
        ? [{ metric: { pod: "solana-mainnet-router-aa11-bb22" }, value: [0, "59"] }]
        : [
            { metric: { pod: "solana-mainnet-router-aa11-bb22" }, value: [0, "12000"] },
            { metric: { pod: "solana-mainnet-router-aa11-cc33" }, value: [0, "12599"] },
          ];
      return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result } }));
    });
    const out = await new LokiService("http://loki.test").finalResults(1800);
    expect(out).toEqual(new Map([["solana-mainnet", { total: 24_599, failed: 59 }]]));
    // The alert's own line and test, and distinct request ids for failures.
    expect(queries.every((q) => q.includes('"message":"ProcessingResult RETURNED"'))).toBe(true);
    expect(queries.find((q) => q.includes("has_result"))).toMatch(/sum by \(pod, GUID\)/);
  });

  it("is null with no log store", async () => {
    expect(await new LokiService(undefined).finalResults(1800)).toBeNull();
  });
});
