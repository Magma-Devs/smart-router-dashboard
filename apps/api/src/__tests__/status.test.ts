import { describe, expect, it } from "vitest";
import {
  buildStatusReport,
  deriveChainFindings,
  deriveInsights,
  deriveNoFailover,
  dominantUpstream,
  effectiveUpstreams,
  type StatusCell,
} from "../services/status.js";

const cell = (p: Partial<StatusCell> & { upstream: string; spec: string }): StatusCell => ({
  noAnswer: 0, badAnswer: 0, served: 0, role: null, peakRps: null,
  tipMoves: null, tip: null, scores: {}, ...p,
  errorsWas: null,
  answersWas: null,
});

describe("effectiveUpstreams", () => {
  it("reports one effective upstream when one carries everything", () => {
    // A production shape: four configured, tatum serves 100%.
    const e = effectiveUpstreams([
      cell({ upstream: "tatum", spec: "ARBITRUM", served: 1_572_348 }),
      cell({ upstream: "blockdaemon", spec: "ARBITRUM", served: 0 }),
      cell({ upstream: "lava", spec: "ARBITRUM", served: 0 }),
    ]);
    expect(e?.effective).toBeCloseTo(1, 2);
    expect(e?.top).toBe("tatum");
  });

  it("reports two when traffic is evenly split", () => {
    const e = effectiveUpstreams([
      cell({ upstream: "a", spec: "ETH1", served: 500 }),
      cell({ upstream: "b", spec: "ETH1", served: 500 }),
    ]);
    expect(e?.effective).toBeCloseTo(2, 2);
  });

  it("is null when the chain served nothing", () => {
    expect(effectiveUpstreams([cell({ upstream: "a", spec: "ETH1" })])).toBeNull();
  });
});

describe("dominantUpstream", () => {
  it("names the upstream owning nearly all the failures", () => {
    expect(
      dominantUpstream([
        cell({ upstream: "blockdaemon", spec: "SOLANAT", noAnswer: 38746 }),
        cell({ upstream: "lava", spec: "SOLANAT", noAnswer: 104 }),
      ]),
    ).toBe("blockdaemon");
  });

  it("refuses to name one when failures are shared", () => {
    // 60/40 — naming the leader sends someone at the wrong vendor.
    expect(
      dominantUpstream([
        cell({ upstream: "tatum", spec: "NEAR", noAnswer: 60 }),
        cell({ upstream: "blockdaemon", spec: "NEAR", noAnswer: 40 }),
      ]),
    ).toBeNull();
  });
});

describe("deriveChainFindings", () => {
  it("marks a died-request code critical", () => {
    const [f] = deriveChainFindings(
      { spec: "ETH1", counts: { PROTOCOL_NO_PROVIDERS: 12 } },
      [cell({ upstream: "tatum", spec: "ETH1", served: 1000 })],
      [],
    );
    expect(f?.tier).toBe("critical");
    expect(f?.remedy).toContain("reached your users as errors");
  });

  it("names the declared addon when the config promised a capability", () => {
    const f = deriveChainFindings(
      { spec: "AVALANCHECT", counts: { NODE_METHOD_NOT_FOUND: 520481 } },
      [cell({ upstream: "tatum", spec: "AVALANCHECT", badAnswer: 520481, served: 1_756_613 })],
      [{ upstream: "tatum", spec: "AVALANCHECT", addons: ["archive", "debug"] }],
    ).find((x) => x.tier === "config");

    expect(f).toBeDefined();
    expect(f?.headline).toContain("DEBUG");
    expect(f?.remedy).toContain("the config says it can");
    // The point of the row: it is nobody's fault but the config's.
    expect(f?.remedy).toContain("The config declares DEBUG here and the endpoint does not serve it");
  });

  it("names a rate limit as the reason when it explains the error share", () => {
    // 38,746 of 558,551 answers = 6.9% → over the 5% line → Critical, with
    // the rate limit as the sentence and the measured ceiling in the remedy.
    const [f] = deriveChainFindings(
      { spec: "SOLANAT", counts: { NODE_RATE_LIMITED: 38700 } },
      [cell({ upstream: "blockdaemon", spec: "SOLANAT", noAnswer: 38746, served: 519805, peakRps: 6.1 })],
      [],
    );
    expect(f?.tier).toBe("critical");
    expect(f?.headline).toBe("6.9% rate-limited");
    
    expect(f?.remedy).toContain("6.1/s");
  });

  it("one row per upstream — two failing upstreams on a chain are two rows, never merged", () => {
    // The Stellar incident: primary 502ing while the backup 429s. Each gets
    // its own row with its own share; neither suppresses the other.
    const rows = deriveChainFindings(
      { spec: "XLMT", counts: { NODE_RATE_LIMITED: 900, NODE_BAD_GATEWAY: 2100 } },
      [cell({ upstream: "tatum", spec: "XLMT", noAnswer: 2100, served: 18000, role: "primary" }),
       cell({ upstream: "blockdaemon", spec: "XLMT", noAnswer: 900, served: 4000, role: "backup" })],
      [],
    ).filter((f) => f.id.endsWith(":errors"));
    expect(rows.map((r) => r.upstream).sort()).toEqual(["blockdaemon", "tatum"]);
    // tatum 2100/20100 = 10.4% → critical; blockdaemon 900/4900 = 18.4% → critical
    expect(rows.every((r) => r.tier === "critical")).toBe(true);
  });

  it("error replies count the same as no reply — tiers on the combined share", () => {
    // Hoodi: 233,211 error replies over 2,956,621 answers = 7.9% → Critical.
    // An error reply IS an error to the user; it does not get a looser line.
    const [f] = deriveChainFindings(
      { spec: "HOD1", counts: { NODE_SERVER_ERROR: 233211 } },
      [cell({ upstream: "tatum", spec: "HOD1", badAnswer: 233211, served: 2_956_621 })],
      [],
    );
    expect(f?.tier).toBe("critical");
    expect(f?.headline).toBe("7.9% errors");
    expect(f?.metric.value).toBe("7.9%");
  });

  it("lands between 1% and 5% as Degraded, not Critical", () => {
    const [f] = deriveChainFindings(
      { spec: "NEAR", counts: { NODE_SERVER_ERROR: 8000 } },
      [cell({ upstream: "blockdaemon", spec: "NEAR", noAnswer: 8000, served: 244_000 })],
      [],
    );
    expect(f?.tier).toBe("attention");   // 3.2%
    // Evidence is one line — the errors over the answers, nothing else.
    expect(f?.evidence).toHaveLength(1);
    expect(f?.evidence[0]?.k).toBe("errors");
  });

  it("stays quiet below the event floor", () => {
    // 100% failure on three requests is not a finding.
    expect(
      deriveChainFindings(
        { spec: "BTC", counts: { NODE_RATE_LIMITED: 3 } },
        [cell({ upstream: "tatum", spec: "BTC", noAnswer: 3, served: 0 })],
        [],
      ),
    ).toEqual([]);
  });

  it("names each upstream on its own row — no chain-level blur when two share the failures", () => {
    // 4.3% and 3.7% — both Degraded, each named. The old model collapsed
    // these into one unnamed chain row; the share model never needs to.
    const rows = deriveChainFindings(
      { spec: "NEAR", counts: { NODE_RATE_LIMITED: 8045 } },
      [
        cell({ upstream: "tatum", spec: "NEAR", noAnswer: 4500, served: 100000 }),
        cell({ upstream: "blockdaemon", spec: "NEAR", noAnswer: 3500, served: 90000 }),
      ],
      [],
    ).filter((f) => f.id.endsWith(":errors"));
    expect(rows.map((r) => r.upstream).sort()).toEqual(["blockdaemon", "tatum"]);
    expect(rows.every((r) => r.tier === "attention")).toBe(true);
  });
});

describe("deriveNoFailover", () => {
  it("is a config fact only — idle or unproven backups never put a chain here", () => {
    // Three configured, backups idle: the router may simply never have
    // needed them. Not this roll-up's business (Omer, 9 Sep).
    expect(
      deriveNoFailover(
        [
          cell({ upstream: "tatum", spec: "SOLANA", served: 262519, role: "primary" }),
          cell({ upstream: "blockdaemon", spec: "SOLANA", served: 0, noAnswer: 55, role: "backup" }),
          cell({ upstream: "lava", spec: "SOLANA", served: 0, noAnswer: 50, role: "backup" }),
        ],
        { SOLANA: 3 },
      ),
    ).toEqual([]);
  });

  it("flags a single-upstream chain", () => {
    const [c] = deriveNoFailover(
      [cell({ upstream: "tatum", spec: "BSC", served: 867624, role: "primary" })],
      { BSC: 1 },
    );
    expect(c?.reason).toContain("A single provider configured");
  });

  it("leaves a genuinely balanced chain alone", () => {
    expect(
      deriveNoFailover(
        [
          cell({ upstream: "a", spec: "ETH1", served: 5000, role: "primary" }),
          cell({ upstream: "b", spec: "ETH1", served: 5000, role: "backup" }),
        ],
        { ETH1: 2 },
      ),
    ).toEqual([]);
  });
});

describe("buildStatusReport", () => {
  it("computes what the router costs and keeps clear chains out of findings", () => {
    const r = buildStatusReport({
      cells: [
        cell({ upstream: "tatum", spec: "ETH1", served: 5000, role: "primary" }),
        cell({ upstream: "lava", spec: "ETH1", served: 5000, role: "backup" }),
      ],
      kinds: [],
      declaredAddons: [],
      configuredPerChain: { ETH1: 2 },
      totals: { requestsServed: 14_347_412, attempts: 14_413_574, customerRequests: 14_347_412, failedAttempts: 47_650 },
      windowSeconds: 1800,
      emitted: true,
    });

    expect(r.totals.attemptsPerRequest).toBeCloseTo(1.005, 3);
    expect(r.totals.upstreamFailureRate).toBeCloseTo(0.0033, 4);
    expect(r.totals.chainsClear).toBe(1);
    expect(r.chains.find((c) => c.spec === "ETH1")?.state).toBe("quiet");
    expect(r.findings).toEqual([]);
  });

  it("keeps emitted:false distinct from a clean bill of health", () => {
    const r = buildStatusReport({
      cells: [], kinds: [], declaredAddons: [], configuredPerChain: {},
      totals: { requestsServed: 0, attempts: null, customerRequests: null, failedAttempts: null },
      windowSeconds: 1800,
      emitted: false,
    });
    expect(r.emitted).toBe(false);
    expect(r.totals.attemptsPerRequest).toBeNull();
  });
});

describe("caller-side blockchain errors — the 27 Aug nonce_too_low night", () => {
  it("files repeating chain rejections as Config with the sender named at fault", () => {
    // A client sent transactions with reused nonces; every provider
    // answered nonce_too_low and the page stayed green — a Slack thread and a
    // call did what this row now does.
    const [f] = deriveChainFindings(
      { spec: "ETH1", counts: { CHAIN_NONCE_TOO_LOW: 412 } },
      [cell({ upstream: "tatum", spec: "ETH1", served: 50_000 })],
      [], 1800,
    );
    expect(f?.tier).toBe("config");
    expect(f?.headline).toContain("Chain rejected 412 requests");
    expect(f?.headline).toContain("nonce too low");
    expect(f?.remedy).toContain("sender's problem");
  });

  it("stays quiet under the event floor — one odd nonce is not a finding", () => {
    const r = deriveChainFindings(
      { spec: "ETH1", counts: { CHAIN_NONCE_TOO_LOW: 2 } },
      [cell({ upstream: "tatum", spec: "ETH1", served: 50_000 })],
      [], 1800,
    );
    expect(r.filter((f) => f.headline.includes("Chain rejected"))).toHaveLength(0);
  });
});

describe("stale tip — the class no error counter can see", () => {
  it("flags an upstream serving traffic whose tip has not moved", () => {
    // The 13 Jul shape: one primary, answering everything, block frozen.
    const [f] = deriveChainFindings(
      { spec: "ETH1", counts: {} },
      [cell({ upstream: "tatum", spec: "ETH1", served: 63975, tipMoves: 0, tip: 23_400_112, role: "primary" })],
      [],
      3600,
    );

    expect(f?.kind).toBe("answered-stale");
    expect(f?.tier).toBe("critical");
    // Percent-led, like every other rule: the share of the chain's answers
    // coming from the frozen provider is the % of answers that are stale.
    expect(f?.headline).toBe("100.0% of answers from a frozen block height");
    
    // The point: zero errors, so nothing else on the page would fire - the
    // remedy says it, the evidence stays short numbers.
    expect(f?.remedy).toContain("answering from an old block");
    expect(f?.evidence.some((e) => e.k === "frozen at block")).toBe(true);
  });

  it("a frozen provider carrying under 5% of the chain is Degraded — the router is routing around it", () => {
    const [f] = deriveChainFindings(
      { spec: "ETH1", counts: {} },
      [cell({ upstream: "lava", spec: "ETH1", served: 200, tipMoves: 0, tip: 23_400_112, role: "backup" }),
       cell({ upstream: "tatum", spec: "ETH1", served: 63_775, tipMoves: 40, role: "primary" })],
      [],
      3600,
    );
    expect(f?.kind).toBe("answered-stale");
    expect(f?.tier).toBe("attention");
    expect(f?.headline).toBe("0.31% of answers from a frozen block height");
  });

  it("does not flag an idle backup whose tip is simply unpolled", () => {
    // A motionless tip on an upstream serving nothing is not the same fault.
    expect(
      deriveChainFindings(
        { spec: "ETH1", counts: {} },
        [cell({ upstream: "lava", spec: "ETH1", served: 0, tipMoves: 0, tip: 1, role: "backup" })],
        [], 3600,
      ),
    ).toEqual([]);
  });

  it("does not flag a healthy tip that is moving", () => {
    expect(
      deriveChainFindings(
        { spec: "ETH1", counts: {} },
        [cell({ upstream: "tatum", spec: "ETH1", served: 5000, tipMoves: 280, tip: 9, role: "primary" })],
        [], 3600,
      ),
    ).toEqual([]);
  });

  it("stays quiet on a slow chain whose window is shorter than one block gap", () => {
    // Bitcoin: 600s blocks. A 30-minute window cannot prove a tip is stuck.
    expect(
      deriveChainFindings(
        { spec: "BTC", counts: {} },
        [cell({ upstream: "tatum", spec: "BTC", served: 400, tipMoves: 0, tip: 900_000, role: "primary" })],
        [], 1800,
      ),
    ).toEqual([]);
  });

  it("carries the optimizer's reasoning so the finding can be adjudicated", () => {
    const [f] = deriveChainFindings(
      { spec: "ETH1", counts: {} },
      [
        cell({ upstream: "tatum", spec: "ETH1", served: 10_000, tipMoves: 0, tip: 5, role: "primary",
               scores: { sync: 1, composite: 0.98 } }),
        cell({ upstream: "lava", spec: "ETH1", served: 0, role: "backup", scores: { sync: 1, composite: 0.91 } }),
      ],
      [], 3600,
    );
    // sync 1.0 against a frozen tip: the optimizer never saw the staleness.
    expect(f?.decision.find((d) => d.upstream === "tatum")?.scores.sync).toBe(1);
    expect(f?.decision.find((d) => d.upstream === "tatum")?.sharePct).toBe(100);
  });
});

describe("error share — a chain answer is not a provider fault", () => {
  it("puts CHAIN codes on the row and points the remedy at the request, not the provider", () => {
    const [f] = deriveChainFindings(
      { spec: "STRK", counts: { CHAIN_BLOCK_NOT_FOUND: 335 } },
      [cell({ upstream: "quicknode", spec: "STRK", badAnswer: 335, served: 2123 })],
      [],
    );
    expect(f?.tier).toBe("critical"); // 15.8%
    expect(f?.codes).toContain("CHAIN_BLOCK_NOT_FOUND");
    expect(f?.remedy).toContain("real chain answers, not provider failures");
    expect(f?.remedy).not.toContain("reachable and answering with errors");
  });
});

describe("buildStatusReport — stale tip fires with zero classified errors", () => {
  it("checks chains that produced no errors at all", () => {
    // The 13 Jul incident shape at the REPORT level: frozen primary, zero
    // errors anywhere, so kinds is empty. The finding must still fire.
    const r = buildStatusReport({
      cells: [cell({ upstream: "tatum", spec: "ETH1", served: 63975, tipMoves: 0, tip: 5, role: "primary" })],
      kinds: [],
      declaredAddons: [],
      configuredPerChain: { ETH1: 1 },
      totals: { requestsServed: 63975, attempts: 63975, customerRequests: 63975, failedAttempts: 0 },
      windowSeconds: 3600,
      emitted: true,
    });
    expect(r.findings.some((f) => f.kind === "answered-stale")).toBe(true);
  });
});

describe("buildStatusReport — one fact, said once", () => {
  it("drops the per-chain SPOF insight when the no-failover roll-up already names the chain", () => {
    // tatum carries everything, lava has never served: the roll-up says "no
    // working backup" for ARBITRUM. A second row saying "tatum carried 99.5%"
    // is the same sentence again — on a one-primary-everywhere deployment it
    // printed 23 times under the roll-up.
    const cells = [
      cell({ upstream: "tatum", spec: "ARBITRUM", served: 10000, role: "primary" }),
      cell({ upstream: "lava", spec: "ARBITRUM", served: 0, noAnswer: 0, role: "backup" }),
    ];
    const r = buildStatusReport({
      cells, kinds: [], declaredAddons: [], configuredPerChain: { ARBITRUM: 2 },
      baselines: [
        { upstream: "tatum", spec: "ARBITRUM", avgMs: null, avgWasMs: null, failRateWas: null, shareDay: 0.995, unviableMin6h: null, unviableMin1h: null },
        { upstream: "lava", spec: "ARBITRUM", avgMs: null, avgWasMs: null, failRateWas: null, shareDay: 0.005, unviableMin6h: null, unviableMin1h: null },
      ],
      totals: { requestsServed: 10000, attempts: 10000, customerRequests: 10000, failedAttempts: 0 },
      windowSeconds: 1800, emitted: true,
    });
    // Concentration is never a finding, and since the roll-up became a pure
    // config fact (one upstream configured — Omer, 9 Sep) a two-provider
    // chain is not in it either. The per-chain SPOF insight stays suppressed
    // for concentrated chains all the same — it is by-design truth on a
    // one-primary fleet, and twenty copies of it bury everything else.
    expect(r.findings.filter((f) => f.kind === "no-backup")).toHaveLength(0);
    expect(r.noFailover).toEqual([]);
    expect(r.insights.filter((i) => i.kind === "de-facto-spof")).toHaveLength(0);
  });
});

describe("deriveInsights — thresholds with their arithmetic attached", () => {
  const B = (p) => ({ upstream: p.upstream, spec: p.spec, avgMs: null, avgWasMs: null,
    failRateWas: null, shareDay: null, unviableMin6h: null, unviableMin1h: null, ...p });

  it("flags a de-facto SPOF at 95% weekly share", () => {
    const [i] = deriveInsights(
      [cell({ upstream: "tatum", spec: "ARBITRUM", served: 1000, role: "primary" }),
       cell({ upstream: "lava", spec: "ARBITRUM", served: 10, role: "backup" })],
      [B({ upstream: "tatum", spec: "ARBITRUM", shareDay: 0.995 }),
       B({ upstream: "lava", spec: "ARBITRUM", shareDay: 0.005 })],
      [], { ARBITRUM: 4 },
    );
    expect(i?.kind).toBe("de-facto-spof");
    expect(i?.basis).toContain("served almost nothing");
  });

  it("judges a backup by budget burn, not wall clock", () => {
    const [i] = deriveInsights(
      [cell({ upstream: "lava", spec: "SOLANA", served: 5, role: "backup" })],
      [B({ upstream: "lava", spec: "SOLANA", unviableMin1h: 12, unviableMin6h: 30 })],
      [], { SOLANA: 3 },
    );
    expect(i?.kind).toBe("backup-unreliable");
    // the basis must carry the arithmetic — 99% per leg, burn-rate marks
    expect(i?.basis).toContain("1% of the time");
    expect(i?.basis).toContain("allowance");
  });

  it("compares a provider only to itself for latency", () => {
    const [i] = deriveInsights(
      [cell({ upstream: "tatum", spec: "ETH1", served: 5000, role: "primary" })],
      [B({ upstream: "tatum", spec: "ETH1", avgMs: 900, avgWasMs: 300 })],
      [], { ETH1: 2 },
    );
    expect(i?.kind).toBe("slower-than-history");
    expect(i?.headline).toContain("3.0x");
  });

  it("does not flag a fast doubling under the 200ms floor", () => {
    expect(deriveInsights(
      [cell({ upstream: "tatum", spec: "ETH1", served: 5000 })],
      [B({ upstream: "tatum", spec: "ETH1", avgMs: 7, avgWasMs: 3 })],
      [], { ETH1: 2 },
    )).toEqual([]);
  });

  it("catches a failure rate creeping under the alarm line", () => {
    const [i] = deriveInsights(
      [cell({ upstream: "tatum", spec: "ETH1", served: 99200, noAnswer: 800 })],
      [B({ upstream: "tatum", spec: "ETH1", failRateWas: 0.001 })],
      [], { ETH1: 2 },
    );
    expect(i?.kind).toBe("creeping-failures");
    expect(i?.basis).toContain("still under that line");
  });

  it("flags retries running as a crutch against the chain's own median", () => {
    const [i] = deriveInsights(
      [cell({ upstream: "tatum", spec: "ETH1", served: 1000 })],
      [],
      [{ spec: "ETH1", clientRequests: 10000, slowAnswers: 0, slowShareWas: null,
         attempts: 13000, attemptsPerReqWas: 1.02 }],
      { ETH1: 2 },
    );
    expect(i?.kind).toBe("retries-crutch");
    expect(i?.value).toContain("1.30");
  });
});

describe("answered-late — the slow-success finding", () => {
  it("fires critical when 2.5% of answers take 10s+", () => {
    const [f] = deriveChainFindings(
      { spec: "POLYGON", counts: {} },
      [cell({ upstream: "tatum", spec: "POLYGON", served: 10000 })],
      [], 3600,
      { spec: "POLYGON", clientRequests: 10000, slowAnswers: 250, slowShareWas: 0.001,
        attempts: 10100, attemptsPerReqWas: null },
    );
    expect(f?.kind).toBe("answered-late");
    expect(f?.tier).toBe("critical");
    expect(f?.tier).toBe("critical");
  });

  it("fires attention on a 3x regression against last week", () => {
    const [f] = deriveChainFindings(
      { spec: "POLYGON", counts: {} },
      [cell({ upstream: "tatum", spec: "POLYGON", served: 10000 })],
      [], 3600,
      { spec: "POLYGON", clientRequests: 10000, slowAnswers: 80, slowShareWas: 0.002,
        attempts: 10100, attemptsPerReqWas: null },
    );
    expect(f?.tier).toBe("attention");
    expect(f?.headline).toContain("4.0x");
  });

  it("stays quiet at a normal tail", () => {
    expect(deriveChainFindings(
      { spec: "POLYGON", counts: {} },
      [cell({ upstream: "tatum", spec: "POLYGON", served: 10000 })],
      [], 3600,
      { spec: "POLYGON", clientRequests: 10000, slowAnswers: 20, slowShareWas: 0.002,
        attempts: 10100, attemptsPerReqWas: null },
    )).toEqual([]);
  });
});

describe("verification — did anything check the answers, and who failed", () => {
  const V = (p) => ({ spec: "ETH1", consistencyChecks: null, consistencyCaught: 0, xvalRounds: null, xvalFailedByReason: {}, byProvider: [], ...p });
  const served = [cell({ upstream: "tatum", spec: "ETH1", served: 5000, role: "primary" })];

  it("flags a chain where nothing verified the answers", () => {
    // A common production state: consistency family present but zero checks on the
    // chain, cross-validation family never registered. A frozen upstream is
    // invisible by construction — that is the class behind every 7-10h RCA.
    const [f] = deriveChainFindings({ spec: "ETH1", counts: {} }, served, [], 1800, undefined,
      V({ consistencyChecks: 0, xvalRounds: null }));
    expect(f?.kind).toBe("answered-unchecked");
    expect(f?.tier).toBe("attention");
    expect(f?.evidence.find((e) => e.k === "cross-validation")?.v).toContain("never registered");
    expect(f?.remedy).toContain("No check verifies the answers");
  });

  it("stays quiet on a low-traffic chain — nothing to judge", () => {
    expect(deriveChainFindings({ spec: "ETH1", counts: {} },
      [cell({ upstream: "tatum", spec: "ETH1", served: 40 })], [], 1800, undefined,
      V({ consistencyChecks: 0 }))).toEqual([]);
  });

  it("reports stale answers the check CAUGHT, with the checked-reads base", () => {
    const [f] = deriveChainFindings({ spec: "ETH1", counts: {} }, served, [], 1800, undefined,
      V({ consistencyChecks: 16642, consistencyCaught: 6 }));
    expect(f?.kind).toBe("answered-stale");
    expect(f?.headline).toContain("6 stale answers caught");
    expect(f?.evidence.find((e) => e.k === "caught")?.v).toContain("of 16,642 checked reads");
  });

  it("files a structural cross-validation failure as Config, not as a provider fault", () => {
    // The policy asks for more providers than the chain has — every validated
    // request fails before any answer is compared. Nobody's node is wrong.
    const [f] = deriveChainFindings({ spec: "ETH1", counts: {} }, served, [], 1800, undefined,
      V({ xvalRounds: 1000, xvalFailedByReason: { "insufficient-capacity": 900 } }));
    expect(f?.tier).toBe("config");
    expect(f?.headline).toContain("Cross-validation can't run");
    expect(f?.remedy).toContain("need more providers than this chain has");
  });

  it("does NOT file genuine disagreement as a finding — it is an Insight over the week", () => {
    // A provider disagreeing with its peers is a reliability trend, not an
    // incident this window. The per-provider row in Insights is the only place
    // it appears, read over 7 days.
    const fs = deriveChainFindings({ spec: "ETH1", counts: {} }, served, [], 1800, undefined,
      V({ xvalRounds: 1000, xvalFailedByReason: { "no-agreement": 40 } }));
    expect(fs.find((f) => f.headline.includes("disagreed"))).toBeUndefined();
  });

  it("names the provider whose answers do not match its peers — no attribution bound needed", () => {
    const [i] = deriveInsights(
      [cell({ upstream: "tatum", spec: "ETH1", served: 1000, role: "primary" }),
       cell({ upstream: "blockdaemon", spec: "ETH1", served: 1000, role: "backup" })],
      [], [], { ETH1: 2 },
      [V({ byProvider: [
        { upstream: "blockdaemon", disagreed: 60, agreed: 140 },
        { upstream: "tatum", disagreed: 2, agreed: 198 },
      ] })],
    );
    expect(i?.kind).toBe("disagrees-with-peers");
    expect(i?.upstream).toBe("blockdaemon");
    expect(i?.tier).toBe("attention");           // 30% ≥ 20%
    expect(i?.value).toBe("30.0%");
    // the counter carries provider_address — the basis says so
    expect(i?.basis).toContain("different from the others");
    expect(i?.headline).toContain("this week");
  });

  it("does not name a provider on a handful of disagreements", () => {
    // 3 of 20 is 15% but below the 5-event floor AND the 20-check floor: noise.
    expect(deriveInsights(
      [cell({ upstream: "tatum", spec: "ETH1", served: 1000 })], [], [], { ETH1: 1 },
      [V({ byProvider: [{ upstream: "tatum", disagreed: 3, agreed: 15 }] })],
    )).toEqual([]);
  });
});

describe("chain down — every upstream failing, from relay counters not the health gauge", () => {
  it("fires when every attempted upstream served nothing", () => {
    // Solana testnet, Mar 2026: blockdaemon 405 on every relay, quicknode 429 on every relay.
    const [f] = deriveChainFindings(
      { spec: "SOLANAT", counts: { NODE_METHOD_NOT_ALLOWED: 1900, NODE_RATE_LIMITED: 1600 } },
      [cell({ upstream: "blockdaemon", spec: "SOLANAT", served: 0, noAnswer: 1910 }),
       cell({ upstream: "quicknode", spec: "SOLANAT", served: 4, noAnswer: 1580 })],
      [],
    );
    expect(f?.tier).toBe("critical");
    expect(f?.headline).toContain("Chain down");
    expect(f?.headline).toContain("blockdaemon, quicknode");
    expect(f?.evidence.some((e) => e.k === "configured")).toBe(true);
  });

  it("does NOT fire when one upstream is fine — that is Degraded, not down", () => {
    const kinds = deriveChainFindings(
      { spec: "SOLANAT", counts: {} },
      [cell({ upstream: "blockdaemon", spec: "SOLANAT", served: 0, noAnswer: 1910 }),
       cell({ upstream: "tatum", spec: "SOLANAT", served: 50000, noAnswer: 12 })],
      [],
    ).map((x) => x.headline);
    expect(kinds.some((h) => h.includes("Chain down"))).toBe(false);
  });

  it("does NOT fire on a configured-but-idle upstream — not attempted is not failing", () => {
    // A backup that was never asked has served 0 and failed 0: it is silent, not down.
    const kinds = deriveChainFindings(
      { spec: "ETH1", counts: {} },
      [cell({ upstream: "tatum", spec: "ETH1", served: 0, noAnswer: 400 }),
       cell({ upstream: "lava", spec: "ETH1", served: 0, noAnswer: 0 })],
      [],
    ).map((x) => x.headline);
    expect(kinds.some((h) => h.includes("Chain down"))).toBe(false);
  });
});
