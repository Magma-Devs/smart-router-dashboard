import { describe, it, expect } from "vitest";
import type { StatusFinding } from "@sr/shared";
import { severityOf, shareFailed, digestForIssue, type FormulatedInputs } from "../services/formulated-issues.js";
import { burstFinding, failedBySpec, fingerprint, groupTraces, mergePaths, outcomesBySpec, peakBurst, readLogs } from "../services/issues-feed.js";
import type { RequestTrace } from "../services/loki.js";

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
    const debugDead = { failures: 1_306, requests: 40_000, addonCalls: [{ addon: "debug" as const, sent: 1_306, failed: 1_306, errorReplies: 0 }] };
    expect(severityOf([finding({})], debugDead)).toBe("critical");
  });

  it("debug calls the router mostly answers leave it degraded", () => {
    const o = { failures: 12, requests: 40_000, addonCalls: [{ addon: "debug" as const, sent: 1_306, failed: 12, errorReplies: 0 }] };
    expect(severityOf([finding({})], o)).toBe("degraded");
  });

  it("two failed calls of two sent is a blip, not a verdict", () => {
    const o = { failures: 2, requests: 40_000, addonCalls: [{ addon: "trace" as const, sent: 2, failed: 2, errorReplies: 0 }] };
    expect(severityOf([finding({})], o)).toBe("degraded");
  });

  it("unmeasured add-on failures never make it critical", () => {
    const o = { failures: null, requests: null, addonCalls: [{ addon: "debug" as const, sent: 900, failed: null, errorReplies: null }] };
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
  const prom = (
    failed: Row[], saved: Row[], requested: Row[] = [], addonSent: Row[] = [], addonFailed: Row[] = [],
    addonErrors: Row[] = [], addonSaved: Row[] = [], writeMethods: Row[] = [], writesSent: Row[] = [],
  ) => ({
    query: async (q: string) =>
      q.includes("requests_write_total") ? writeMethods
      : q.includes("sum by (spec, function)") ? writesSent
      : q.includes("label_replace")
        ? q.includes("requests_failed") ? addonFailed
          : q.includes("node_errors") ? addonErrors
          : q.includes("retries_success") ? addonSaved
          : addonSent
        : q.includes("requests_failed") ? failed : q.includes("retries_success") ? saved : requested,
  });
  const addonRow = (spec: string, addon: string, v: number): Row => ({ metric: { spec, addon }, value: [0, String(v)] });

  it("takes failures from the final-result log, once per request", async () => {
    // The attempt counter says 652 — every one saved by a retry. The log: 0.
    const of = await outcomesBySpec(prom([row("SOLANAT", 652)], [row("SOLANAT", 653)], [row("SOLANAT", 22_336)]), "30m", {
      failed: new Map([["SOLANAT", 0]]),
      failedMethods: new Map(),
      paths: new Map(),
    });
    expect(of("SOLANAT")).toEqual({ recovered: 653, failures: 0, requests: 22_336, addonCalls: [], writes: null, paths: null });
  });

  it("never falls back to the per-attempt counter without the log", async () => {
    const of = await outcomesBySpec(prom([row("SOLANAT", 652)], [row("SOLANAT", 653)], [row("SOLANAT", 22_000)]), "30m");
    expect(of("SOLANAT")).toMatchObject({ failures: null, requests: 22_000 });
  });

  it("a family with series elsewhere but none for this chain is a real zero", async () => {
    const of = await outcomesBySpec(prom([row("ETH1", 5)], [row("ETH1", 9)], [row("ETH1", 90)]), "30m", {
      failed: new Map(),
      failedMethods: new Map(),
      paths: new Map(),
    });
    // Recovered and requests are counters with series elsewhere: a real zero.
    // Failures for a chain the log never mentioned stay unmeasured.
    expect(of("SOLANAT")).toEqual({ recovered: 0, failures: null, requests: 0, addonCalls: [], writes: null, paths: null });
  });

  it("no series anywhere is unmeasured, never an invented zero", async () => {
    const of = await outcomesBySpec(prom([], []), "30m");
    expect(of("SOLANAT")).toEqual({ recovered: null, failures: null, requests: null, addonCalls: [], writes: null, paths: null });
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
      { addon: "debug", sent: 1_306, failed: 1_290, errorReplies: 0 },
      { addon: "trace", sent: 40, failed: 0, errorReplies: 0 },
    ]);
  });

  it("with no failure counter at all, add-on failures are unmeasured, not zero", async () => {
    const of = await outcomesBySpec(prom([], [], [], [addonRow("ETH1", "debug", 5)], []), "30m");
    expect(of("ETH1").addonCalls).toEqual([{ addon: "debug", sent: 5, failed: null, errorReplies: null }]);
  });

  it("counts error replies as unserved, and takes off what a retry saved", async () => {
    // Measured shape: nodes answer "the method does not exist" to debug calls,
    // no retry replaces it; no-answer attempts elsewhere are all saved.
    const of = await outcomesBySpec(
      prom(
        [row("ARBITRUM", 10)], [], [],
        [addonRow("FTM250", "debug", 2_839), addonRow("ARBITRUM", "debug", 13_522)],
        [addonRow("ARBITRUM", "debug", 10)],
        [addonRow("FTM250", "debug", 759)],
        [addonRow("ARBITRUM", "debug", 10)],
      ),
      "30m",
    );
    expect(of("FTM250").addonCalls).toEqual([{ addon: "debug", sent: 2_839, failed: 759, errorReplies: 759 }]);
    expect(of("ARBITRUM").addonCalls).toEqual([{ addon: "debug", sent: 13_522, failed: 0, errorReplies: 0 }]);
    // 27% unserved: a provider still answers most of them — degraded, not critical.
    const tatumErrors = finding({ kind: "answered-error", spec: "FTM250", upstream: "tatum" });
    expect(severityOf([tatumErrors], { addonCalls: of("FTM250").addonCalls })).toBe("degraded");
    // Past half, nothing is serving them.
    const most = [{ addon: "debug" as const, sent: 2_839, failed: 1_500, errorReplies: 1_500 }];
    expect(severityOf([tatumErrors], { addonCalls: most })).toBe("critical");
  });
});

describe("failedBySpec", () => {
  const routers = [
    { id: "solana-mainnet", spec: "SOLANA" },
    { id: "SOLANA-MAINNET-STAGING", spec: "SOLANA" },
    { id: "near-mainnet", spec: "NEAR" },
    { id: "tron-testnet", spec: "TRXT" },
  ];
  it("sums routers on one chain; 0 only where the logs exist; unknown routers dropped", () => {
    const counts = new Map([["solana-mainnet", 59], ["solana-mainnet-staging", 1], ["unknown-router", 5]]);
    const withLogs = new Set(["solana-mainnet", "solana-mainnet-staging", "near-mainnet"]);
    expect(failedBySpec(counts, routers, withLogs)).toEqual(new Map([["SOLANA", 60], ["NEAR", 0]]));
    // TRXT has no logs in the store: no number at all, never "0 failed".
  });
});

describe("transactions", () => {
  type Row = { metric: Record<string, string>; value: [number, string] };
  const r = (metric: Record<string, string>, v: number): Row => ({ metric, value: [0, String(v)] });
  const promFor = (writeMethods: Row[], writesSent: Row[]) => ({
    query: async (q: string) =>
      q.includes("requests_write_total") ? writeMethods : q.includes("sum by (spec, function)") ? writesSent : [],
  });

  it("counts the router's own write methods, sent and failed per chain", async () => {
    const prom = promFor(
      [r({ spec: "POLYGON", method: "eth_sendRawTransaction" }, 1), r({ spec: "XLM", method: "/transactions" }, 1)],
      [
        r({ spec: "POLYGON", function: "eth_sendRawTransaction" }, 152),
        r({ spec: "XLM", function: "/transactions" }, 4),
        // A method this chain does not flag as a write is not a transaction here.
        r({ spec: "XLM", function: "eth_sendRawTransaction" }, 99),
      ],
    );
    const logs = {
      failed: new Map([["POLYGON", 90]]),
      failedMethods: new Map([["POLYGON", new Map([["eth_sendRawTransaction", 80], ["eth_call", 10]])]]),
      paths: new Map(),
    };
    const of = await outcomesBySpec(prom, "30m", logs);
    expect(of("POLYGON").writes).toEqual({ sent: 152, failed: 80 });
    expect(of("XLM").writes).toEqual({ sent: 4, failed: 0 });
    // More than half of its transactions failed: they cannot transact.
    expect(severityOf([finding({ spec: "POLYGON" })], of("POLYGON"))).toBe("critical");
  });

  it("a few failed transactions leave it degraded", async () => {
    expect(severityOf([finding({})], { writes: { sent: 1_124, failed: 6 } })).toBe("degraded");
  });

  it("without the logs, transactions are sent but their failures unmeasured", async () => {
    const prom = promFor([r({ spec: "ETH1", method: "eth_sendRawTransaction" }, 1)], [r({ spec: "ETH1", function: "eth_sendRawTransaction" }, 1_124)]);
    expect((await outcomesBySpec(prom, "30m")).call(null, "ETH1").writes).toEqual({ sent: 1_124, failed: null });
  });
});

describe("readLogs", () => {
  const routers = [{ id: "polygon-mainnet", spec: "POLYGON" }];
  const f = (id: string) => ({ id, pod: "polygon-mainnet-router-aa11-bb22", atUnix: 1_700_000_000 });
  const loki = (ids: string[], methods: Map<string, string>, opts: { capped?: boolean; count?: number } = {}) => ({
    routersWithLogs: async () => new Set(["polygon-mainnet"]),
    failedRequests: async () => ({ byRouter: new Map([["polygon-mainnet", ids.map(f)]]), capped: opts.capped ?? false }),
    countFailed: async () => new Map([["polygon-mainnet", opts.count ?? ids.length]]),
    methodsOf: async () => methods,
    traceRequests: async () =>
      new Map(ids.map((id) => [id, trace(id, methods.get(id) ?? "unknown", [["alchemy", "primary", "timed out"]])])),
  });
  const m = new Map([["1", "eth_sendRawTransaction"], ["2", "eth_sendRawTransaction"], ["3", "eth_call"]]);

  it("counts a chain's failed requests and splits them by the method each had called", async () => {
    const out = await readLogs(loki(["1", "2", "3"], m), 1800, routers);
    expect(out?.failed).toEqual(new Map([["POLYGON", 3]]));
    expect(out?.failedMethods.get("POLYGON")).toEqual(new Map([["eth_sendRawTransaction", 2], ["eth_call", 1]]));
  });

  it("when a bad hour overflows the read, counts, and scales the sampled split to it", async () => {
    const out = await readLogs(loki(["1", "2", "3"], m, { capped: true, count: 300 }), 1800, routers);
    expect(out?.failed).toEqual(new Map([["POLYGON", 300]]));
    expect(out?.failedMethods.get("POLYGON")).toEqual(new Map([["eth_sendRawTransaction", 200], ["eth_call", 100]]));
  });

  it("groups the chain's traced requests by the way they went", async () => {
    const out = await readLogs(loki(["1", "2", "3"], m), 1800, routers);
    expect(out?.paths.get("POLYGON")).toEqual({
      traced: 3,
      groups: [{ count: 3, flow: "alchemy ✕ timed out → failed", methods: ["eth_sendRawTransaction", "eth_call"], seconds: [14, 14] }],
    });
  });
});

/** A traced request: each attempt is [provider, role, outcome]. */
function trace(id: string, method: string, attempts: [string, "primary" | "backup", string][], seconds = 14): RequestTrace {
  return { id, method, failed: true, seconds, attempts: attempts.map(([provider, role, outcome]) => ({ provider, role, outcome, atSec: null })) };
}

describe("failover paths", () => {
  const both: [string, "primary" | "backup", string][] = [["alchemy", "primary", "timed out"], ["quicknode", "backup", "timed out"]];

  it("six requests down one path are one path of six — not per-provider counts", () => {
    const p = groupTraces([
      ...[1, 2, 3, 4].map((i) => trace(String(i), "starknet_getEvents", both, 13 + (i % 2))),
      trace("5", "starknet_call", both, 10),
      trace("6", "starknet_getEvents", [["alchemy", "primary", "rate-limited"]], 1),
    ]);
    expect(p).toEqual({
      traced: 6,
      groups: [
        { count: 5, flow: "alchemy ✕ timed out → quicknode (backup) ✕ timed out → failed", methods: ["starknet_getEvents", "starknet_call"], seconds: [10, 14] },
        { count: 1, flow: "alchemy ✕ rate-limited → failed", methods: ["starknet_getEvents"], seconds: [1, 1] },
      ],
    });
  });

  it("leaves out a request whose path was not read — a gap would state something false", () => {
    expect(groupTraces([trace("1", "eth_call", [])])).toBeNull();
  });

  it("merges several chains' paths for an issue that covers them", () => {
    const a = groupTraces([trace("1", "eth_call", both, 12)]);
    const b = groupTraces([trace("2", "eth_getLogs", both, 16), trace("3", "eth_getLogs", [["tatum", "primary", "server error"]])]);
    expect(mergePaths([a, null, b])).toEqual({
      traced: 3,
      groups: [
        { count: 2, flow: "alchemy ✕ timed out → quicknode (backup) ✕ timed out → failed", methods: ["eth_call", "eth_getLogs"], seconds: [12, 16] },
        { count: 1, flow: "tatum ✕ server error → failed", methods: ["eth_getLogs"], seconds: [14, 14] },
      ],
    });
    expect(mergePaths([null])).toBeNull();
  });

  it("hands the model the paths, and tells it not to split them per provider", () => {
    const paths = groupTraces([trace("1", "starknet_getEvents", both), trace("2", "starknet_getEvents", both)]);
    const d = JSON.parse(
      digestForIssue({ spec: "STRK", chain: "Starknet", findings: [finding({})], errorGroups: [], configured: [], insights: [], failures: 6, paths }),
    );
    expect(d.outcome.howTheFailedRequestsWent).toEqual({
      traced: 2,
      ofFailed: 6,
      paths: [{ requests: 2, methods: ["starknet_getEvents"], path: "alchemy ✕ timed out → quicknode (backup) ✕ timed out → failed", wholePathSeconds: 14 }],
    });
  });

  it("rewrites when the main path changes, not when one more request takes it", () => {
    const f = [finding({})];
    const o = (paths: ReturnType<typeof groupTraces>) => ({ recovered: 0, failures: 6, requests: 9_000, paths });
    const one = groupTraces([trace("1", "x", [["alchemy", "primary", "timed out"]])]);
    const two = groupTraces([1, 2].map((i) => trace(String(i), "x", [["alchemy", "primary", "timed out"]])));
    const backupToo = groupTraces([trace("1", "x", both)]);
    expect(fingerprint(f, [], o(one))).toBe(fingerprint(f, [], o(two)));
    expect(fingerprint(f, [], o(one))).not.toBe(fingerprint(f, [], o(backupToo)));
  });
});

describe("bursts — the alert's own test", () => {
  const T = 1_790_000_000;

  it("finds the densest five minutes", () => {
    // Six inside 4 minutes, then two stragglers half an hour of window later.
    const times = [T, T + 30, T + 60, T + 90, T + 200, T + 240, T + 1200, T + 1500];
    expect(peakBurst(times)).toEqual({ count: 6, fromUnix: T, toUnix: T + 240, lastUnix: T + 1500 });
    expect(peakBurst([])).toBeNull();
  });

  it("readLogs reports a burst only past five failures in five minutes", async () => {
    const f = (id: string, at: number) => ({ id, pod: "solana-mainnet-router-aa11-bb22", atUnix: at });
    const loki = (list: ReturnType<typeof f>[]) => ({
      routersWithLogs: async () => new Set(["solana-mainnet"]),
      failedRequests: async () => ({ byRouter: new Map([["solana-mainnet", list]]), capped: false }),
      countFailed: async () => new Map(),
      methodsOf: async () => new Map(),
      traceRequests: async () => new Map(),
    });
    const routers = [{ id: "solana-mainnet", spec: "SOLANA" }];
    const six = [0, 20, 40, 60, 80, 100].map((d, i) => f(String(i), T + d));
    expect((await readLogs(loki(six), 1800, routers, T + 200))?.bursts.get("SOLANA")?.count).toBe(6);
    const spread = [0, 400, 800, 1200, 1600, 1700].map((d, i) => f(String(i), T + d));
    expect((await readLogs(loki(spread), 1800, routers, T + 1800))?.bursts.size).toBe(0);
  });

  it("a burst opens an issue, and a working chain stays degraded", () => {
    const b = peakBurst([T, T + 10, T + 20, T + 30, T + 40, T + 50])!;
    const burst = burstFinding("SOLANA", "Solana", b, T + 60);
    expect(burst).toMatchObject({ id: "SOLANA:burst", ongoing: true, firstSeenUnix: T });
    // 6 of 24,000 failed: the router kept the chain usable.
    expect(severityOf([burst], { failures: 6, requests: 24_000 })).toBe("degraded");
    // It is not the chain-down finding, whatever its kind.
    expect(burst.id.endsWith(":chain:down")).toBe(false);
  });
});

