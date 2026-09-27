import { describe, it, expect, vi } from "vitest";
import type { StatusFinding } from "@sr/shared";
import {
  severityOf,
  shareFailed,
  digestForIssue,
  impactOf,
  measuredFields,
  plainIssue,
  shareText,
  titleContradicts,
  claimsSuccess,
  isHandled,
  whoActs,
  FormulatedIssueService,
  type ChainOutcome,
  type FormulatedInputs,
} from "../services/formulated-issues.js";
import {
  burstFinding,
  failedBySpec,
  failingTogether,
  fingerprint,
  groupTraces,
  mergePaths,
  mergeRefused,
  outcomesBySpec,
  peakBurst,
  readLogs,
  risksOf,
  togetherIssue,
} from "../services/issues-feed.js";
import type { RequestTrace } from "../services/loki.js";
import type { BedrockService } from "../services/bedrock.js";

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
      rejections: new Map(),
    });
    expect(of("SOLANAT")).toEqual({ recovered: 653, failures: 0, requests: 22_336, addonCalls: [], writes: null, paths: null, rejected: null });
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
      rejections: new Map(),
    });
    // Recovered and requests are counters with series elsewhere: a real zero.
    // Failures for a chain the log never mentioned stay unmeasured.
    expect(of("SOLANAT")).toEqual({ recovered: 0, failures: null, requests: 0, addonCalls: [], writes: null, paths: null, rejected: null });
  });

  it("no series anywhere is unmeasured, never an invented zero", async () => {
    const of = await outcomesBySpec(prom([], []), "30m");
    expect(of("SOLANAT")).toEqual({ recovered: null, failures: null, requests: null, addonCalls: [], writes: null, paths: null, rejected: null });
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
      rejections: new Map(),
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
  const f = (id: string) => ({ id, stream: "polygon-mainnet-router-aa11-bb22", atUnix: 1_700_000_000 });
  const loki = (ids: string[], methods: Map<string, string>, opts: { capped?: boolean; count?: number } = {}) => ({
    routersWithLogs: async () => new Set(["polygon-mainnet"]),
    failedRequests: async () => ({ byRouter: new Map([["polygon-mainnet", ids.map(f)]]), capped: opts.capped ?? false }),
    countFailed: async () => new Map([["polygon-mainnet", opts.count ?? ids.length]]),
    methodsOf: async () => methods,
    traceRequests: async () =>
      new Map(ids.map((id) => [id, trace(id, methods.get(id) ?? "unknown", [["alchemy", "primary", "timed out"]])])),
    rejectedRequests: async () => ({ byRouter: new Map(), capped: false }),
    resentTransactions: async () => ({ checked: 0, resent: 0, mostSends: 0 }),
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
    expect(out?.paths.get("POLYGON")).toMatchObject({
      traced: 3,
      groups: [
        {
          count: 3,
          flow: "Alchemy ✕ timed out → failed",
          route: "Alchemy ✕ timed out → failed",
          methods: ["eth_sendRawTransaction", "eth_call"],
          seconds: [14, 14],
        },
      ],
    });
  });
});

/** A traced request: each attempt is [provider, role, outcome, when it started]. */
function trace(id: string, method: string, attempts: [string, "primary" | "backup", string, number?][], seconds = 14): RequestTrace {
  return {
    id,
    method,
    failed: true,
    seconds,
    atUnix: 1_700_000_000 + Number(id.replace(/\D/g, "") || 0),
    error: null,
    attempts: attempts.map(([provider, role, outcome, startSec]) => ({ provider, role, outcome, startSec: startSec ?? null, endSec: null })),
  };
}

describe("failover paths", () => {
  const both: [string, "primary" | "backup", string][] = [["alchemy", "primary", "timed out"], ["quicknode", "backup", "timed out"]];

  it("six requests down one path are one path of six — not per-provider counts", () => {
    const p = groupTraces([
      ...[1, 2, 3, 4].map((i) => trace(String(i), "starknet_getEvents", both, 13 + (i % 2))),
      trace("5", "starknet_call", both, 10),
      trace("6", "starknet_getEvents", [["alchemy", "primary", "rate-limited"]], 1),
    ]);
    expect(p).toMatchObject({
      traced: 6,
      groups: [
        {
          count: 5,
          flow: "Alchemy ✕ timed out → QuickNode (backup) ✕ timed out → failed",
          route: "Alchemy ✕ timed out → QuickNode (backup) ✕ timed out → failed",
          methods: ["starknet_getEvents", "starknet_call"],
          seconds: [10, 14],
        },
        {
          count: 1,
          flow: "Alchemy ✕ rate-limited → failed",
          route: "Alchemy ✕ rate-limited → failed",
          methods: ["starknet_getEvents"],
          seconds: [1, 1],
        },
      ],
    });
  });

  it("groups on the path without its times, and shows each step at its typical time", () => {
    // One request's "+7s" is another's "+8s" — the same path.
    const timed = (id: string, backupAt: number) =>
      trace(id, "getBlock", [["tatum", "primary", "no answer", 0], ["lava", "backup", "no answer", backupAt]], 30);
    const p = groupTraces([timed("1", 7), timed("2", 8), timed("3", 7)]);
    expect(p?.groups).toHaveLength(1);
    expect(p?.groups[0]).toMatchObject({
      count: 3,
      flow: "Tatum ✕ no answer → +7s Lava (backup) ✕ no answer → failed",
      route: "Tatum ✕ no answer → Lava (backup) ✕ no answer → failed",
    });
  });

  it("backups tried in a different order are the same path", () => {
    // Measured in production: one card split into seventeen lines this way.
    const threeBackups = (id: string, order: string[]) =>
      trace(id, "getBlock", [["tatum", "primary", "timed out", 0], ...order.map((b, i): [string, "backup", string, number] => [b, "backup", "no answer", 7 * (i + 1)])], 30);
    const p = groupTraces([
      threeBackups("1", ["lava", "quicknode", "blockdaemon"]),
      threeBackups("2", ["blockdaemon", "lava", "quicknode"]),
      threeBackups("3", ["quicknode", "blockdaemon", "lava"]),
    ]);
    expect(p?.groups).toHaveLength(1);
    // Every backup failing the same way says how.
    expect(p?.groups[0]).toMatchObject({ count: 3, flow: "Tatum ✕ timed out → +7s 3 backups (Blockdaemon, Lava, QuickNode) ✕ no answer → failed" });
  });

  it("leaves out a request whose path was not read — a gap would state something false", () => {
    expect(groupTraces([trace("1", "eth_call", [])])).toBeNull();
  });

  it("merges several chains' paths for an issue that covers them", () => {
    const a = groupTraces([trace("1", "eth_call", both, 12)]);
    const b = groupTraces([trace("2", "eth_getLogs", both, 16), trace("3", "eth_getLogs", [["tatum", "primary", "server error"]])]);
    expect(mergePaths([a, null, b])).toMatchObject({
      traced: 3,
      groups: [
        {
          count: 2,
          flow: "Alchemy ✕ timed out → QuickNode (backup) ✕ timed out → failed",
          route: "Alchemy ✕ timed out → QuickNode (backup) ✕ timed out → failed",
          methods: ["eth_call", "eth_getLogs"],
          seconds: [12, 16],
        },
        { count: 1, flow: "Tatum ✕ server error → failed", route: "Tatum ✕ server error → failed", methods: ["eth_getLogs"], seconds: [14, 14] },
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
      paths: [{ requests: 2, methods: ["starknet_getEvents"], path: "Alchemy ✕ timed out → QuickNode (backup) ✕ timed out → failed", wholePathSeconds: 14 }],
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
    // The refused transactions turning out to be resends is a new story.
    const refused = (resent: number) => ({
      recovered: 0, failures: 0, requests: 9_000, addonCalls: [], writes: null, paths: null,
      rejected: { requests: 154, byCode: {}, resent: { checked: 6, resent, mostSends: 9 }, latest: [] },
    });
    expect(fingerprint(f, [], refused(6))).not.toBe(fingerprint(f, [], refused(0)));
    expect(fingerprint(f, [], refused(6))).toBe(fingerprint(f, [], refused(5)));
    // A backup added at +8s instead of +7s is the same story.
    const at = (sec: number) => groupTraces([trace("1", "x", [["alchemy", "primary", "timed out", 0], ["quicknode", "backup", "timed out", sec]])]);
    expect(fingerprint(f, [], o(at(7)))).toBe(fingerprint(f, [], o(at(8))));
  });
});

describe("the numbers line — written by code, never by the model", () => {
  const outcome = (over: Partial<ChainOutcome> = {}): ChainOutcome => ({
    recovered: 0,
    failures: 0,
    requests: 1_000,
    addonCalls: [],
    writes: null,
    paths: null,
    ...over,
  });

  it("gives every count its 'of what'", () => {
    expect(impactOf(outcome({ failures: 3, requests: 23_096, recovered: 135 }), [], "degraded")).toBe(
      "3 of 23,096 requests (0.01%) failed: no provider answered them. The router saved 135 others by trying another provider.",
    );
  });

  it("says nothing failed when nothing did — and what the router did to keep it so", () => {
    expect(impactOf(outcome({ failures: 0, requests: 22_185, recovered: 223 }), [], "degraded")).toBe(
      "All 22,185 requests got a reply. The router saved 223 of them by trying another provider.",
    );
  });

  it("never lets 'got a reply' read as 'worked' beside a provider sending errors back", () => {
    const erring = finding({ kind: "answered-error", upstream: "tatum", metric: { value: "1.9%", label: "of answers" } });
    expect(impactOf(outcome({ failures: 0, requests: 4_793 }), [erring], "degraded")).toBe(
      "All 4,793 requests got a reply. Some replies were errors from Tatum.",
    );
    expect(impactOf(outcome({ failures: 3, requests: 7_845 }), [erring], "degraded")).toBe(
      "3 of 7,845 requests (0.04%) failed: no provider answered them. Some other replies were errors from Tatum.",
    );
  });

  it("says when failures are not counted, rather than implying none", () => {
    expect(impactOf(outcome({ failures: null, requests: 7_888, recovered: null }), [], "degraded")).toBe(
      "7,888 requests. Failed requests are not counted: this deployment has no router logs.",
    );
    expect(impactOf(outcome({ failures: null, requests: null, recovered: null }), [], "degraded")).toBeNull();
  });

  it("adds debug calls and transactions that did not work", () => {
    const line = impactOf(
      outcome({
        requests: 50_000,
        addonCalls: [{ addon: "debug", sent: 1_102, failed: 132, errorReplies: 132 }],
        writes: { sent: 152, failed: 4 },
      }),
      [],
      "critical",
    );
    expect(line).toBe(
      "All 50,000 requests got a reply. 132 of 1,102 debug calls did not work. 4 of 152 transactions failed: no provider answered them.",
    );
  });

  it("on the caller-side card, counts what the chains refused — per request, with the resend check", () => {
    // From the router's log, one per request. A transaction goes to every
    // primary, so the counter's per-reply number doubles it (308 lines, 154
    // requests, measured).
    const rejected = {
      requests: 792,
      byCode: { CHAIN_NONCE_TOO_LOW: 772, CHAIN_INSUFFICIENT_FUNDS: 20 },
      resent: { checked: 6, resent: 6, mostSends: 11 },
      latest: [],
    };
    expect(impactOf(outcome({ rejected }), [], "config", 4)).toBe(
      "The 4 chains refused 792 requests: 772 for a nonce (transaction number) that was already used, 20 for an account without enough funds. " +
        "All 6 transactions checked had been sent before — the same transaction, up to 11 times.",
    );
    // "All 187,702 requests got a reply" over refusals would read as a contradiction.
    expect(impactOf(outcome({ rejected, requests: 187_702 }), [], "config", 4)).not.toMatch(/got a reply/);
  });

  it("without the log, counts refusals as what they are — one per provider reply", () => {
    const refusal = (spec: string, code: string, n: number) =>
      finding({ spec, id: `${spec}:caller:${code}`, kind: "config", tier: "config", upstream: null, codes: [code], codeCounts: { [code]: n } });
    expect(impactOf(outcome(), [refusal("BASE", "CHAIN_NONCE_TOO_LOW", 70)], "config")).toBe(
      "Providers passed on 70 refusals from the chain — one per provider a request went to, each for a nonce (transaction number) that was already used.",
    );
  });

  it("prints a share the way it reads — never 0% for something that happened", () => {
    expect(shareText(3, 23_096)).toBe("0.01%");
    expect(shareText(3, 7_888)).toBe("0.04%");
    expect(shareText(1, 1_000_000)).toBe("under 0.01%");
    expect(shareText(17, 1_000)).toBe("1.7%");
    expect(shareText(389, 1_000)).toBe("39%");
  });

  it("the card carries the line and the time it covers; the model is told they are on screen", () => {
    const inputs: FormulatedInputs = {
      spec: "SOLANA",
      chain: "Solana",
      findings: [finding({ spec: "SOLANA" })],
      errorGroups: [],
      configured: [],
      insights: [],
      recovered: 135,
      failures: 3,
      requests: 23_096,
      measured: { fromUnix: 1_790_000_000, toUnix: 1_790_001_800 },
    };
    expect(measuredFields(inputs)).toMatchObject({
      impact: "3 of 23,096 requests (0.01%) failed: no provider answered them. The router saved 135 others by trying another provider.",
      measured: { fromUnix: 1_790_000_000, toUnix: 1_790_001_800 },
    });
    expect(JSON.parse(digestForIssue(inputs)).shownAboveYourPoints).toMatch(/^3 of 23,096 requests/);
  });
});

describe("an issue the model did not write", () => {
  it("is written from its findings, under the same numbers line — never left off the page", () => {
    const i = plainIssue({
      spec: "SOLANA",
      chain: "Solana",
      findings: [
        finding({ spec: "SOLANA", upstream: "lava", headline: "24.4% errors - mostly no reply" }),
        finding({ spec: "SOLANA", upstream: "blockdaemon", headline: "2.1% errors - mostly no reply" }),
      ],
      errorGroups: [],
      configured: [],
      insights: [],
      recovered: 135,
      failures: 3,
      requests: 23_096,
    });
    expect(i).toMatchObject({
      title: "Lava on Solana: 24.4% errors - mostly no reply",
      points: ["Blockdaemon: 2.1% errors - mostly no reply"],
      bottomLine: "",
      plain: true,
      impact: expect.stringMatching(/^3 of 23,096 requests/),
    });
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
    const f = (id: string, at: number) => ({ id, stream: "solana-mainnet-router-aa11-bb22", atUnix: at });
    const loki = (list: ReturnType<typeof f>[]) => ({
      routersWithLogs: async () => new Set(["solana-mainnet"]),
      failedRequests: async () => ({ byRouter: new Map([["solana-mainnet", list]]), capped: false }),
      countFailed: async () => new Map(),
      methodsOf: async () => new Map(),
      traceRequests: async () => new Map(),
      rejectedRequests: async () => ({ byRouter: new Map(), capped: false }),
      resentTransactions: async () => ({ checked: 0, resent: 0, mostSends: 0 }),
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

describe("a title may not contradict the numbers line", () => {
  const none: ChainOutcome = { recovered: 1_342, failures: 0, requests: 22_055, addonCalls: [], writes: null, paths: null };
  const some: ChainOutcome = { ...none, failures: 3 };

  it("flags 'requests fail' where every request got a reply", () => {
    // Written by the model in production, over "All 22,055 requests got a reply".
    expect(titleContradicts("Blockdaemon rate-limiting is causing some Solana Testnet requests to fail", none)).toBe(true);
    expect(titleContradicts("Lava is failing to answer requests on Solana", none)).toBe(true);
    // Says what the provider does — fine.
    expect(titleContradicts("Blockdaemon is refusing some requests; the router moves them to lava", none)).toBe(false);
    expect(titleContradicts("Tatum errors reach 1.8% of its answers on Tron Shasta", none)).toBe(false);
    // Where requests DID fail, saying so is the point.
    expect(titleContradicts("starknet_getEvents calls failed on both alchemy and quicknode", some)).toBe(false);
  });

  const inputs: FormulatedInputs = {
    spec: "SOLANAT",
    chain: "Solana Testnet",
    findings: [finding({ upstream: "blockdaemon", headline: "9.4% rate-limited" })],
    errorGroups: [],
    configured: [],
    insights: [],
    recovered: 1_342,
    failures: 0,
    requests: 22_055,
  };
  const model = (...titles: string[]) => {
    const complete = vi.fn();
    for (const t of titles) {
      complete.mockResolvedValueOnce({
        text: JSON.stringify({ title: t, points: ["p"], bottomLine: "b" }),
        stopReason: "end_turn",
        inputTokens: 1,
        outputTokens: 1,
      });
    }
    return { complete } as unknown as BedrockService & { complete: typeof complete };
  };

  it("asks the model once more, with the reason", async () => {
    const bedrock = model("Blockdaemon is causing some requests to fail", "Blockdaemon is refusing some requests; lava takes them");
    const issue = await new FormulatedIssueService(bedrock).formulate(inputs);
    expect(issue.title).toBe("Blockdaemon is refusing some requests; lava takes them");
    expect(bedrock.complete).toHaveBeenCalledTimes(2);
    const second = bedrock.complete.mock.calls[1]![0] as { messages: { role: string; content: string }[] };
    expect(second.messages.at(-1)?.content).toMatch(/every request got a reply/);
  });

  it("falls back to the finding's own words rather than print a contradiction", async () => {
    const bedrock = model("Requests are failing on Solana Testnet", "Some requests fail because of blockdaemon");
    const issue = await new FormulatedIssueService(bedrock).formulate(inputs);
    expect(issue.title).toBe("Blockdaemon on Solana Testnet: 9.4% rate-limited");
  });
});

describe("the card's evidence, owner and section — written by code", () => {
  const clean: ChainOutcome = { recovered: 1_342, failures: 0, requests: 22_055, addonCalls: [], writes: null, paths: null, rejected: null };
  const rateLimited = finding({ kind: "dead", tier: "attention", upstream: "blockdaemon", headline: "9.4% rate-limited" });
  const timingOut = finding({ kind: "dead", tier: "attention", upstream: "tatum", headline: "12% errors - mostly no reply" });

  it("a provider refusing over its limit, covered completely, is handled — no amber for it", () => {
    expect(isHandled([rateLimited], clean, "degraded")).toBe(true);
    // Saved requests that first waited out a timeout are not "handled".
    expect(isHandled([timingOut], clean, "degraded")).toBe(false);
    // Anything that reached the caller is not handled.
    expect(isHandled([rateLimited], { ...clean, failures: 3 }, "degraded")).toBe(false);
    // Unmeasured is not "nothing failed".
    expect(isHandled([rateLimited], { ...clean, failures: null }, "degraded")).toBe(false);
  });

  it("names who acts — never how to fix it", () => {
    expect(whoActs([rateLimited], clean, "degraded", true)).toBe("No one right now — the router is covering it.");
    expect(whoActs([timingOut], { ...clean, failures: 40 }, "degraded", false)).toBe("Tatum (the provider) — it is not answering in time.");
    expect(
      whoActs([], { ...clean, rejected: { requests: 154, byCode: {}, resent: { checked: 3, resent: 3, mostSends: 9 }, latest: [] } }, "config", false),
    ).toBe("Whoever sends these transactions — the same transaction is being sent again after it went through.");
    // The chain's own answers, passed on by the provider — not the provider's fault.
    const chainErrors = finding({ kind: "answered-error", upstream: "alchemy", codes: ["CHAIN_STARKNET_INSUFFICIENT_FEE"] });
    expect(whoActs([chainErrors], clean, "degraded", false)).toBe(
      "Whoever sends these requests — the errors come from the chain itself, not from Alchemy.",
    );
    const lava = finding({ kind: "dead", upstream: "lava", headline: "25% errors - mostly no reply" });
    expect(whoActs([timingOut, lava], { ...clean, failures: 40 }, "degraded", false)).toBe(
      "Tatum and Lava (the providers) — each is failing on this chain.",
    );
    // A primary with no finding of its own, where every failed request started failing.
    const paths = groupTraces([trace("1", "getBlock", [["tatum", "primary", "timed out"], ["lava", "backup", "no answer"]])]);
    expect(whoActs([lava], { ...clean, failures: 40, paths }, "degraded", false)).toBe(
      "Tatum and Lava (the providers) — each is failing on this chain.",
    );
  });

  it("gives each failure path the ids, error names and failing providers a support engineer needs", () => {
    const p = groupTraces([
      { ...trace("7001", "getBlock", [["tatum", "primary", "timed out"], ["lava", "backup", "no answer"]]), error: "PROTOCOL_CONTEXT_DEADLINE" },
      { ...trace("7002", "getBlock", [["tatum", "primary", "timed out"], ["lava", "backup", "no answer"]]), error: "PROTOCOL_CONTEXT_DEADLINE" },
    ]);
    expect(p?.groups[0]).toMatchObject({
      // In the order they were tried.
      failedOn: ["tatum", "lava"],
      errors: ["PROTOCOL_CONTEXT_DEADLINE"],
      ids: [{ id: "7002" }, { id: "7001" }],
    });
  });

  it("merges several chains' refusals for the caller-side card", () => {
    expect(
      mergeRefused([
        { requests: 154, byCode: { CHAIN_NONCE_TOO_LOW: 154 }, resent: { checked: 3, resent: 3, mostSends: 11 }, latest: [{ id: "1", atUnix: 5 }] },
        null,
        { requests: 20, byCode: { CHAIN_INSUFFICIENT_FUNDS: 20 }, resent: null, latest: [{ id: "2", atUnix: 9 }] },
      ]),
    ).toEqual({
      requests: 174,
      byCode: { CHAIN_NONCE_TOO_LOW: 154, CHAIN_INSUFFICIENT_FUNDS: 20 },
      resent: { checked: 3, resent: 3, mostSends: 11 },
      latest: [{ id: "2", atUnix: 9 }, { id: "1", atUnix: 5 }],
    });
  });

  it("tells the model how each provider is written, and what the chain refused", () => {
    const d = JSON.parse(
      digestForIssue({
        spec: "POLYGON",
        chain: "Polygon",
        findings: [finding({ spec: "POLYGON", upstream: "quicknode" })],
        errorGroups: [],
        configured: [{ upstream: "tatum", role: "primary", addons: [] }],
        insights: [],
        recovered: 0,
        failures: 0,
        requests: 50_000,
        rejected: { requests: 154, byCode: { CHAIN_NONCE_TOO_LOW: 154 }, resent: { checked: 3, resent: 3, mostSends: 11 }, latest: [] },
      }),
    );
    expect(d.providerNames).toEqual({ quicknode: "QuickNode", tatum: "Tatum" });
    expect(d.outcome.rejectedByTheChain).toEqual({
      requests: 154,
      byReason: { CHAIN_NONCE_TOO_LOW: 154 },
      resent: { checked: 3, sentBefore: 3, mostTimesSentBefore: 11 },
    });
  });
});

describe("a card may not claim success", () => {
  it("knows success words when it sees them", () => {
    expect(claimsSuccess("All 348 sent transactions succeeded normally.")).toBe(true);
    expect(claimsSuccess("The retry went through on lava.")).toBe(true);
    expect(claimsSuccess("Every request got a reply.")).toBe(false);
  });

  it("asks once, then drops a sentence that still claims it", async () => {
    const answer = (points: string[]) => ({
      text: JSON.stringify({ title: "Nonce errors on Polygon", points, bottomLine: "These transactions went through fine otherwise." }),
      stopReason: "end_turn",
      inputTokens: 1,
      outputTokens: 1,
    });
    const complete = vi
      .fn()
      .mockResolvedValueOnce(answer(["All 348 sent transactions succeeded.", "The chain refused the rest."]))
      .mockResolvedValueOnce(answer(["All 348 sent transactions succeeded.", "The chain refused the rest."]));
    const issue = await new FormulatedIssueService({ complete } as unknown as BedrockService).formulate({
      spec: "POLYGON",
      chain: "Polygon",
      findings: [finding({ spec: "POLYGON" })],
      errorGroups: [],
      configured: [],
      insights: [],
      recovered: 0,
      failures: 0,
      requests: 50_000,
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect((complete.mock.calls[1]![0] as { messages: { content: string }[] }).messages.at(-1)?.content).toMatch(/an error is an answer too/);
    expect(issue.points).toEqual(["The chain refused the rest."]);
    expect(issue.bottomLine).toBe("");
  });
});

describe("several chains failing at once", () => {
  const T = 1_790_000_000;
  const burst = (from: number, count = 8) => ({ count, fromUnix: from, toUnix: from + 240, lastUnix: from + 240 });
  const pathsOn = (...providers: string[]) => ({
    traced: 1,
    groups: [{ count: 1, flow: "", route: "", methods: [], seconds: [30, 30] as [number, number], failedOn: providers, ids: [], errors: [] }],
  });

  it("names the provider they all failed on", () => {
    const bursts = new Map([["SOLANA", burst(T)], ["BASE", burst(T + 60)], ["ETH1", burst(T + 120)]]);
    const paths = new Map([["SOLANA", pathsOn("tatum", "lava")], ["BASE", pathsOn("tatum")], ["ETH1", pathsOn("alchemy", "tatum")]]);
    const t = failingTogether(bursts, paths, new Map());
    expect(t).toMatchObject({ specs: ["BASE", "ETH1", "SOLANA"], provider: "tatum" });
    const issue = togetherIssue(t!, bursts, (spec) => spec, false, T + 300);
    expect(issue.title).toBe("3 chains failed at the same time — all on Tatum");
    expect(issue.whoActs).toMatch(/^Tatum \(the provider\)/);
  });

  it("points at the router when the chains share no provider", () => {
    const bursts = new Map([["SOLANA", burst(T)], ["BASE", burst(T + 30)], ["ETH1", burst(T + 90)]]);
    const configured = new Map([["SOLANA", new Set(["tatum"])], ["BASE", new Set(["alchemy"])], ["ETH1", new Set(["quicknode"])]]);
    const t = failingTogether(bursts, new Map(), configured);
    expect(t).toMatchObject({ provider: null, shareNone: true });
    const issue = togetherIssue(t!, bursts, (spec) => spec, true, T + 300);
    expect(issue).toMatchObject({ severity: "critical", title: "3 chains failed at the same time — likely the Smart Router", together: true });
    expect(issue.whoActs).toMatch(/^Magma/);
  });

  it("needs three chains, failing in the same five minutes", () => {
    expect(failingTogether(new Map([["A", burst(T)], ["B", burst(T)]]), new Map(), new Map())).toBeNull();
    // Three bursts, but an hour apart: separate problems.
    expect(failingTogether(new Map([["A", burst(T)], ["B", burst(T + 3600)], ["C", burst(T + 7200)]]), new Map(), new Map())).toBeNull();
  });
});

describe("risks — before anything fails", () => {
  const node = (name: string, addons: string[] = [], isBackup = false) => ({
    name,
    isBackup,
    endpoints: [{ urlHost: "https://x", interface: "jsonrpc", addons, index: 0, directable: true, internalPath: null }],
  });
  const router = (spec: string, nodes: ReturnType<typeof node>[]) => ({ id: spec.toLowerCase(), spec, nodes }) as never;
  const outcome = (over: Partial<ChainOutcome> = {}): ChainOutcome => ({
    recovered: 0, failures: 0, requests: 5_000, addonCalls: [], writes: null, paths: null, rejected: null, ...over,
  });

  it("finds a chain with one provider, and debug calls only one provider serves", () => {
    const risks = risksOf(
      [
        router("SOLANAD", [node("tatum")]),
        router("FTM250", [node("tatum", ["debug"]), node("lava", [], true)]),
        router("ETH1", [node("tatum", ["debug"]), node("alchemy", ["debug"])]),
      ],
      (spec) => outcome(spec === "FTM250" ? { addonCalls: [{ addon: "debug", sent: 1_102, failed: 0, errorReplies: 0 }] } : {}),
      (spec) => spec,
      new Set(),
    );
    expect(risks.map((r) => r.text)).toEqual([
      "SOLANAD has one provider, Tatum. If it stops answering, the chain stops.",
      "Only Tatum serves debug calls on FTM250. If it fails, those calls have nowhere to go.",
    ]);
  });

  it("finds transactions with one main provider — the router does not retry a write elsewhere", () => {
    const risks = risksOf(
      [router("POLYGON", [node("tatum"), node("lava", [], true)]), router("ETH1", [node("tatum"), node("alchemy")])],
      () => outcome({ writes: { sent: 348, failed: 0 } }),
      (spec) => spec,
      new Set(),
    );
    expect(risks.map((r) => [r.text, r.calls, r.unit])).toEqual([
      ["POLYGON sends transactions to one main provider, Tatum. A transaction it fails is not retried on another provider.", 348, "transactions"],
    ]);
  });

  it("leaves out a chain with an open issue, and debug calls nobody makes", () => {
    const routers = [router("SOLANAD", [node("tatum")]), router("FTM250", [node("tatum", ["debug"]), node("lava")])];
    expect(risksOf(routers, () => outcome(), (spec) => spec, new Set(["SOLANAD"]))).toEqual([]);
  });
});
