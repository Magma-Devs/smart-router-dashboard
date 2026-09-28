/**
 * The per-(chain × provider) verdict.
 *
 * The verdict decides who gets the ticket, so the tests that matter are the
 * ones that stop it being wrong quietly: a value outside the closed set must
 * become `undetermined` rather than reach the page, and the peer comparison —
 * the input that separates "this node is broken" from "the chain is" — must
 * actually be put in front of the model.
 */
import { describe, it, expect, vi } from "vitest";
import {
  FailureAnalysisService,
  digestInputs,
  toOwner,
  type FailureInputs,
} from "../services/failure-analysis.js";
import type { BedrockService } from "../services/bedrock.js";
import type { StatusFinding } from "@sr/shared";

const inputs: FailureInputs = {
  spec: "SOLANAT",
  chainName: "Solana Testnet",
  upstream: "blockdaemon",
  role: "primary",
  findings: [
    { kind: "errors", tier: "fatal", headline: "8.3% rate-limited", metric: { value: "8.3%", label: "rate-limited" }, codes: ["NODE_RATE_LIMITED"], ongoing: true } as unknown as StatusFinding,
  ],
  errorGroups: [
    { count: 12, lastAtUnix: 1, errorName: "NODE_RATE_LIMITED", methods: ["getSlot"], method: "getSlot", provider: "blockdaemon", example: "429 Too Many Requests" },
  ],
  peers: [{ upstream: "lava", failing: false, note: "" }],
  otherChains: [{ spec: "NEAR", chainName: "Near", note: "67 error answers" }],
  blocked: null,
  servingTier: null,
};

function fakeBedrock(text: string): BedrockService {
  return {
    complete: vi.fn(async () => ({ text, stopReason: "end_turn", inputTokens: 1, outputTokens: 1 })),
  } as unknown as BedrockService;
}

describe("toOwner", () => {
  it("accepts the four owners and undetermined", () => {
    for (const v of ["provider", "setup", "caller", "chain", "undetermined"]) {
      expect(toOwner(v)).toBe(v);
    }
  });

  it("turns anything else into undetermined rather than passing it through", () => {
    // A verdict outside the set would render as an unknown owner and send a
    // ticket nowhere. Invented severities, prose, nulls all collapse here.
    for (const v of ["Provider", "network", "the provider's fault", "", null, 7, undefined]) {
      expect(toOwner(v)).toBe("undetermined");
    }
  });
});

describe("digestInputs", () => {
  it("puts the peers in front of the model — the input the verdict turns on", () => {
    const body = digestInputs(inputs);
    expect(body).toContain("othersOnThisChain");
    expect(body).toContain("lava");
  });

  it("sends the real error line, not just the code", () => {
    // The code says the class; the line says what the node actually returned,
    // and they can disagree.
    expect(digestInputs(inputs)).toContain("429 Too Many Requests");
  });

  it("sends the provider's other chains, so 'broken everywhere' is visible", () => {
    expect(digestInputs(inputs)).toContain("sameProviderOtherChains");
    expect(digestInputs(inputs)).toContain("Near");
  });
});

describe("the router's own block state", () => {
  it("tells the model the family is NOT PUBLISHED, never that the provider is serving", () => {
    // The trap this guards: an older router build emits only the per-chain
    // count of blocked providers, so the per-provider gauge returns nothing.
    // Rendering that absence as "serving" would turn "we cannot see" into a
    // clean bill of health for a provider that may be out of rotation.
    const body = digestInputs({ ...inputs, blocked: null, servingTier: null });
    expect(body).toContain("not published by this router build");
    expect(body).not.toContain('"state": "serving"');
  });

  it("passes the state and its reason through when the build does publish it", () => {
    const body = digestInputs({
      ...inputs,
      blocked: { state: "blocked", reason: "all-endpoints-disabled" },
      servingTier: "backups-only",
    });
    expect(body).toContain("all-endpoints-disabled");
    expect(body).toContain("backups-only");
  });

  it("carries a serving verdict too — a provider erroring but NOT blocked is a real distinction", () => {
    // Errors without a block means the router still routes to it, which reads
    // very differently from one it has taken out.
    const body = digestInputs({ ...inputs, blocked: { state: "serving", reason: null }, servingTier: "primaries" });
    expect(body).toContain('"state": "serving"');
  });
});

describe("FailureAnalysisService.analyse", () => {
  it("returns a constrained verdict with its per-code owners", async () => {
    const bedrock = fakeBedrock(
      JSON.stringify({
        verdict: "provider",
        summary: "blockdaemon is rate-limiting",
        errors: [{ code: "NODE_RATE_LIMITED", meaning: "the provider throttled us", whose: "provider" }],
        versusPeers: "lava is clean",
        elsewhere: "also failing on Near",
      }),
    );

    const out = await new FailureAnalysisService(bedrock).analyse(inputs);
    expect(out.verdict).toBe("provider");
    expect(out.errors).toEqual([
      { code: "NODE_RATE_LIMITED", meaning: "the provider throttled us", whose: "provider" },
    ]);
    expect(out.versusPeers).toBe("lava is clean");
  });

  it("downgrades an invented verdict instead of rendering it", async () => {
    const bedrock = fakeBedrock('{"verdict":"definitely the provider","summary":"s","errors":[]}');
    const out = await new FailureAnalysisService(bedrock).analyse(inputs);
    expect(out.verdict).toBe("undetermined");
  });

  it("drops an error entry with no code rather than rendering a blank row", async () => {
    const bedrock = fakeBedrock(
      '{"verdict":"chain","summary":"s","errors":[{"meaning":"m","whose":"chain"},{"code":"X","meaning":"m","whose":"chain"}]}',
    );
    const out = await new FailureAnalysisService(bedrock).analyse(inputs);
    expect(out.errors.map((e) => e.code)).toEqual(["X"]);
  });

  it("throws rather than returning an empty verdict on junk", async () => {
    const bedrock = fakeBedrock("I cannot determine that");
    await expect(new FailureAnalysisService(bedrock).analyse(inputs)).rejects.toThrow(/JSON/);
  });
});
