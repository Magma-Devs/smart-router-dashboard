import { describe, it, expect } from "vitest";
import type { StatusFinding } from "@sr/shared";
import { severityOf, digestForIssue, type FormulatedInputs } from "../services/formulated-issues.js";
import { fingerprint, outcomesBySpec } from "../services/issues-feed.js";

function finding(over: Partial<StatusFinding>): StatusFinding {
  return {
    kind: "dead",
    tier: "critical",
    id: "SOLANAT:blockdaemon:errors",
    spec: "SOLANAT",
    chainName: "Solana Testnet",
    upstream: "blockdaemon",
    role: null,
    headline: "75.4% errors - mostly no reply",
    metric: { value: "75.4%", label: "errors" },
    codes: ["NODE_TIMEOUT"],
    evidence: [],
    remedy: "",
    sinceSec: null,
    firstSeenUnix: null,
    lastSeenUnix: null,
    ongoing: true,
    decision: null,
    ...over,
  } as StatusFinding;
}

describe("severityOf reads the outcome", () => {
  it("a provider that gave no answer is not critical when every request was rescued", () => {
    // The contradiction this exists for: a red badge over "your requests are
    // still landing", because `dead` names the provider, not the request.
    expect(severityOf([finding({})], { failures: 0 })).toBe("degraded");
  });

  it("is critical once any of those requests reached the caller", () => {
    expect(severityOf([finding({})], { failures: 12 })).toBe("critical");
  });

  it("keeps the old reading when the outcome was never measured", () => {
    expect(severityOf([finding({})], { failures: null })).toBe("critical");
    expect(severityOf([finding({})])).toBe("critical");
  });

  it("an error body reaches the caller whatever the retry count says", () => {
    // Error answers are not retried, so a zero final-failure count cannot
    // have rescued them.
    expect(severityOf([finding({ kind: "answered-error" })], { failures: 0 })).toBe("critical");
  });

  it("caller-side rejections stay config", () => {
    const f = finding({
      kind: "answered-error",
      codes: ["CHAIN_NONCE_TOO_LOW"],
      codeCounts: { CHAIN_NONCE_TOO_LOW: 700 },
    });
    expect(severityOf([f], { failures: 0 })).toBe("config");
  });
});

describe("digestForIssue", () => {
  const inputs: FormulatedInputs = {
    spec: "SOLANAT",
    chain: "Solana Testnet",
    findings: [finding({})],
    errorGroups: [],
    configured: [],
    insights: [],
    recovered: 1200,
    failures: 0,
  };

  it("hands the model the outcome, and what the finding kind means", () => {
    const d = JSON.parse(digestForIssue(inputs));
    expect(d.outcome).toMatchObject({ savedByRetry: 1200, reachedCaller: 0 });
    expect(d.whatWeMeasured[0].whatItMeans).toMatch(/no answer/);
  });

  it("omits what was not measured rather than sending nulls to write about", () => {
    const d = JSON.parse(digestForIssue({ ...inputs, recovered: null, failures: null }));
    expect(d).not.toHaveProperty("outcome");
    expect(d).not.toHaveProperty("providersConfigured");
  });
});

describe("fingerprint", () => {
  const f = [finding({})];
  it("rewrites when the outcome crosses zero — the line that flips the badge", () => {
    expect(fingerprint(f, [], { recovered: 900, failures: 0 })).not.toBe(
      fingerprint(f, [], { recovered: 900, failures: 3 }),
    );
  });
  it("keeps the wording while counts tick within the same scale", () => {
    expect(fingerprint(f, [], { recovered: 910, failures: 3 })).toBe(
      fingerprint(f, [], { recovered: 960, failures: 7 }),
    );
  });
});

describe("outcomesBySpec", () => {
  const row = (spec: string, v: number) => ({ metric: { spec }, value: [0, String(v)] as [number, string] });
  const prom = (failed: ReturnType<typeof row>[], saved: ReturnType<typeof row>[]) => ({
    query: async (q: string) => (q.includes("requests_failed") ? failed : saved),
  });

  it("reads both counters per chain, rounded", async () => {
    const of = await outcomesBySpec(prom([row("SOLANAT", 3.6)], [row("SOLANAT", 1199.8)]), "30m");
    expect(of("SOLANAT")).toEqual({ recovered: 1200, failures: 4 });
  });

  it("a family with series elsewhere but none for this chain is a real zero", async () => {
    const of = await outcomesBySpec(prom([row("ETH1", 5)], [row("ETH1", 9)]), "30m");
    expect(of("SOLANAT")).toEqual({ recovered: 0, failures: 0 });
  });

  it("no series anywhere is unmeasured, never an invented zero", async () => {
    const of = await outcomesBySpec(prom([], []), "30m");
    expect(of("SOLANAT")).toEqual({ recovered: null, failures: null });
  });
});
