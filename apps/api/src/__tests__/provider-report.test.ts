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

function deps(rows: ErrorRequestRow[]) {
  const providers = {
    async nodesOn() {
      return ["tatum"];
    },
    configIndex() {
      return { identity: () => ({ id: "tatum", name: "Tatum", account: null }), role: () => null };
    },
    async rangeCounts() {
      return { tries: 1000, failed: 210, methods: [{ method: "getLedger", tries: 1000, failed: 210 }], rateLimitHits: null };
    },
  } as unknown as ProvidersService;
  const errorRequests = {
    async report(): Promise<ErrorRequestsReport> {
      return { available: true, rows, more: false, nextBefore: null };
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

  it("is null when the provider has no traffic on the chain", async () => {
    const d = deps([]);
    (d.providers as unknown as { nodesOn: () => Promise<string[]> }).nodesOn = async () => [];
    expect(await buildProviderReport(d, { providerId: "tatum", spec: "XLM", range })).toBeNull();
  });
});
