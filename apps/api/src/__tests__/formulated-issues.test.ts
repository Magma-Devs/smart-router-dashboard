import { describe, it, expect } from "vitest";
import type { StatusFinding } from "@sr/shared";
import { severityOf, shareFailed, digestForIssue, type FormulatedInputs } from "../services/formulated-issues.js";
import { fingerprint, finalsBySpec, outcomesBySpec } from "../services/issues-feed.js";

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

describe("severityOf: can the chain still be used", () => {
  // Omer's rule: critical only when the chain is inaccessible. If the router
  // can fail over, it is not critical.
  const out = (failures: number | null, requests: number | null) => ({ failures, requests });

  it("a provider failing while the router saves the rest is degraded", () => {
    // Measured: 485 of ~12,400 got no answer, the router saved 486 more.
    expect(severityOf([finding({})], out(485, 12_400))).toBe("degraded");
  });

  it("is critical when at least half the chain's requests got no answer", () => {
    expect(severityOf([finding({})], out(25_046, 31_000))).toBe("critical");
    expect(severityOf([finding({})], out(500, 1_000))).toBe("critical");
    expect(severityOf([finding({})], out(499, 1_000))).toBe("degraded");
  });

  it("is critical when every provider on the chain is failing", () => {
    // The chain-down finding carries no upstream: it is about all of them.
    const down = finding({ id: "SOLANAT:chain:down", upstream: null });
    expect(severityOf([down], out(null, null))).toBe("critical");
  });

  it("error answers from one provider leave the chain usable", () => {
    // The card that prompted the rule: a red badge over "nothing is failing
    // for you right now".
    expect(severityOf([finding({ kind: "answered-error" })], out(0, 9_000))).toBe("degraded");
  });

  it("without an outcome, only the chain-down test can call it critical", () => {
    expect(severityOf([finding({})])).toBe("degraded");
  });

  it("caller-side rejections stay config", () => {
    const f = finding({
      kind: "answered-error",
      codes: ["CHAIN_NONCE_TOO_LOW"],
      codeCounts: { CHAIN_NONCE_TOO_LOW: 700 },
    });
    expect(severityOf([f], out(0, 9_000))).toBe("config");
  });

  it("is critical when a kind of request cannot be served, even if reads are fine", () => {
    // Omer: "if there is a debug call and no provider can serve it, it's
    // critical, because the transaction can't be fulfilled."
    const debugDead = { failures: 1_306, requests: 40_000, addonCalls: [{ addon: "debug" as const, sent: 1_306, failed: 1_306 }] };
    expect(severityOf([finding({})], debugDead)).toBe("critical");
  });

  it("debug calls the router mostly answers leave it degraded", () => {
    const o = { failures: 12, requests: 40_000, addonCalls: [{ addon: "debug" as const, sent: 1_306, failed: 12 }] };
    expect(severityOf([finding({})], o)).toBe("degraded");
  });

  it("two failed calls of two sent is a blip, not a verdict", () => {
    const o = { failures: 2, requests: 40_000, addonCalls: [{ addon: "trace" as const, sent: 2, failed: 2 }] };
    expect(severityOf([finding({})], o)).toBe("degraded");
  });

  it("unmeasured add-on failures never make it critical", () => {
    const o = { failures: null, requests: null, addonCalls: [{ addon: "debug" as const, sent: 900, failed: null }] };
    expect(severityOf([finding({})], o)).toBe("degraded");
  });

  it("the share survives counters scraped a moment apart", () => {
    expect(shareFailed(out(1_010, 1_000))).toBe(1);
    expect(shareFailed(out(3, null))).toBeNull();
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
    requests: 12_400,
  };

  it("hands the model the outcome, and what the finding kind means", () => {
    const d = JSON.parse(digestForIssue(inputs));
    expect(d.outcome).toMatchObject({ savedByRetry: 1200, reachedCaller: 0, totalRequests: 12_400 });
    // The misreading that wrote "none reached you" over a provider answering
    // with errors: error answers are not in reachedCaller.
    expect(d.outcome.note).toMatch(/error ANSWER from a provider is not in reachedCaller/);
    expect(d.whatWeMeasured[0].whatItMeans).toMatch(/no answer/);
  });

  it("omits what was not measured rather than sending nulls to write about", () => {
    const d = JSON.parse(digestForIssue({ ...inputs, recovered: null, failures: null, requests: null }));
    expect(d).not.toHaveProperty("outcome");
    expect(d).not.toHaveProperty("providersConfigured");
  });
});

describe("fingerprint", () => {
  const f = [finding({})];
  it("rewrites when the outcome crosses zero — the line that flips the badge", () => {
    expect(fingerprint(f, [], { recovered: 900, failures: 0, requests: 9_000 })).not.toBe(
      fingerprint(f, [], { recovered: 900, failures: 3, requests: 9_000 }),
    );
  });
  it("rewrites when the badge moves, even if no count changed scale", () => {
    const o = { recovered: 0, failures: 600, requests: 1_000 };
    expect(fingerprint(f, [], o, "critical")).not.toBe(fingerprint(f, [], o, "degraded"));
  });
  it("keeps the wording while a busy count ticks within its leading digit", () => {
    expect(fingerprint(f, [], { recovered: 910, failures: 30, requests: 9_000 })).toBe(
      fingerprint(f, [], { recovered: 960, failures: 34, requests: 9_000 }),
    );
  });
  it("rewrites a small count on any change — 6 against a real 3 is wrong by half", () => {
    expect(fingerprint(f, [], { recovered: 0, failures: 6, requests: 9_000 })).not.toBe(
      fingerprint(f, [], { recovered: 0, failures: 3, requests: 9_000 }),
    );
  });
});

describe("outcomesBySpec", () => {
  const row = (spec: string, v: number) => ({ metric: { spec }, value: [0, String(v)] as [number, string] });
  type Row = { metric: Record<string, string>; value: [number, string] };
  const prom = (failed: Row[], saved: Row[], requested: Row[] = [], addonSent: Row[] = [], addonFailed: Row[] = []) => ({
    query: async (q: string) =>
      q.includes("label_replace")
        ? q.includes("requests_failed") ? addonFailed : addonSent
        : q.includes("requests_failed") ? failed : q.includes("retries_success") ? saved : requested,
  });
  const addonRow = (spec: string, addon: string, v: number): Row => ({ metric: { spec, addon }, value: [0, String(v)] });

  it("takes failures from the final-result log, once per request", async () => {
    const finals = new Map([["SOLANAT", { total: 22_336, failed: 0 }]]);
    // The attempt counter says 652 — every one saved by a retry.
    const of = await outcomesBySpec(prom([row("SOLANAT", 652)], [row("SOLANAT", 653)], [row("SOLANAT", 22_000)]), "30m", finals);
    expect(of("SOLANAT")).toEqual({ recovered: 653, failures: 0, requests: 22_336, addonCalls: [] });
  });

  it("never falls back to the per-attempt counter without the log", async () => {
    const of = await outcomesBySpec(prom([row("SOLANAT", 652)], [row("SOLANAT", 653)], [row("SOLANAT", 22_000)]), "30m");
    expect(of("SOLANAT")).toMatchObject({ failures: null, requests: 22_000 });
  });

  it("a family with series elsewhere but none for this chain is a real zero", async () => {
    const of = await outcomesBySpec(prom([row("ETH1", 5)], [row("ETH1", 9)], [row("ETH1", 90)]), "30m", new Map());
    // Recovered and requests are counters with series elsewhere: a real zero.
    // Failures for a chain the log never mentioned stay unmeasured.
    expect(of("SOLANAT")).toEqual({ recovered: 0, failures: null, requests: 0, addonCalls: [] });
  });

  it("no series anywhere is unmeasured, never an invented zero", async () => {
    const of = await outcomesBySpec(prom([], []), "30m");
    expect(of("SOLANAT")).toEqual({ recovered: null, failures: null, requests: null, addonCalls: [] });
  });

  it("splits debug and trace calls per chain, zero where the counter has none", async () => {
    const of = await outcomesBySpec(
      prom(
        [row("AVALANCHECT", 1_300)], [], [row("AVALANCHECT", 9_000)],
        [addonRow("AVALANCHECT", "debug", 1_306.4), addonRow("AVALANCHECT", "trace", 40), addonRow("ETH1", "debug", 5)],
        [addonRow("AVALANCHECT", "debug", 1_290.2)],
      ),
      "30m",
    );
    expect(of("AVALANCHECT").addonCalls).toEqual([
      { addon: "debug", sent: 1_306, failed: 1_290 },
      { addon: "trace", sent: 40, failed: 0 },
    ]);
  });

  it("with no failure counter at all, add-on failures are unmeasured, not zero", async () => {
    const of = await outcomesBySpec(prom([], [], [], [addonRow("ETH1", "debug", 5)], []), "30m");
    expect(of("ETH1").addonCalls).toEqual([{ addon: "debug", sent: 5, failed: null }]);
  });
});

describe("finalsBySpec", () => {
  it("maps router ids to chains through the config, summing routers on one chain", () => {
    const byRouter = new Map([
      ["solana-mainnet", { total: 24_599, failed: 59 }],
      ["solana-mainnet-staging", { total: 100, failed: 1 }],
      ["unknown-router", { total: 5, failed: 5 }],
    ]);
    const routers = [
      { id: "solana-mainnet", spec: "SOLANA" },
      { id: "SOLANA-MAINNET-STAGING", spec: "SOLANA" },
    ];
    expect(finalsBySpec(byRouter, routers)).toEqual(new Map([["SOLANA", { total: 24_699, failed: 60 }]]));
  });
});

