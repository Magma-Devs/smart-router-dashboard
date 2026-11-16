import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BedrockAdapter } from "../services/ask/bedrock.js";
import { AskFailure } from "../services/ask/errors.js";
import { McpAdapter } from "../services/ask/mcp.js";

const pricing = {
  version: "preflight-fixture",
  model: "anthropic.fixture",
  region: "us-east-1",
  validFrom: "2026-01-01T00:00:00Z",
  validUntil: "2027-01-01T00:00:00Z",
  source: "https://aws.amazon.com/bedrock/pricing/",
  input: "1000000",
  output: "1000000",
  cacheRead: "1000000",
  cacheWrite5m: "1000000",
  cacheWrite1h: "1000000",
};
let exitCode: typeof process.exitCode;
beforeEach(() => {
  vi.resetModules();
  exitCode = process.exitCode;
  for (const [key, value] of Object.entries({
    ASK_DATA_PREFLIGHT: "true",
    ASK_DATA_ENABLED: "false",
    AUTH_MODE: "enabled",
    DEPLOYMENT_MODE: "managed",
    ASK_DATA_CUSTOMER_ID: "customer-a",
    ASK_DATA_MCP_TOKEN: "private-mcp-fixture",
    AWS_BEARER_TOKEN_BEDROCK: "private-bedrock-fixture",
    ASK_DATA_BEDROCK_MODEL: pricing.model,
    ASK_DATA_BEDROCK_REGION: pricing.region,
    ASK_DATA_PRICING_JSON: JSON.stringify(pricing),
    ASK_DATA_TOKEN_COUNTER: "runtime",
    ASK_DATA_TOKEN_COUNTER_MODEL: pricing.model,
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Keep class identity across the dynamically imported command; tests replace
// only the actual provider boundaries, never the configuration/pricing gates.
vi.mock("../services/ask/mcp.js", async (original) => original());
vi.mock("../services/ask/bedrock.js", async (original) => original());
vi.mock("../services/ask/errors.js", async (original) => original());
function providers() {
  const discover = vi.fn().mockResolvedValue({
    sources: [{ id: "private-source-name" }],
    operations: [{ operationId: "metrics.query" }],
  });
  const mcp = vi
    .spyOn(McpAdapter.prototype, "withConnection")
    .mockImplementation(async (callback) => callback({ discover } as never));
  const count = vi.spyOn(BedrockAdapter.prototype, "countTokens").mockResolvedValue(123);
  const converse = vi
    .spyOn(BedrockAdapter.prototype, "converse")
    .mockRejectedValue(new Error("Inference must never be called"));
  return { discover, mcp, count, converse };
}

describe("free operator preflight", () => {
  it("works while the deployment flag stays off, discovers ownership and counts tool input without reading source data or inferring", async () => {
    const p = providers();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await import("../ask-preflight.js");
    expect(p.discover).toHaveBeenCalledOnce();
    expect(p.count).toHaveBeenCalledWith(
      expect.objectContaining({ forceTool: true, tools: expect.any(Array) }),
      { mode: "runtime", model: pricing.model },
      expect.any(AbortSignal),
    );
    expect(p.converse).not.toHaveBeenCalled();
    expect(process.env.ASK_DATA_ENABLED).toBe("false");
    const output = out.mock.calls.map(([value]) => String(value)).join("");
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      sourceCount: 1,
      countedTokens: 123,
      monthlyLimitMicroUsd: "10000000",
      operations: ["metrics.query"],
    });
    expect(output).not.toContain("private-");
  });
  it.each([
    { ASK_DATA_PREFLIGHT: "false" },
    { AUTH_MODE: "disabled" },
    { DEPLOYMENT_MODE: "onprem" },
    { ASK_DATA_MCP_TOKEN: "" },
  ])("does no network work when its gates fail: %s", async (override) => {
    for (const [key, value] of Object.entries(override)) vi.stubEnv(key, value);
    const p = providers();
    const out = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("../ask-preflight.js");
    expect(process.exitCode).toBe(1);
    expect(p.mcp).not.toHaveBeenCalled();
    expect(p.count).not.toHaveBeenCalled();
    expect(p.converse).not.toHaveBeenCalled();
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({
      ok: false,
      stage: "configuration",
    });
  });
  it("rejects expired or mismatched pricing before provider access", async () => {
    vi.stubEnv(
      "ASK_DATA_PRICING_JSON",
      JSON.stringify({ ...pricing, validUntil: "2026-02-01T00:00:00Z" }),
    );
    const p = providers();
    const out = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("../ask-preflight.js");
    expect(process.exitCode).toBe(1);
    expect(p.mcp).not.toHaveBeenCalled();
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({
      ok: false,
      stage: "pricing",
    });
  });
  it("does not reach Bedrock after a rejected customer identity and prints no provider exception", async () => {
    const p = providers();
    p.discover.mockRejectedValue(new AskFailure("ASK_IDENTITY_MISMATCH"));
    const out = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("../ask-preflight.js");
    expect(p.count).not.toHaveBeenCalled();
    expect(p.converse).not.toHaveBeenCalled();
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({
      ok: false,
      stage: "mcp",
      code: "ASK_IDENTITY_MISMATCH",
    });
  });
  it("refuses a catalog with no approved reads before contacting the counter", async () => {
    const p = providers();
    p.discover.mockResolvedValue({ sources: [], operations: [] });
    const out = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("../ask-preflight.js");
    expect(p.count).not.toHaveBeenCalled();
    expect(p.converse).not.toHaveBeenCalled();
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({ ok: false, stage: "mcp" });
  });

  it("never falls back to inference or another identity when counting is denied", async () => {
    const p = providers();
    p.count.mockRejectedValue(new Error("private-provider-response"));
    const out = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("../ask-preflight.js");
    expect(process.exitCode).toBe(1);
    expect(p.count).toHaveBeenCalledOnce();
    expect(p.converse).not.toHaveBeenCalled();
    const output = String(out.mock.calls[0]![0]);
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      stage: "counter",
      code: "PREFLIGHT_FAILED",
    });
    expect(output).not.toContain("private-");
  });
});
