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

  it("fills every field of the customer's template, in its order, and says what isn't captured", async () => {
    const r = await buildProviderReport(deps([row("g1", Date.UTC(2026, 9, 12, 15, 18), "tatum", "failed", "NODE_RATE_LIMITED")]), {
      providerId: "tatum",
      spec: "XLM",
      range,
    });
    expect(r).not.toBeNull();
    const fields = r!.text.split("\n").filter((l) => !l.startsWith("- ")).map((l) => l.split(":")[0]);
    expect(fields).toEqual([
      "Chain", "Environment", "Network URL", "Method(s)", "Problem statement", "Example",
      "Incident start", "Incident end", "Affected volume", "x-request-id", "Raw request", "Raw response",
    ]);
    expect(r!.text).toContain("Network URL: https://****.stellar.gateway.tatum.io");
    expect(r!.text).toContain("mostly NODE_RATE_LIMITED");
    // A 429 carries no reply the router keeps: no provider ID, no body - and the report says why.
    expect(r!.text).toContain("x-request-id: Not captured - the router reads it from the provider's reply, and this try got none.");
    expect(r!.text).toContain("Raw request: Not captured - the router's log has no request line");
    expect(r!.text).toContain('Raw response: Not captured - the router keeps a reply body only when the provider answers with an error. This try failed with "HTTP 429".');
    expect(r!.text).not.toContain("k9x8y7z6w5v4u3t2s1r0");
  });

  it("the raw request and reply come from one example, with the provider's own request ID", async () => {
    const reply = row("r1", Date.UTC(2026, 9, 12, 16, 5), "tatum", "failed", "NODE_SERVER_ERROR");
    reply.attempts[0]!.errorReply = { requestId: "1a2b3c4d", body: '{"error":{"code":-32000,"message":"not supported"}}' };
    reply.request = { path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"getLedger","params":[]}', cut: false };
    const cut = row("r0", Date.UTC(2026, 9, 12, 16, 4), "tatum", "failed", "NODE_RATE_LIMITED");
    cut.request = { path: "/", body: '{"jsonrpc":"2.0","id":1,"method":"getLedger","params":[{"to":"0xab', cut: true };
    const r = await buildProviderReport(deps([cut, reply]), { providerId: "tatum", spec: "XLM", range });
    expect(r!.text).toContain("x-request-id: 1a2b3c4d");
    expect(r!.text).toContain('Raw request: {"jsonrpc":"2.0","id":1,"method":"getLedger","params":[]}');
    expect(r!.text).toContain('Raw response: {"error":{"code":-32000,"message":"not supported"}}');
    expect(r!.text).toMatch(/^Example: .*our request ID r1 · x-request-id 1a2b3c4d$/m);
    expect(r!.text).toMatch(/^- .*our request ID r0$/m);

    // The 429 alone: its body as logged, said to be cut short.
    const only = await buildProviderReport(deps([cut]), { providerId: "tatum", spec: "XLM", range });
    expect(only!.text).toContain('Raw request: {"jsonrpc":"2.0","id":1,"method":"getLedger","params":[{"to":"0xab (cut short in the router\'s log)');
  });

  it("times are in the reader's time zone, as the customer's template writes them", async () => {
    const r = await buildProviderReport(deps([row("g1", Date.UTC(2026, 9, 12, 15, 18), "tatum", "failed", "NODE_RATE_LIMITED")]), {
      providerId: "tatum",
      spec: "XLM",
      range,
      tz: "Asia/Jerusalem",
    });
    expect(r!.timeZone).toBe("Asia/Jerusalem");
    expect(r!.text).toContain("Incident start: 2026-10-12 18:18:00 (UTC+3)");
    expect(r!.problem).toContain("Between 18:18 and 18:18 (UTC+3) on 2026-10-12");
    // An unknown zone falls back to UTC rather than failing the report.
    const bad = await buildProviderReport(deps([row("g1", Date.UTC(2026, 9, 12, 15, 18), "tatum", "failed", "NODE_RATE_LIMITED")]), {
      providerId: "tatum",
      spec: "XLM",
      range,
      tz: "Not/A_Zone",
    });
    expect(bad!.timeZone).toBe("UTC");
    expect(bad!.text).toContain("Incident start: 2026-10-12 15:18:00 (UTC)");
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
      "Between 16:05 and 16:05 (UTC) on 2026-10-12, 920 of 1,000 requests to Tatum on Stellar got an error reply (92.0%), mostly NODE_SERVER_ERROR.",
    );
    expect(r!.text).toContain("Method(s): getLedger (920 error replies of 1,000)");
    expect(r!.text).toContain("Affected volume: 0 failed requests out of 1,000 (0.0%). Error replies: 920 (92.0%).");
    expect(r!.examples[0]).toMatchObject({ kind: "error-reply", providerRequestId: "1a2b3c4d" });
    expect(r!.text).toContain("· error reply · NODE_SERVER_ERROR ·");
    expect(r!.text).toContain("x-request-id 1a2b3c4d");
    expect(r!.text).toContain("x-request-id: 1a2b3c4d");
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
    // A reply that carried no X-Request-Id is said to be uncaptured, with why.
    expect(r!.text).toContain("x-request-id: Not captured - the provider's reply had no X-Request-Id header.");
  });

  it("with more failures than one read holds, the start is the range's - not the oldest one read", async () => {
    const r = await buildProviderReport(
      deps([row("g1", Date.UTC(2026, 9, 12, 19, 58), "tatum", "failed", "NODE_RATE_LIMITED")], COUNTS, true),
      { providerId: "tatum", spec: "XLM", range },
    );
    expect(r!.problem).toContain("Between 12:00 and 19:58 (UTC)");
    expect(r!.text).toContain("Incident start: 2026-10-12 12:00:00 (UTC) - the start of the range; it holds more failures than the report read");
  });

  it("nothing wrong in the range says so once", async () => {
    const counts = { tries: 1000, failed: 0, errorReplies: 0, methods: [{ method: "getLedger", tries: 1000, failed: 0, errorReplies: 0 }], rateLimitHits: 0 };
    const r = await buildProviderReport(deps([], counts), { providerId: "tatum", spec: "XLM", range });
    expect(r!.problem).toBe("No failed requests and no error replies to Tatum on Stellar in this range.");
    expect(r!.text).toContain("Method(s): None");
    expect(r!.text).toContain("Example: None in the router's logs for this range.");
    expect(r!.text).toContain("Raw request: Not captured - no example request in the router's logs for this range.");
  });

  it("is null when the provider has no traffic on the chain", async () => {
    const d = deps([]);
    (d.providers as unknown as { nodesOn: () => Promise<string[]> }).nodesOn = async () => [];
    expect(await buildProviderReport(d, { providerId: "tatum", spec: "XLM", range })).toBeNull();
  });
});
