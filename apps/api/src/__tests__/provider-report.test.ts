import { describe, expect, it } from "vitest";
import type { ErrorRequestsReport, ErrorRequestRow } from "@sr/shared";
import { buildProviderReport, maskReportUrl } from "../services/provider-report.js";
import type { ProvidersService } from "../services/providers.js";
import type { ErrorRequestsService } from "../services/error-requests.js";
import type { ConfigurationService } from "../services/configuration.js";

describe("maskReportUrl", () => {
  it("keeps scheme and host, drops the path where most keys live", () => {
    expect(maskReportUrl("https://stellar-mainnet.gateway.tatum.io/v3/abc123def456ghi789")).toBe(
      "https://stellar-mainnet.gateway.tatum.io",
    );
  });
  it("masks a key in the subdomain", () => {
    expect(maskReportUrl("https://a1b2c3d4e5f6g7h8i9j0.solana-mainnet.quiknode.pro/")).toBe(
      "https://****.solana-mainnet.quiknode.pro",
    );
    expect(maskReportUrl("https://abc123def456.eth.rpc.example")).toBe("https://****.eth.rpc.example");
  });
  it("leaves ordinary labels alone", () => {
    expect(maskReportUrl("https://polygon-amoy.blockdaemon.com")).toBe("https://polygon-amoy.blockdaemon.com");
  });
});

const row = (guid: string, time: number, upstream: string, outcome: "ok" | "failed", code: string | null): ErrorRequestRow => ({
  guid,
  time,
  spec: "XLM",
  method: "getLedger",
  attempts: [{ upstream, batch: 0, outcome, replied: outcome === "ok", code, retryable: true, message: code ? "HTTP 429" : null, note: null }] as ErrorRequestRow["attempts"],
  result: outcome === "ok" ? "ok" : "failed",
  resolvedBy: null,
  retried: false,
  stopReason: null,
  exhausted: false,
  totalMs: 120,
  error: null,
});

const COUNTS = { tries: 1000, failed: 210, errorReplies: 0 as number | null, methods: [{ method: "getLedger", tries: 1000, failed: 210, errorReplies: 0 as number | null }], rateLimitHits: null as number | null };

function deps(rows: ErrorRequestRow[], counts = COUNTS, more = false) {
  const providers = {
    async nodesOn() {
      return ["tatum"];
    },
    configIndex() {
      return { identity: () => ({ id: "tatum", name: "Tatum", account: null }), role: () => null };
    },
    async rangeCounts() {
      return counts;
    },
  } as unknown as ProvidersService;
  const errorRequests = {
    async report(): Promise<ErrorRequestsReport> {
      return { available: true, rows, more, nextBefore: null };
    },
  } as unknown as ErrorRequestsService;
  const config = {
    getRouters: () => [
      { spec: "XLM", nodes: [{ name: "tatum", isBackup: false, endpoints: [{ urlHost: "https://k9x8y7z6w5v4u3t2s1r0.stellar.gateway.tatum.io" }] }] },
    ],
  } as unknown as ConfigurationService;
  return { providers, errorRequests, config };
}

describe("buildProviderReport", () => {
  const range = { startMs: Date.UTC(2026, 9, 12, 12), endMs: Date.UTC(2026, 9, 12, 20) };

  it("fills every field, and says what isn't captured", async () => {
    const r = await buildProviderReport(deps([row("g1", Date.UTC(2026, 9, 12, 15, 18), "tatum", "failed", "NODE_RATE_LIMITED")]), {
      providerId: "tatum",
      spec: "XLM",
      range,
    });
    expect(r).not.toBeNull();
    expect(r!.text).toContain("Provider: Tatum");
    expect(r!.text).toContain("Network URL: https://****.stellar.gateway.tatum.io");
    expect(r!.text).toContain("mostly NODE_RATE_LIMITED");
    expect(r!.text).toContain("Provider request ID: Not captured");
    expect(r!.text).toContain("Raw request: Not captured");
    expect(r!.text).not.toContain("k9x8y7z6w5v4u3t2s1r0");
  });

  it("never lists a request where only another provider failed", async () => {
    const r = await buildProviderReport(
      deps([
        row("mine", Date.UTC(2026, 9, 12, 15), "tatum", "failed", "NODE_TIMEOUT"),
        row("theirs", Date.UTC(2026, 9, 12, 16), "blockdaemon", "failed", "NODE_RATE_LIMITED"),
      ]),
      { providerId: "tatum", spec: "XLM", range },
    );
    expect(r!.examples.map((e) => e.guid)).toEqual(["mine"]);
  });

  // A node that answers "not supported" to nine calls in ten has an error
  // rate near zero: the router counts an error reply as served.
  it("an error reply is counted and shown apart from a failed request, with what the provider sent back", async () => {
    const reply = row("r1", Date.UTC(2026, 9, 12, 16, 5), "tatum", "failed", "NODE_SERVER_ERROR");
    reply.attempts[0]!.errorReply = { requestId: "1a2b3c4d", body: '{"error":{"code":-32000,"message":"not supported"}}' };
    const counts = { tries: 1000, failed: 0, errorReplies: 920, methods: [{ method: "getLedger", tries: 1000, failed: 0, errorReplies: 920 }], rateLimitHits: 0 };
    const r = await buildProviderReport(deps([reply], counts), { providerId: "tatum", spec: "XLM", range });
    expect(r!.problem).toBe(
      "Between 16:05 and 16:05 UTC on 2026-10-12, 920 of 1,000 requests to Tatum on Stellar got an error reply (92.0%), mostly NODE_SERVER_ERROR.",
    );
    expect(r!.text).toContain("Method(s): getLedger (920 error replies of 1,000)");
    expect(r!.text).toContain("Affected volume: 0 failed requests out of 1,000 (0.0%). Error replies: 920 (92.0%).");
    expect(r!.examples[0]).toMatchObject({ kind: "error-reply", providerRequestId: "1a2b3c4d" });
    expect(r!.text).toContain("· error reply · NODE_SERVER_ERROR ·");
    expect(r!.text).toContain("provider request ID 1a2b3c4d");
    expect(r!.text).toContain("Provider request ID: With each example above that got a reply.");
    expect(r!.text).not.toContain("No failed requests");
  });

  it("both kinds: each gets its own count and its own examples", async () => {
    const failed = [1, 2, 3, 4, 5, 6].map((i) => row(`f${i}`, Date.UTC(2026, 9, 12, 15, i), "tatum", "failed", "NODE_RATE_LIMITED"));
    const replies = [1, 2, 3].map((i) => {
      const x = row(`e${i}`, Date.UTC(2026, 9, 12, 14, i), "tatum", "failed", "NODE_SERVER_ERROR");
      x.attempts[0]!.errorReply = { requestId: null, body: null };
      return x;
    });
    const counts = { tries: 1000, failed: 60, errorReplies: 30, methods: [{ method: "getLedger", tries: 1000, failed: 60, errorReplies: 30 }], rateLimitHits: 60 };
    const r = await buildProviderReport(deps([...failed, ...replies], counts), { providerId: "tatum", spec: "XLM", range });
    expect(r!.problem).toContain("60 of 1,000 requests to Tatum on Stellar failed (6.0%), mostly NODE_RATE_LIMITED. 30 more got an error reply (3.0%), mostly NODE_SERVER_ERROR.");
    expect(r!.examples.map((e) => e.kind)).toEqual(["failed", "failed", "failed", "error-reply", "error-reply"]);
    // A reply the router logged nothing of is still said to be uncaptured.
    expect(r!.text).toContain("Provider request ID: Not captured - the router doesn't record");
  });

  it("with more failures than one read holds, the start is the range's - not the oldest one read", async () => {
    const r = await buildProviderReport(
      deps([row("g1", Date.UTC(2026, 9, 12, 19, 58), "tatum", "failed", "NODE_RATE_LIMITED")], COUNTS, true),
      { providerId: "tatum", spec: "XLM", range },
    );
    expect(r!.problem).toContain("Between 12:00 and 19:58 UTC");
    expect(r!.text).toContain("Incident start: 2026-10-12 12:00:00 UTC (the start of the range - it holds more failures than the report read)");
  });

  it("nothing wrong in the range says so once", async () => {
    const counts = { tries: 1000, failed: 0, errorReplies: 0, methods: [{ method: "getLedger", tries: 1000, failed: 0, errorReplies: 0 }], rateLimitHits: 0 };
    const r = await buildProviderReport(deps([], counts), { providerId: "tatum", spec: "XLM", range });
    expect(r!.problem).toBe("No failed requests and no error replies to Tatum on Stellar in this range.");
    expect(r!.text).toContain("Method(s): None");
  });

  it("is null when the provider has no traffic on the chain", async () => {
    const d = deps([]);
    (d.providers as unknown as { nodesOn: () => Promise<string[]> }).nodesOn = async () => [];
    expect(await buildProviderReport(d, { providerId: "tatum", spec: "XLM", range })).toBeNull();
  });
});
