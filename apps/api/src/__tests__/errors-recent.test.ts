import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

/** One Loki query_range payload with two error lines, newest last. */
const LOKI_BODY = {
  status: "success",
  data: {
    result: [
      {
        stream: { level: "error" },
        values: [
          ["1755700000000000000", JSON.stringify({
            chain_id: "SOLANAT", api: "getBlock", error_name: "CHAIN_BLOCK_NOT_FOUND",
            error_category: "external", retryable: "true",
            provider: "{ProviderAddress:blockdaemon ProviderStake:0}",
            error: "Block not available for slot 431841130",
          })],
          ["1755700060000000000", "not json at all"],
        ],
      },
    ],
  },
};

describe("GET /api/metrics/errors/recent", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(LOKI_BODY))));
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("parses and scrubs lines; groups repeats of one fault into one row (service, explicit url)", async () => {
    app = await buildApp();
    const { LokiService, groupErrors, normalizeErrorMessage, scrubSecrets } = await import("../services/loki.js");
    const lines = await new LokiService("http://loki:3100").recentErrors("SOLANAT", "blockdaemon", 10);
    expect(lines[1]).toMatchObject({
      chain: "SOLANAT", provider: "blockdaemon", method: "getBlock",
      errorName: "CHAIN_BLOCK_NOT_FOUND", retryable: true,
      message: "Block not available for slot 431841130",
    });
    // The Loki query narrows by line content, not stream labels.
    const url = String(vi.mocked(fetch).mock.calls[0]?.[0]);
    expect(url).toContain(encodeURIComponent('"chain_id":"SOLANAT"'));
    expect(url).toContain(encodeURIComponent("ProviderAddress:blockdaemon"));

    // A single-code scope narrows the Loki read to that error alone.
    await new LokiService("http://loki:3100").recentErrors("ETH1", undefined, 10, undefined, undefined, "CHAIN_NONCE_TOO_LOW");
    const scoped = String(vi.mocked(fetch).mock.calls.at(-1)?.[0]);
    expect(scoped).toContain(encodeURIComponent('"error_name":"CHAIN_NONCE_TOO_LOW"'));

    // Same fault, different slot numbers → ONE group, counted.
    const groups = groupErrors([
      { atUnix: 10, chain: "SOLANAT", provider: "blockdaemon", method: "getBlock", errorName: "CHAIN_BLOCK_NOT_FOUND", errorCategory: null, retryable: true, message: "Block not available for slot 111" },
      { atUnix: 20, chain: "SOLANAT", provider: "blockdaemon", method: "getBlock", errorName: "CHAIN_BLOCK_NOT_FOUND", errorCategory: null, retryable: true, message: "Block not available for slot 222" },
      { atUnix: 15, chain: "SOLANAT", provider: "blockdaemon", method: "getHealth", errorName: "NODE_TIMEOUT", errorCategory: null, retryable: true, message: "timeout" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ count: 2, lastAtUnix: 20, errorName: "CHAIN_BLOCK_NOT_FOUND" });

    // One fault hitting two methods is ONE group - the methods ride along.
    const twoMethods = groupErrors([
      { atUnix: 1, chain: "STRK", provider: "quicknode", method: "starknet_getBlockWithReceipts", errorName: "CHAIN_BLOCK_NOT_FOUND", errorCategory: null, retryable: true, message: "Block not found" },
      { atUnix: 2, chain: "STRK", provider: "quicknode", method: "starknet_getBlockWithReceipts", errorName: "CHAIN_BLOCK_NOT_FOUND", errorCategory: null, retryable: true, message: "Block not found" },
      { atUnix: 3, chain: "STRK", provider: "quicknode", method: "starknet_getBlockWithTxHashes", errorName: "CHAIN_BLOCK_NOT_FOUND", errorCategory: null, retryable: true, message: "Block not found" },
    ]);
    expect(twoMethods).toHaveLength(1);
    expect(twoMethods[0]).toMatchObject({ count: 3, method: "starknet_getBlockWithReceipts" });
    expect(twoMethods[0]?.methods).toEqual(["starknet_getBlockWithReceipts", "starknet_getBlockWithTxHashes"]);

    // Variable payloads collapse; URLs lose path and query — that is where keys live.
    expect(normalizeErrorMessage("Block not available for slot 431841130")).toBe("Block not available for slot N");
    // Small numbers are payload too: one nonce fault, one group.
    expect(normalizeErrorMessage("nonce too low: next nonce 192, tx nonce 58")).toBe(
      normalizeErrorMessage("nonce too low: next nonce 15, tx nonce 6"),
    );
    expect(scrubSecrets("dial https://svc.blockdaemon.com/solana/native?apiKey=SECRET failed")).toBe("dial https://svc.blockdaemon.com/… failed");
  });

  it("says unavailable rather than guessing when LOKI_URL is unset", async () => {
    app = await buildApp();
    const res = await app.inject({ url: "/api/metrics/errors/recent?spec=SOLANAT" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, sampled: 0, groups: [] });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
