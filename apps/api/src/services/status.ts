/**
 * The Status page's one read: is this deployment healthy, and if not, what
 * exactly is wrong and what should be done about it.
 *
 * This is the only service in the API that draws CONCLUSIONS rather than
 * reporting measurements, so it lives alone and is tested alone.
 *
 * Three rules shape everything here:
 *
 * 1. **Rate, never count.** A chain serving 542 requests and one serving 11
 *    million cannot be ranked by how many errors they produced. Every threshold
 *    is proportional, with a floor so a quiet chain cannot hit 100% on three
 *    requests and take the top of the page.
 *
 * 2. **Two independent failure counts per upstream.** "No answer" (the relay
 *    failed) and "bad answer" (it replied, with an error) are different
 *    problems with different remedies, and the gap between them can be enormous
 *    - in production one upstream showed 520k bad answers against zero failed relays.
 *    A single error rate reports that upstream as perfect.
 *
 * 3. **Never invent an owner.** Error KINDS are recorded per chain
 *    (`smartrouter_errors_total` carries `chain_id`, no upstream label) while
 *    failure COUNTS are per upstream. Naming an upstream for a kind is a join
 *    across the two, so it is allowed only when one upstream owns nearly all of
 *    the chain's failures; otherwise the finding still ships, worded at chain
 *    level.
 */
import {
  errorMeaning,
  buildChainMetaByIndex,
  type FindingKind,
  type StatusInsight,
  type NoFailoverChain,
  type StatusFinding,
  type StatusReport,
  type StatusTier,
} from "@sr/shared";

/* ── Thresholds ───────────────────────────────────────────────────────────
   ONE number, read two ways.

   The number: errors as a share of all answers. Never a count - 200 errors is
   20% on a chain doing a thousand requests and 0.02% on one doing a million,
   and only the share means the same thing everywhere.

   Two lines, the same on every chain and every provider:
     1%  → Degraded  - the router is covering for it
     5%  → Critical  - your users are hitting errors faster than
                       the router can hide them
   Both are choices, not physics. They ship with their reason on the page and
   are meant to be moved by the operator.

   Two windows, because one is always wrong: a short one catches an incident
   happening now without firing on a 30-second blip; a long one catches a
   provider that was bad for an hour overnight and is quiet this minute.
     15 min → Critical at 5%, Degraded at 1%
     24 h   → Degraded at 1%

   One floor: under 300 answers in the window, 1% is two or three requests and
   any percentage is a coin flip - say "not enough traffic to judge". */

/** Errors ÷ answers. One in a hundred: the provider is not reliable. */
const DEGRADED_RATE = 0.01;
/** One in twenty: your users feel this. */
const CRITICAL_RATE = 0.05;
/** Below this many answers a percentage is noise, whatever it says. */
const MIN_ANSWERS = 300;
/** And at least this many actual errors, so a 1-in-300 blip is not a row. */
const MIN_EVENTS = 5;
const minRequestsFor = (threshold: number) => Math.max(MIN_ANSWERS, Math.ceil(3 / threshold));
/** Kept for the call sites that still name it; equal to the model. */
const NO_ANSWER_RATE = DEGRADED_RATE;
/** Share of a chain's failures one upstream must own before it may be named. */
const ATTRIBUTION = 0.8;
/** Effective-upstream count at or below which a chain has no real failover. */
const NO_FAILOVER_EFFECTIVE = 1.25;

/**
 * Expected seconds between blocks, per chain - a STATIC table, on purpose.
 *
 * The staleness check cannot take its reference rate from the block gauges
 * themselves: a chain whose only upstream is frozen produces a measured rate of
 * zero, and any check derived from that concludes blocks were not expected to
 * move and passes the frozen node. That is precisely how a stuck primary went
 * undetected for ten hours. A published block time is the independent second
 * opinion the metrics cannot supply.
 */
const BLOCK_SECONDS: Record<string, number> = {
  ETH1: 12, HOL1: 12, HOD1: 12, ARBITRUM: 0.25, BASE: 2, OPTM: 2,
  POLYGON: 2, POLYGONA: 2, BSC: 3, AVALANCHEC: 2, AVALANCHECT: 2, AVALANCHEP: 2,
  SOLANA: 0.4, SOLANAT: 0.4, NEAR: 1, NEART: 1, APT1: 0.25,
  BTC: 600, BTCT: 600, BCH: 600, BCHT: 600,
  XRP: 4, XRPT: 4, XLM: 5, XLMT: 5, TRX: 3, TRXT: 3,
  TEZOS: 15, STRK: 30, IOTA: 5, IOTAT: 5, FTM250: 1,
  POLKADOTASSETHUB: 12, HYPERLIQUID: 2, COSMOSHUB: 6,
};

/** How many expected block-times a tip may stand still before it is stale. */
const STALE_BLOCK_MULTIPLE = 40;
/** A tip must stand still at least this long regardless, so fast chains do not
 *  fire on a momentary gap. */
const STALE_FLOOR_SEC = 120;

/** Error names that mean the request DIED - the router ran out of options. */
/** Codes where the CHAIN correctly rejected a caller's request - transport
 *  successes, no provider at fault. `USER_*` is caller-side by definition. */
const CALLER_CODES = new Set(["CHAIN_NONCE_TOO_LOW", "CHAIN_INSUFFICIENT_FUNDS", "CHAIN_NONCE_TOO_HIGH"]);
// The chain's reason, never a verdict on who is at fault. Measured in
// production, the refused transactions checked had all been sent before —
// the same transaction again — which is not "the sender reuses nonces".
const CALLER_CODE_WORDS: Record<string, string> = {
  CHAIN_NONCE_TOO_LOW: "nonce already used: that transaction, or another from the same account, already went through",
  CHAIN_NONCE_TOO_HIGH: "nonce too far ahead: an earlier one from the same account has not gone through",
  CHAIN_INSUFFICIENT_FUNDS: "not enough funds on the sending account",
  USER_INVALID_PARAMS: "malformed request parameters",
};

const FATAL_CODES = new Set([
  "PROTOCOL_NO_PROVIDERS",
  "PROTOCOL_ALL_ENDPOINTS_DISABLED",
  "PROTOCOL_INSUFFICIENT_PROVIDERS",
]);

/** Error names that mean the deployment is asking for something unavailable. */
const CONFIG_CODES = new Set([
  "NODE_METHOD_NOT_FOUND",
  "NODE_METHOD_NOT_SUPPORTED",
  "NODE_METHOD_NOT_ALLOWED",
  "NODE_UNIMPLEMENTED",
  "NODE_ENDPOINT_NOT_FOUND",
  "NODE_UNAUTHORIZED",
  "PROTOCOL_TLS_MISMATCH",
]);

/** Per-(upstream × chain) counts, as the metrics layer assembles them. */
export interface StatusCell {
  upstream: string;
  spec: string;
  /** Relays that never got an answer. */
  noAnswer: number;
  /** Answers that came back and were errors. */
  badAnswer: number;
  /** Relays served - the denominator. */
  served: number;
  role: "primary" | "backup" | null;
  /** Peak served rate over the window, req/s. Null when unmeasured. */
  peakRps: number | null;
  /** How many times this upstream's block tip moved over the window. */
  tipMoves: number | null;
  /** Its current tip. */
  tip: number | null;
  /** score_type → score, the optimizer's own reasoning. */
  scores: Partial<Record<string, number>>;
  /** Same window ONE WEEK earlier - the row's "was" reference. One rule for
   *  every page window: a 30m view compares to that 30m last week, a 7d view
   *  to the week before. Null when the week-ago read failed or had no data. */
  errorsWas: number | null;
  answersWas: number | null;
}

/** One chain's classified error kinds (`error_name` → count). */
export interface ChainKinds {
  spec: string;
  counts: Record<string, number>;
}

/** Per-chain client-scoped stats for the window (latency histogram side). */
export interface ChainWindowStats {
  spec: string;
  /** Client requests (latency-histogram _count increase). */
  clientRequests: number;
  /** Client answers that took >= 10s - the histogram's own ceiling. */
  slowAnswers: number;
  /** Slow share in the same window 7 days ago; null when no history. */
  slowShareWas: number | null;
  /** Relay attempts on the chain (requests_total increase). */
  attempts: number;
  /** attempts/clientRequests in the same window one week earlier (null when that window carried <100 requests). */
  attemptsPerReqWas: number | null;
}

/**
 * Per-upstream history baselines (offset queries). Every "was" is the SAME
 * window one week earlier - one read each, never a week-long subquery: on a
 * real deployment (tens of thousands of series per family) a `[7d:1h]`
 * median or a per-endpoint p95 over buckets cannot finish inside an ingress
 * timeout, and a baseline that never arrives is a baseline the page never has.
 */
export interface UpstreamBaseline {
  upstream: string;
  spec: string;
  /** Mean answer time this window (latency sum ÷ count). */
  avgMs: number | null;
  /** Mean answer time in the same window one week earlier. */
  avgWasMs: number | null;
  /** Failure rate in the same window 7 days ago. */
  failRateWas: number | null;
  /** Share of the chain's relays over the trailing day. */
  shareDay: number | null;
  /** Minutes (of the last 6h / 1h) this upstream spent unviable -
   *  >=50% of received relays errored. "At least" figures: the health gauge
   *  resets hourly, so these come from relay errors, not outage intervals. */
  unviableMin6h: number | null;
  unviableMin1h: number | null;
}

/**
 * What, if anything, checked the answers on a chain - and who failed the check.
 *
 * Two families, two meanings, never merged (MAG-2527 conflated them and
 * deleted the wrong strip):
 * - consistency: a read enforced a minimum seen block. Present in production.
 * - cross-validation: several providers answered the same question and were
 *   compared. Lazily registered; absent in production as of 2026-08-18.
 */
export interface ChainVerification {
  spec: string;
  /** Reads that enforced a minimum seen block; null when the family is absent. */
  consistencyChecks: number | null;
  /** Those that FAILED - a stale answer caught before it was served. */
  consistencyCaught: number;
  /** Cross-validation rounds; null when the family has never registered. */
  xvalRounds: number | null;
  /** Rounds that failed, by reason (bounded enum). */
  xvalFailedByReason: Record<string, number>;
  /** Per provider: times its answer was the odd one out vs. times it agreed. */
  byProvider: { upstream: string; disagreed: number; agreed: number }[];
}

/** Measured first/last observation of a finding's driving signal. */
export interface FindingTiming {
  /** `${spec}:dead` or `${spec}:${upstream}:stale`. */
  key: string;
  firstSeenUnix: number | null;
  lastSeenUnix: number | null;
  ongoing: boolean | null;
}

export interface StatusInput {
  cells: StatusCell[];
  verification?: ChainVerification[];
  chainStats?: ChainWindowStats[];
  baselines?: UpstreamBaseline[];
  timings?: FindingTiming[];
  lastCritical24h?: { spec: string; atUnix: number } | null;
  worstMover?: { spec: string; metric: string; now: string; was: string } | null;
  priorTotals?: {
    requestsServed: number | null;
    attemptsPerRequest: number | null;
    upstreamFailureRate: number | null;
  };
  kinds: ChainKinds[];
  /** Addons the config DECLARES per (upstream × chain), lower-cased. */
  declaredAddons: { upstream: string; spec: string; addons: string[] }[];
  /** How many upstreams the config lists per chain. */
  configuredPerChain: Record<string, number>;
  totals: {
    requestsServed: number;
    attempts: number | null;
    customerRequests: number | null;
    failedAttempts: number | null;
  };
  /** Window length in seconds - the staleness check needs a real duration. */
  windowSeconds: number;
  emitted: boolean;
}

const pct = (n: number) => `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;
const num = (n: number) => Math.round(n).toLocaleString("en-US");

/** The upstream owning a chain's failures, when one clearly does. */
export function dominantUpstream(cells: StatusCell[]): string | null {
  const total = cells.reduce((s, c) => s + c.noAnswer + c.badAnswer, 0);
  if (total <= 0) return null;
  const by = new Map<string, number>();
  for (const c of cells) {
    by.set(c.upstream, (by.get(c.upstream) ?? 0) + c.noAnswer + c.badAnswer);
  }
  const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] / total >= ATTRIBUTION ? top[0] : null;
}

/**
 * Effective upstreams - `1 / Σ(share²)` over a chain's served traffic.
 *
 * Answers "how many upstreams do you actually have", which the configured
 * count cannot: in production, Arbitrum lists four and one serves 100.0%. Returns null
 * when the chain served nothing.
 */
export function effectiveUpstreams(
  cells: StatusCell[],
): { effective: number; top: string | null; topShare: number | null } | null {
  const total = cells.reduce((s, c) => s + c.served, 0);
  if (total <= 0) return null;
  const hhi = cells.reduce((s, c) => s + (c.served / total) ** 2, 0);
  const top = [...cells].sort((a, b) => b.served - a.served)[0];
  return {
    effective: hhi > 0 ? 1 / hhi : 1,
    top: top?.upstream ?? null,
    topShare: top ? top.served / total : null,
  };
}

/** Every finding for one chain, most severe first. */
export function deriveChainFindings(
  chain: ChainKinds,
  allCells: StatusCell[],
  declared: StatusInput["declaredAddons"],
  windowSeconds = 1800,
  stats?: ChainWindowStats,
  verif?: ChainVerification,
): StatusFinding[] {
  const cells = allCells.filter((c) => c.spec === chain.spec);
  if (cells.length === 0) return [];

  const meta = buildChainMetaByIndex(chain.spec);
  const owner = dominantUpstream(cells);
  const scope = owner ? cells.filter((c) => c.upstream === owner) : cells;
  const role = owner ? (scope[0]?.role ?? null) : null;
  const out: StatusFinding[] = [];

  const peak = scope.reduce<number | null>(
    (m, c) => (c.peakRps == null ? m : Math.max(m ?? 0, c.peakRps)),
    null,
  );

  /** Every upstream on this chain with its scores and share - the adjudicator. */
  const totalServed = cells.reduce((sum, c) => sum + c.served, 0);
  const decision = cells
    .map((c) => ({
      upstream: c.upstream,
      sharePct: totalServed > 0 ? Math.round((c.served / totalServed) * 1000) / 10 : null,
      scores: c.scores,
    }))
    .sort((a, b) => (b.sharePct ?? 0) - (a.sharePct ?? 0));

  const push = (
    tier: StatusTier,
    kind: FindingKind,
    headline: string,
    metric: { value: string; label: string },
    codes: string[],
    evidence: { k: string; v: string }[],
    remedy: string,
    sinceSec: number | null = null,
    reference: string | null = null,
  ) =>
    out.push({
      codeCounts: Object.fromEntries(codes.filter((k) => chain.counts[k] != null).map((k) => [k, chain.counts[k] ?? 0])),
      reference: reference ?? undefined,
      tier,
      kind,
      sinceSec,
      firstSeenUnix: null,
      lastSeenUnix: null,
      ongoing: null,
      decision,
      id: `${chain.spec}:${owner ?? "chain"}:${kind}`,
      spec: chain.spec,
      chainName: meta.name,
      upstream: owner,
      role,
      headline,
      metric,
      codes,
      evidence,
      remedy,
    });

  /* ── Answered, but the tip is frozen ────────────────────────────────────
     The class no error counter can see. Checked FIRST because it is the one
     that has repeatedly cost 7-10 hours, and because a stale upstream carrying
     traffic outranks anything that merely failed loudly. */
  const expectedBlockSec = BLOCK_SECONDS[chain.spec];
  if (expectedBlockSec != null) {
    const windowSec = windowSeconds;
    const staleAfter = Math.max(expectedBlockSec * STALE_BLOCK_MULTIPLE, STALE_FLOOR_SEC);
    for (const c of cells) {
      // Only upstreams actually carrying traffic. A backup sitting idle has a
      // motionless tip because nothing polls it, which is not the same fault.
      if (c.tipMoves == null || c.served <= 0) continue;
      if (c.tipMoves > 0) continue;
      if (windowSec < staleAfter) continue;

      const share = totalServed > 0 ? c.served / totalServed : null;
      // Tiered on the share of the chain's answers coming from the frozen
      // provider - the % of what the users are being told that is stale.
      // Same line as the error rule: over 5% affected is Critical; under it
      // the router is routing around the freeze and it is Degraded.
      const staleCritical = share == null || share >= CRITICAL_RATE;
      out.push({
        tier: staleCritical ? "critical" : "attention",
        kind: "answered-stale",
        sinceSec: windowSec,
        firstSeenUnix: null,
        lastSeenUnix: null,
        ongoing: null,
        decision,
        id: `${chain.spec}:${c.upstream}:answered-stale`,
        spec: chain.spec,
        chainName: meta.name,
        upstream: c.upstream,
        role: c.role,
        headline: share == null
          ? "Answering from a frozen block height"
          : `${pct(share)} of answers from a frozen block height`,
        reference: "critical over 5% of answers",
        metric: {
          value: share == null ? "-" : pct(share),
          label: "of traffic",
        },
        codes: [],
        // Short values only - the evidence block sits right-aligned, and a
        // sentence there reads ragged. The prose belongs in the remedy.
        evidence: [
          { k: "frozen at block", v: c.tip == null ? "unknown" : num(c.tip) },
          { k: "for at least", v: `${Math.round(windowSec / 60)} min` },
          { k: "still serving", v: `${num(c.served)} relays` },
        ],
        remedy:
          `**${c.upstream} is answering from an old block.** Answers look successful, but the data is old.`,
      });
    }
  }

  /* ── Critical: every upstream on the chain is failing ─────────────────
     Computed from the relay counters, NOT the health gauge (which resets to
     healthy hourly). Chain down = every configured upstream was attempted in
     the window and none served. One upstream failing is Degraded; all of them
     is a different thing - it is the one your users feel hardest. */
  {
    const attempted = cells.filter((c) => c.served + c.noAnswer > 0);
    const allFailing =
      attempted.length >= 1 &&
      attempted.length === cells.length &&
      attempted.every((c) => c.served === 0 || c.noAnswer / (c.served + c.noAnswer) >= 0.95);
    const totalAttempts = attempted.reduce((s, c) => s + c.served + c.noAnswer, 0);
    if (allFailing && totalAttempts >= MIN_EVENTS * 4) {
      const names = attempted.map((c) => c.upstream).join(", ");
      const perUp = attempted.map((c) => {
        const a = c.served + c.noAnswer;
        return { k: c.upstream, v: `${num(c.noAnswer)} of ${num(a)} relays failed - ${pct(c.noAnswer / a)}` };
      });
      out.push({
        tier: "critical",
        kind: "dead",
        sinceSec: null,
        firstSeenUnix: null,
        lastSeenUnix: null,
        ongoing: null,
        decision,
        id: `${chain.spec}:chain:down`,
        spec: chain.spec,
        chainName: meta.name,
        upstream: null,
        role: null,
        headline: `Chain down - every provider failing (${names})`,
        metric: { value: num(attempted.reduce((s, c) => s + c.served, 0)), label: "served" },
        codes: Object.keys(chain.counts).filter((k) => k.startsWith("NODE_") || k.startsWith("PROTOCOL_")).slice(0, 4),
        evidence: [
          ...perUp,
          { k: "configured", v: String(cells.length) },
        ],
        remedy:
          "**Nothing is left to route to.** Different reasons need separate fixes; one shared reason points at the chain or your credentials.",
      });
    }
  }

  /* ── Critical: the request died ─────────────────────────────────────── */
  const fatal = Object.entries(chain.counts).filter(([k]) => FATAL_CODES.has(k));
  const fatalTotal = fatal.reduce((s, [, v]) => s + v, 0);
  if (fatalTotal > 0) {
    push(
      "critical",
      "dead",
      `${num(fatalTotal)} requests failed - no provider could answer`,
      { value: num(fatalTotal), label: "requests failed" },
      fatal.map(([k]) => k),
      [
        { k: "failed", v: `${num(fatalTotal)} requests` },
        { k: "providers on this chain", v: String(cells.length) },
      ],
      "**These reached your users as errors** - every provider was tried and none answered.",
    );
  }

  /* ── Config: a declared capability that is not honoured ─────────────── */
  const methodMissing = Object.entries(chain.counts)
    .filter(([k]) => CONFIG_CODES.has(k))
    .reduce((s, [, v]) => s + v, 0);
  if (methodMissing >= MIN_EVENTS) {
    // The sharpest form: the config PROMISES an addon the endpoint rejects.
    // Then the router is not guessing - it routed there because it was told to.
    const promised = declared.find(
      (d) =>
        d.spec === chain.spec &&
        (owner ? d.upstream === owner : true) &&
        d.addons.some((a) => a !== "archive"),
    );
    const addon = promised?.addons.find((a) => a !== "archive");
    push(
      "config",
      "config",
      addon
        ? `Unsupported add-on - ${addon.toUpperCase()} declared, not served`
        : `Unsupported method - ${num(methodMissing)} calls rejected`,
      { value: num(methodMissing), label: "rejected" },
      Object.keys(chain.counts).filter((k) => CONFIG_CODES.has(k)),
      [
        { k: "rejected", v: num(methodMissing) },
        ...(addon ? [{ k: "config declares", v: addon.toUpperCase() }] : []),
      ],
      addon
        ? `**The config declares ${addon.toUpperCase()} here and the endpoint does not serve it** - the router keeps routing ${addon} traffic there because the config says it can.`
        : "**A caller or plan mismatch, not a provider fault** - the method is being rejected as unknown on this chain.",
    );
  }

  /* ── The chain said no - and the caller is the reason ─────────────────
     In one production incident a client's transactions all came back
     nonce_too_low from every provider, and it took a Slack thread and a call
     to establish "this is a blockchain error, the issue is on the
     customer's end". These answers are transport SUCCESSES - no provider is
     at fault and no failover helps - so without this row the page stays
     green while the customer's own pipeline is broken. */
  // One finding PER code (Omer, 9 Sep): nonce handling, account funding and
  // malformed requests are different problems for different people - summing
  // them into one alert hides which one is happening.
  for (const code of Object.keys(chain.counts).filter((k) => CALLER_CODES.has(k) || k.startsWith("USER_"))) {
    const count = chain.counts[code] ?? 0;
    if (count < MIN_EVENTS) continue;
    const word = CALLER_CODE_WORDS[code] ?? code.replace(/^(CHAIN_|USER_)/, "").toLowerCase().replace(/_/g, " ");
    out.push({
      tier: "config",
      kind: "config",
      id: `${chain.spec}:caller:${code}`,
      spec: chain.spec,
      chainName: meta.name,
      upstream: null,
      role: null,
      // Counted per provider REPLY: a transaction goes to every primary, and
      // each one's refusal counts — so this is refusals, not requests. The
      // issue card counts requests from the router's log.
      headline: `${num(count)} refusals from the chain — ${word.split(":")[0]}`,
      metric: { value: num(count), label: "refusals, one per provider reply" },
      codes: [code],
      codeCounts: { [code]: count },
      evidence: [{ k: "who refused", v: "the chain itself — every provider gave the same answer" }],
      remedy: `**The chain refused these, not a provider.** ${errorMeaning(code)}.`,
      sinceSec: null, firstSeenUnix: null, lastSeenUnix: null, ongoing: null,
      decision,
    });
  }

  /* ── The error share - one row per upstream, one number ──────────────
     errors = no answer + error answer. To the user they are the same thing:
     they asked and did not get a good reply. Tiered on the share, with the
     reason (rate-limit, 5xx, timeout…) as the code on the row, not as a
     separate finding. */
  for (const c of cells) {
    const answers = c.served + c.noAnswer;
    const errors = c.noAnswer + c.badAnswer - (c.upstream === owner ? methodMissing : 0);
    if (answers < MIN_ANSWERS || errors < MIN_EVENTS) continue;
    const share = Math.max(0, errors) / answers;
    if (share < DEGRADED_RATE) continue;
    const critical = share >= CRITICAL_RATE;
    // Which kind dominates decides the sentence and the remedy.
    const rl = chain.counts.NODE_RATE_LIMITED ?? 0;
    const dominantIsRateLimit = c.upstream === owner && rl >= errors * 0.9;
    const mostlyNoAnswer = c.noAnswer >= c.badAnswer;
    const codes = Object.keys(chain.counts)
      .filter((k) =>
        (mostlyNoAnswer
          ? k.startsWith("PROTOCOL_") || k === "NODE_RATE_LIMITED"
          // Error replies include honest CHAIN answers ("block not found") -
          // they are part of the share and must be visible on the row, or the
          // remedy blames a provider for something the chain said truthfully.
          : k.startsWith("NODE_") || (k.startsWith("CHAIN_") && k !== "CHAIN_EXECUTION_REVERTED" && !CALLER_CODES.has(k))) &&
        !CONFIG_CODES.has(k))
      .sort((a, b) => (chain.counts[b] ?? 0) - (chain.counts[a] ?? 0));
    const wasShare = c.errorsWas != null && c.answersWas != null && c.answersWas >= MIN_ANSWERS
      ? Math.max(0, c.errorsWas) / c.answersWas
      : null;
    out.push({
      tier: critical ? "critical" : "attention",
      kind: mostlyNoAnswer ? "dead" : "answered-error",
      sinceSec: null, firstSeenUnix: null, lastSeenUnix: null, ongoing: null,
      decision,
      id: `${chain.spec}:${c.upstream}:errors`,
      spec: chain.spec, chainName: meta.name,
      upstream: c.upstream, role: c.role,
      headline: dominantIsRateLimit
        ? `${pct(share)} rate-limited`
        : `${pct(share)} errors${mostlyNoAnswer ? " - mostly no reply" : ""}`,
      metric: { value: pct(share), label: "of answers" },
      codes: codes.slice(0, 3),
      codeCounts: Object.fromEntries(codes.slice(0, 3).map((k) => [k, chain.counts[k] ?? 0])),
      reference: `line ${critical ? "5" : "1"}%${wasShare != null ? ` · was ${pct(wasShare)} this time last week` : ""}`,
      evidence: [{ k: "errors", v: `${num(errors)} of ${num(answers)} answers` }],
      remedy: dominantIsRateLimit
        ? `**The provider's request limit is the cause**${peak != null ? ` - throughput topped out near ${peak.toFixed(1)}/s, which is roughly the plan's ceiling` : ""}.`
        : codes[0]?.startsWith("CHAIN_")
          ? "**These are real chain answers, not provider failures.** \"Block not found\" usually means the caller asks for a block the node does not have yet (an indexer racing the newest block), or for history the node no longer keeps."
          : mostlyNoAnswer
            ? "**The provider is not answering at all** - a reachability problem, not bad responses."
            : "**The provider is reachable and answering with errors** - nothing on the routing side causes or fixes this.",
    });
  }

  /* ── Answered, but nothing checked the answer ─────────────────────────
     The verification coverage finding. A chain where no read enforced a
     minimum block and no cross-validation ran is a chain where a frozen or
     lying provider is invisible by construction - that is the class behind
     every 7-10h diagnosis in the record. Attention, not critical: nothing is
     known to be wrong, but nothing COULD be known. */
  if (verif) {
    const checks = verif.consistencyChecks ?? 0;
    const rounds = verif.xvalRounds ?? 0;
    const served = cells.reduce((sum, c) => sum + c.served, 0);
    if (served >= 300 && checks === 0 && rounds === 0) {
      push(
        "attention",
        "answered-unchecked",
        "Answers not checked - nothing verifies this chain",
        { value: num(served), label: "unchecked relays" },
        [],
        [
          { k: "min-block checks", v: verif.consistencyChecks == null ? "never registered" : "0" },
          { k: "cross-validation", v: verif.xvalRounds == null ? "never registered" : "0 rounds" },
        ],
        "**No check verifies the answers on this chain** - a wrong or stale provider is invisible until one runs.",
      );
    } else if (verif.consistencyCaught > 0) {
      // Verification WORKED - it caught stale answers. Worth knowing, and
      // worth knowing which upstream, which consistency counters cannot say.
      push(
        "attention",
        "answered-stale",
        `${num(verif.consistencyCaught)} stale answers caught`,
        { value: num(verif.consistencyCaught), label: "stale, caught" },
        [],
        [
          { k: "caught", v: `${num(verif.consistencyCaught)} of ${num(checks)} checked reads` },
        ],
        "**The check worked.** A rising count is a provider falling behind.",
      );
    }
    // Cross-validation that cannot even run is a Config fault - the policy
    // asks for more providers or groups than the chain has, so every validated
    // request fails before any answer is compared. Genuine disagreement is NOT
    // a finding: a provider disagreeing with its peers is a reliability trend,
    // shown over the week in Insights, not an incident this window.
    const failed = Object.values(verif.xvalFailedByReason).reduce((a, b) => a + b, 0);
    const structuralReasons = ["insufficient-capacity", "insufficient-groups", "insufficient-responses"];
    const structural = Object.entries(verif.xvalFailedByReason)
      .filter(([r]) => structuralReasons.includes(r))
      .reduce((a, [, n]) => a + n, 0);
    if (rounds > 0 && structural >= MIN_EVENTS && structural / rounds >= 0.05) {
      const top = Object.entries(verif.xvalFailedByReason)
        .filter(([r]) => structuralReasons.includes(r))
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      push(
        "config",
        "answered-unchecked",
        `Cross-validation can't run - needs more providers than configured`,
        { value: num(structural), label: "rounds could not run" },
        [top],
        [
          { k: "rounds", v: num(rounds) },
          { k: "could not run", v: `${num(structural)} - ${pct(structural / rounds)}` },
          { k: "reason", v: top },
        ],
        "**Verification is set to need more providers than this chain has** - as configured, it fails before any answer is compared.",
      );
    }
    void failed;
  }

  /* ── Answered, but too late to be useful ──────────────────────────────
     From the client histogram's top bucket (>=10s). We do not know the
     caller's client timeout - it is not in the config schema - but a request
     that took 10+ seconds has outlived every mainstream client default, so
     the histogram's own ceiling is the honest "effectively timed out" count.
     This was the one data family that recorded the slow-success incident and
     drove zero pixels. */
  if (stats && stats.clientRequests >= minRequestsFor(0.005)) {
    const share = stats.slowAnswers / stats.clientRequests;
    const was = stats.slowShareWas;
    const critical = share >= 0.02;
    const regressed = share >= 0.005 && was != null && was > 0 && share >= 3 * was;
    const newlySlow = share >= 0.005 && (was == null || was === 0) && stats.slowAnswers >= MIN_EVENTS;
    if (stats.slowAnswers >= MIN_EVENTS && (critical || regressed || newlySlow)) {
      push(
        critical ? "critical" : "attention",
        "answered-late",
        critical
          ? `${pct(share)} of answers over 10s`
          : `10s+ answers climbing - ${(share * 100).toFixed(2)}%${
              was != null && was > 0 ? `, ${(share / was).toFixed(1)}x last week` : was === 0 ? ", none last week" : ""
            }`,
        { value: num(stats.slowAnswers), label: "answers ≥10s" },
        [],
        [
          { k: "slow", v: `${num(stats.slowAnswers)} of ${num(stats.clientRequests)} answers` },
          { k: "last week", v: was == null ? "no history" : pct(was) },
        ],
        "**Answers are arriving after callers stop waiting** - a success slower than the caller's timeout is a failure for them.",
      );
    }
  }

  const rank: Record<StatusTier, number> = { critical: 0, config: 1, attention: 2 };
  return out.sort((a, b) => rank[a.tier] - rank[b.tier]);
}

/** Chains whose redundancy exists in the config but not in the traffic. */
export function deriveNoFailover(
  cells: StatusCell[],
  configuredPerChain: Record<string, number>,
): NoFailoverChain[] {
  const bySpec = new Map<string, StatusCell[]>();
  for (const c of cells) {
    bySpec.set(c.spec, [...(bySpec.get(c.spec) ?? []), c]);
  }

  const out: NoFailoverChain[] = [];
  for (const [spec, list] of bySpec) {
    const configured = configuredPerChain[spec] ?? list.length;
    // ONE configured upstream, full stop (Omer, 9 Sep). Anything inferred
    // from traffic - idle backups, concentration, "never proven" - is out:
    // served shares cannot tell a broken backup from one the router simply
    // never needed, and the inferred version flagged most of a healthy
    // fleet. This roll-up states a config fact only.
    if (configured > 1) continue;
    const eff = effectiveUpstreams(list);
    const proven = list.filter((c) => c.role === "backup" && c.served > 0).length;

    out.push({
      spec,
      name: buildChainMetaByIndex(spec).name,
      configured,
      effective: eff ? Math.round(eff.effective * 100) / 100 : 1,
      topUpstream: eff?.top ?? list[0]?.upstream ?? null,
      topSharePct: eff?.topShare == null ? null : Math.round(eff.topShare * 1000) / 10,
      provenBackups: proven,
      reason: "A single provider configured - primary or backup makes no difference; any failure is an outage.",
    });
  }

  return out.sort(
    (a, b) => a.effective - b.effective || b.configured - a.configured,
  );
}

/**
 * The standing INSIGHTS - posture, not active fires. Every rule's threshold
 * ships with the arithmetic behind it (`basis`), because "how do we decide
 * what a bad time is" has to be answerable ON the page, not in a design doc.
 */
export function deriveInsights(
  cells: StatusCell[],
  baselines: UpstreamBaseline[],
  chainStats: ChainWindowStats[],
  configuredPerChain: Record<string, number>,
  verification: ChainVerification[] = [],
): StatusInsight[] {
  const out: StatusInsight[] = [];
  const base = (u: string, spec: string) =>
    baselines.find((b) => b.upstream === u && b.spec === spec);
  const bySpec = new Map<string, StatusCell[]>();
  for (const c of cells) bySpec.set(c.spec, [...(bySpec.get(c.spec) ?? []), c]);

  for (const [spec, list] of bySpec) {
    const name = buildChainMetaByIndex(spec).name;
    const configured = configuredPerChain[spec] ?? list.length;

    /* ── 2.2 De-facto single point of failure ─────────────────────────── */
    if (configured > 1) {
      const shares = list
        .map((c) => ({ c, share: base(c.upstream, spec)?.shareDay ?? null }))
        .filter((x) => x.share != null) as { c: StatusCell; share: number }[];
      const top = shares.sort((a, b) => b.share - a.share)[0];
      if (top && top.share >= 0.95) {
        out.push({
          id: `${spec}:spof`,
          kind: "de-facto-spof",
          tier: "attention",
          spec, chainName: name,
          upstream: top.c.upstream,
          headline: `${top.c.upstream} has carried ${pct(top.share)} of this chain over the last day - the config declares a failover, the traffic says a failure here is an outage`,
          value: pct(top.share),
          baseline: `${configured} upstreams configured`,
          basis:
            "One provider served 95% or more of this chain's traffic in the last day. The other configured providers together served almost nothing, so we do not know if they actually work. If the main provider fails, the chain likely goes down with it.",
          evidence: [
            { k: "share, trailing 24h", v: pct(top.share) },
            { k: "configured", v: String(configured) },
          ],
        });
      }
    }

    /* ── 2.3 Backup unreliable lately - the burn-rate answer ──────────── */
    for (const c of list.filter((x) => x.role === "backup")) {
      const b = base(c.upstream, spec);
      if (!b) continue;
      const m6 = b.unviableMin6h, m1 = b.unviableMin1h;
      // Google SRE multi-window burn on a 1% budget: 14.4x fast burn = 8.5min/1h,
      // 6x = 20min/6h. "Down too long" is a budget question, not wall-clock taste.
      const fast = m1 != null && m1 > 8.5;
      const slow = m6 != null && m6 > 20;
      if (fast || slow) {
        out.push({
          id: `${spec}:${c.upstream}:backup-burn`,
          kind: "backup-unreliable",
          tier: fast ? "attention" : "advisory",
          spec, chainName: name,
          upstream: c.upstream,
          headline: `Your escape route is unreliable - ${c.upstream} was unviable for at least ${Math.round((fast ? m1! : m6!))} min of the last ${fast ? "hour" : "6 hours"}`,
          value: `${Math.round((fast ? m1! : m6!))} min`,
          baseline: fast ? "budget: 8.5 min/hour" : "budget: 20 min/6h",
          basis:
            "A backup is useful only if it works when called. We allow it to be broken for up to 1% of the time. This alert fires when it was broken for more than 8.5 minutes in the last hour, or more than 20 minutes in the last 6 hours - enough to say it burned that allowance, not just a short blip. The minutes are counted from failed relays, so they are minimum values.",
          evidence: [
            { k: "unviable", v: `>=50% of received relays errored, or unpolled with availability score <0.5` },
            { k: "last hour", v: m1 == null ? "-" : `${Math.round(m1)} min` },
            { k: "last 6h", v: m6 == null ? "-" : `${Math.round(m6)} min` },
          ],
        });
      }
    }

    /* ── 2.5 Provider slower than its own history ─────────────────────── */
    for (const c of list) {
      const b = base(c.upstream, spec);
      if (!b || b.avgMs == null || b.avgWasMs == null || b.avgWasMs <= 0) continue;
      if (b.avgMs >= 2 * b.avgWasMs && b.avgMs - b.avgWasMs >= 200) {
        out.push({
          id: `${spec}:${c.upstream}:slower`,
          kind: "slower-than-history",
          tier: "advisory",
          spec, chainName: name,
          upstream: c.upstream,
          headline: `${c.upstream} is ${(b.avgMs / b.avgWasMs).toFixed(1)}x slower than a week ago - answers average ${Math.round(b.avgMs)}ms against ${Math.round(b.avgWasMs)}ms in this window last week`,
          value: `${Math.round(b.avgMs)}ms avg`,
          baseline: `a week earlier ${Math.round(b.avgWasMs)}ms`,
          basis:
            "There is no speed limit that is fair for every provider - some are simply slower than others and still healthy. So each provider is compared only to its own speed one week ago. It must be at least 2x slower, and at least 200ms slower, before this fires - small day-to-day changes stay quiet.",
          evidence: [
            { k: "average now", v: `${Math.round(b.avgMs)}ms` },
            { k: "same window last week", v: `${Math.round(b.avgWasMs)}ms` },
          ],
        });
      }
    }

    /* ── 2.6 Failure rate creeping under the alarm ────────────────────── */
    for (const c of list) {
      const attempts = c.served + c.noAnswer;
      if (attempts < minRequestsFor(0.005) || c.noAnswer < MIN_EVENTS) continue;
      const rate = c.noAnswer / attempts;
      const b = base(c.upstream, spec);
      if (rate >= 0.005 && rate < NO_ANSWER_RATE && b?.failRateWas != null && b.failRateWas > 0 && rate >= 3 * b.failRateWas) {
        out.push({
          id: `${spec}:${c.upstream}:creep`,
          kind: "creeping-failures",
          tier: "advisory",
          spec, chainName: name,
          upstream: c.upstream,
          headline: `${c.upstream} is failing ${pct(rate)} of relays - under the alarm line, but ${(rate / b.failRateWas).toFixed(1)}x its own norm`,
          value: pct(rate),
          baseline: `was ${pct(b.failRateWas)} this window last week`,
          basis:
            "The alarm line is 1%. This provider is still under that line, but it is failing several times more than it normally does. That usually means a problem is growing - this row shows it before it crosses the line.",
          evidence: [
            { k: "failing", v: `${num(c.noAnswer)} of ${num(attempts)}` },
            { k: "same window last week", v: pct(b.failRateWas) },
          ],
        });
      }
    }

    /* ── 2.8 Provider disagrees with its peers (cross-validation) ─────────
       The one verification signal that NAMES the provider directly - the
       counter carries provider_address, so no attribution bound applies. A
       provider whose answer is repeatedly the odd one out is giving the
       customer different data than everyone else for the same question. */
    const ver = verification.find((v) => v.spec === spec);
    if (ver) {
      for (const pv of ver.byProvider) {
        const total = pv.disagreed + pv.agreed;
        if (total < 20 || pv.disagreed < MIN_EVENTS) continue;
        const rate = pv.disagreed / total;
        if (rate < 0.05) continue;
        const c = list.find((x) => x.upstream === pv.upstream);
        out.push({
          id: `${spec}:${pv.upstream}:disagrees`,
          kind: "disagrees-with-peers",
          tier: rate >= 0.2 ? "attention" : "advisory",
          spec, chainName: name,
          upstream: pv.upstream,
          headline: `${pv.upstream} gave a different answer than its peers ${pct(rate)} of the time it was checked this week - its data does not match the other providers`,
          value: pct(rate),
          baseline: `${num(pv.disagreed)} of ${num(total)} checks, 7 days`,
          basis:
            "Cross-validation sends the same question to several providers and compares the answers. This provider's answer was different from the others. Some disagreement at the newest block is normal, so this fires only above 5% of checks. Above 20%, this provider is regularly wrong and is the one to check first.",
          evidence: [
            { k: "disagreed", v: `${num(pv.disagreed)} times` },
            { k: "agreed", v: `${num(pv.agreed)} times` },
            ...(c?.role ? [{ k: "role", v: c.role }] : []),
          ],
        });
      }
    }

    /* ── 2.7 Retries running as a crutch ──────────────────────────────── */
    const st = chainStats.find((x) => x.spec === spec);
    if (st && st.clientRequests >= 300) {
      const apr = st.attempts / st.clientRequests;
      const was = st.attemptsPerReqWas;
      const absolute = apr >= 1.25;
      const regressed = apr >= 1.1 && was != null && was > 0 && apr >= 2 * was;
      if (absolute || regressed) {
        out.push({
          id: `${spec}:apr`,
          kind: "retries-crutch",
          tier: "attention",
          spec, chainName: name,
          upstream: null,
          headline: `The router is working harder to keep this chain flat - ${apr.toFixed(2)} attempts per request${was != null ? `, normally ${was.toFixed(2)}` : ""}`,
          value: `${apr.toFixed(2)} attempts/request`,
          baseline: was == null ? null : `a week earlier ${was.toFixed(2)}`,
          basis:
            "1.25 attempts per request means one call in four needed a retry. The users still see success, but only because the router keeps retrying - and that much retry traffic adds real load. It also fires at 1.1 if that is double what it was a week ago. Rising retries are usually the first sign of a problem that will become errors.",
          evidence: [
            { k: "attempts", v: num(st.attempts) },
            { k: "client requests", v: num(st.clientRequests) },
          ],
        });
      }
    }
  }

  const tierRank = { attention: 0, advisory: 1 } as const;
  return out.sort((a, b) => tierRank[a.tier] - tierRank[b.tier]);
}

/** The CHAINS table - every chain, its numbers, no praise. */
export function buildChainRows(
  cells: StatusCell[],
  chainStats: ChainWindowStats[],
  findingSpecs: Set<string>,
): import("@sr/shared").ChainStatusRow[] {
  const bySpec = new Map<string, StatusCell[]>();
  for (const c of cells) bySpec.set(c.spec, [...(bySpec.get(c.spec) ?? []), c]);
  const rows: import("@sr/shared").ChainStatusRow[] = [];
  for (const [spec, list] of bySpec) {
    const st = chainStats.find((x) => x.spec === spec);
    const served = list.reduce((s, c) => s + c.served, 0);
    const noAns = list.reduce((s, c) => s + c.noAnswer, 0);
    const bad = list.reduce((s, c) => s + c.badAnswer, 0);
    const attempts = served + noAns;
    const enough = attempts >= minRequestsFor(NO_ANSWER_RATE);
    rows.push({
      spec,
      name: buildChainMetaByIndex(spec).name,
      requests: st?.clientRequests ?? served,
      noAnswerRate: enough && attempts > 0 ? noAns / attempts : null,
      errorAnswerRate: enough && served > 0 ? bad / served : null,
      slowAnswers: st?.slowAnswers ?? 0,
      attemptsPerRequest:
        st && st.clientRequests > 0 ? Math.round((st.attempts / st.clientRequests) * 1000) / 1000 : null,
      attemptsPerRequestWas: st?.attemptsPerReqWas ?? null,
      state: findingSpecs.has(spec) ? "finding" : enough ? "quiet" : "insufficient",
    });
  }
  return rows.sort((a, b) => b.requests - a.requests);
}

/** Assemble the whole report. */
export function buildStatusReport(input: StatusInput): StatusReport {
  const chainStats = input.chainStats ?? [];
  const baselines = input.baselines ?? [];
  const timings = new Map((input.timings ?? []).map((t) => [t.key, t]));

  // Derive per chain PRESENT IN THE CELLS, not per chain with classified
  // errors - the stale-tip check must run on chains with zero errors.
  const kindsBySpec = new Map(input.kinds.map((k) => [k.spec, k]));
  const allChainSpecs = [...new Set(input.cells.map((c) => c.spec))];
  const findings = allChainSpecs
    .map((spec) => kindsBySpec.get(spec) ?? { spec, counts: {} })
    .flatMap((k) =>
      deriveChainFindings(
        k, input.cells, input.declaredAddons, input.windowSeconds,
        chainStats.find((x) => x.spec === k.spec),
        (input.verification ?? []).find((x) => x.spec === k.spec),
      ),
    )
    .map((f) => {
      // Attach measured first/last-seen where the assembly measured it.
      const key =
        f.kind === "dead" ? `${f.spec}:dead`
        : f.kind === "answered-stale" ? `${f.spec}:${f.upstream}:stale`
        // Rate-limit and not-answering both ride the errored counter; error
        // answers and config both ride node-errors. Chain-level findings
        // (no named upstream) have no per-upstream series to time - they keep
        // "in the last {window}" on the row.
        : f.upstream && (f.id.endsWith(":dead") || f.id.includes(":answered-error"))
          ? `${f.spec}:${f.upstream}:${f.id.endsWith(":dead") ? "no-answer" : "answered-error"}`
        : f.upstream && f.kind === "config" ? `${f.spec}:${f.upstream}:answered-error`
        : null;
      const t = key ? timings.get(key) : undefined;
      return t
        ? { ...f, firstSeenUnix: t.firstSeenUnix, lastSeenUnix: t.lastSeenUnix, ongoing: t.ongoing }
        : f;
    })
    .sort((a, b) => {
      const rank: Record<StatusTier, number> = { critical: 0, config: 1, attention: 2 };
      return rank[a.tier] - rank[b.tier];
    });

  // The roll-up is a config fact only: chains with ONE upstream configured
  // (Omer, 9 Sep). Traffic-inferred risk stays out of it - see
  // deriveNoFailover.
  const noFailover = deriveNoFailover(input.cells, input.configuredPerChain);
  // The per-chain "one upstream carried 99% of it" insight stays suppressed
  // for single-configured chains AND for concentrated multi-provider ones:
  // on a one-primary-everywhere deployment it is true for most of the fleet
  // by design (Omer, 20 Aug), and 20 copies of it bury the insights that
  // differ.
  const bySpecCells = new Map<string, StatusCell[]>();
  for (const c of input.cells) bySpecCells.set(c.spec, [...(bySpecCells.get(c.spec) ?? []), c]);
  const coveredSpecs = new Set(noFailover.map((n) => n.spec));
  for (const [spec, list] of bySpecCells) {
    const eff = effectiveUpstreams(list);
    if (eff && eff.effective <= NO_FAILOVER_EFFECTIVE) coveredSpecs.add(spec);
  }
  const insights = deriveInsights(input.cells, baselines, chainStats, input.configuredPerChain, input.verification ?? [])
    .filter((i) => !(i.kind === "de-facto-spof" && coveredSpecs.has(i.spec)));
  const chains = buildChainRows(input.cells, chainStats, new Set(findings.map((f) => f.spec)));

  const { attempts, customerRequests, failedAttempts } = input.totals;
  const troubled = new Set([...findings.map((f) => f.spec), ...noFailover.map((n) => n.spec)]);

  return {
    computedAtUnix: Math.floor(Date.now() / 1000),
    findings,
    insights,
    noFailover,
    chains,
    totals: {
      requestsServed: input.totals.requestsServed,
      attemptsPerRequest:
        attempts != null && customerRequests && customerRequests > 0
          ? Math.round((attempts / customerRequests) * 1000) / 1000
          : null,
      upstreamFailureRate:
        failedAttempts != null && attempts && attempts > 0 ? failedAttempts / attempts : null,
      chainsClear: allChainSpecs.filter((s2) => !troubled.has(s2)).length,
      chainsTotal: allChainSpecs.length,
      prior: input.priorTotals ?? {
        requestsServed: null, attemptsPerRequest: null, upstreamFailureRate: null,
      },
    },
    lastCritical24h: input.lastCritical24h
      ? {
          spec: input.lastCritical24h.spec,
          chainName: buildChainMetaByIndex(input.lastCritical24h.spec).name,
          atUnix: input.lastCritical24h.atUnix,
        }
      : null,
    worstMover: input.worstMover
      ? { ...input.worstMover, chainName: buildChainMetaByIndex(input.worstMover.spec).name }
      : null,
    emitted: input.emitted,
  };
}
