import type { ScoreType } from "../constants/metrics.js";
import type { MetricWindow } from "../constants/windows.js";

export type { MetricWindow, ScoreType };

/** Binary health, mirroring `*_overall_health` gauges (1 = healthy). */
export type HealthState = "operational" | "unhealthy" | "unknown";

/** A single point in a time-series returned to the web. */
export interface TimePoint {
  /** Unix seconds. */
  t: number;
  /** Value; null when Prometheus had no sample in that bucket. */
  v: number | null;
}

export interface TimeSeries {
  label: string;
  points: TimePoint[];
}

/** Per-chain rollup for the Overview "Routers" table. */
export interface ChainMetrics {
  spec: string;
  name: string;
  color: string;
  requests: number;
  availability: number | null;
  errorRate: number | null;
  p95Ms: number | null;
  /** Composite QoS from selection_score, or null when not emitted. */
  qos: number | null;
  health: HealthState;
  latestBlock: number | null;
  upstreamCount: number;
}

/**
 * One row of the Routers table — **one config router**, not one chain.
 *
 * A chain can be served by several routers (a prod/staging pair on one network,
 * say), and only the mounted values file tells them apart: no series carries a
 * router. `attribution` is how much of that this row could overcome.
 */
export interface RouterMetrics extends ChainMetrics {
  /** Config router id (`eth-prod`, `ETH1`, …) — the row's identity. */
  routerId: string;
  /**
   * `own`   — the collector labels this router's scrape target, so the
   *           chain-level numbers below were scoped to it and are its alone.
   * `shared` — they are the chain's, covering every router in `sharedWith` too.
   *           Two rows can then carry the same figures; that is the truth, and
   *           adding them up would double the deployment's traffic.
   */
  attribution: "own" | "shared";
  /** The other routers counted into these numbers; empty when `own`. */
  sharedWith: string[];
  /** Declared upstreams — from the config, so always this router's own. */
  upstreamCount: number;
}

/** Per backing-endpoint roster row. */
export interface UpstreamMetrics {
  endpointId: string;
  spec: string;
  requests: number;
  uptime: number | null;
  p95Ms: number | null;
  errorRate: number | null;
  /** score_type → score (0..1); empty when none emitted. */
  scores: Partial<Record<ScoreType, number>>;
  /**
   * Which gauge the `scores` above came from, so a reader knows how current
   * they are. `optimizer` is the sampler's — refreshed on a timer for every
   * upstream, traffic or none. `endpoint` is the routing path's fallback,
   * written only when a relay was last routed to this upstream, so on an idle
   * row it can be arbitrarily old and the UI must say so. `null` ⇒ `scores` is
   * empty. The two gauges carry the SAME numbers (one optimizer computation
   * fills both); they differ in when they are written and who they cover.
   */
  scoreSource: "optimizer" | "endpoint" | null;
  /**
   * Latest-block polls the router's chain tracker made against this upstream
   * over the window. Traffic-independent — the tracker polls every configured
   * upstream, backups included — so it is the one liveness signal an idle row
   * still has.
   *
   * `null` when the family is absent (older router). `{ ok: 0, failed: 0 }` is
   * NOT health: a poll gate suppresses polls that served traffic or a peer
   * already made redundant, so both-zero means "not polled in this window".
   */
  polls: { ok: number; failed: number } | null;
  health: HealthState;
  latestBlock: number | null;
  /** Blocks behind the spec's best endpoint; null when unknown. */
  blockLag: number | null;
  /**
   * `blockLag` expressed in SECONDS (blocks ÷ the chain's block rate), which is
   * the only form comparable across chains. Null when the chain's rate is
   * unknown or zero — never Infinity.
   */
  behindSec: number | null;
  /** Tip gauge frozen while the chain kept producing blocks. */
  stale: boolean;
  /** From config `is_backup` (helm format only); null for SR_CONFIG. */
  role: "primary" | "backup" | null;
  apiInterface: string | null;
  inFlight: number;
  /**
   * Config routers that declare this upstream ON THIS ROW'S CHAIN — `[]` when
   * no values file is mounted, one id normally, SEVERAL when routers of the
   * same chain share a node name. A vendor name reused across chains
   * ("lava", "publicnode") is a different endpoint per chain and never joins
   * another chain's list.
   *
   * It comes from the config, not from the series, because no series carries a
   * router: `rpc_endpoint_*` is labelled `endpoint_id` + `spec` (+ the
   * collector's target labels) and nothing else. So the numbers on this row
   * are that node's, and they are the named router's only as far as the node
   * name is that router's alone — two routers declaring one name on one chain
   * share a single series, which is why this is a list and why the UI marks
   * those rows instead of splitting them.
   */
  routerIds: string[];
}



/* ── Block tips (GET /api/metrics/block-heights) ─────────────────────────── */

/** One router deployment's view of a chain's head, per api interface. */
export interface RouterTip {
  /**
   * The router deployment, as the value of the scrape-target scope label.
   * Null when Prometheus attaches no such label (a single static target), in
   * which case the rows are the interface split of the one router.
   */
  router: string | null;
  apiInterface: string;
  block: number | null;
  /** Blocks behind the chain's best upstream tip. */
  behindBlocks: number | null;
  /** The same lag in seconds — what the UI shows. Null when the rate is unknown. */
  behindSec: number | null;
  /**
   * Observed seconds between refreshes of THIS gauge. A lag of roughly one
   * refresh is the gauge working as designed; the UI only flags a router once
   * it falls behind by a multiple of its own cadence. Null when the gauge did
   * not move at all over the window.
   */
  refreshSec: number | null;
}

/** One upstream's view of a chain's head, per api interface. */
export interface UpstreamTip {
  endpointId: string;
  apiInterface: string;
  block: number | null;
  behindBlocks: number | null;
  behindSec: number | null;
  stale: boolean;
  health: HealthState;
}

/** Every tip observed for one chain, plus the rate that makes them comparable. */
export interface ChainTips {
  spec: string;
  name: string;
  color: string;
  /** Blocks per second, from the per-endpoint gauge; null when unmeasurable. */
  blocksPerSec: number | null;
  /** Highest upstream tip — the reference every `behind` measures against. */
  bestBlock: number | null;
  routers: RouterTip[];
  upstreams: UpstreamTip[];
}

/** `GET /api/metrics/block-heights` payload. */
export interface BlockHeights {
  /** The scope label the router rows are split by; null when unavailable. */
  routerLabel: string | null;
  chains: ChainTips[];
}

/** One row in the Traffic "by chain" table. */
export interface ChainTraffic {
  spec: string;
  name: string;
  color: string;
  /** Latest RPS bucket. */
  rpsNow: number | null;
  /** Total requests over the window. */
  requests: number;
  /** Fraction of total traffic (0..1), null when total is zero. */
  share: number | null;
  /** Sparkline series (rate per step). */
  trend: TimePoint[];
}

export interface TrafficSummary {
  /** Aggregate RPS-now across all chains. */
  rpsNow: number | null;
  chainCount: number;
  aggregate: TimePoint[];
  chains: ChainTraffic[];
}

/** Method-level breakdown row. Backed only when the router emits a `method`
 *  label on the request/latency series; otherwise this list is empty. */
export interface MethodUsage {
  method: string;
  class: "read" | "write" | "batch" | "unknown";
  requests: number;
  p95Ms: number | null;
  errorRate: number | null;
}

/** A KPI value with its prior-window comparison (for the ↑/↓ deltas). */
export interface Kpi {
  value: number | null;
  /** Same metric over the previous equal-length window, for delta arrows. */
  prior: number | null;
}

/** Per-chain latency row for the Overview "P50 latency" panel. */
export interface ChainLatency {
  spec: string;
  name: string;
  color: string;
  p50Ms: number | null;
  /** mini bar-chart series (recent latency buckets). */
  trend: TimePoint[];
  /** true when health gauge is 0 (the "degraded" tag). */
  degraded: boolean;
}

/** One active-route row ("requests today" bars). */
export interface ActiveRoute {
  endpointId: string;
  spec: string;
  color: string;
  requests: number;
  /** fraction of the max route (for the bar width), 0..1. */
  share: number;
}

/** Everything the Overview + Dashboard screens need in one round-trip. */
export interface OverviewData {
  totalRequests: Kpi;
  throughputRps: Kpi;
  errors: Kpi;
  errorRate: number | null;
  uptime: number | null;
  successRate: Kpi;
  p50Ms: Kpi;
  p95Ms: Kpi;
  p99Ms: Kpi;
  health: HealthState;
  /** Quota/cap are NOT emitted by the router — always null (gated in the UI). */
  computeUnits: { used: number | null; limit: number | null; resetsAt: string | null };
  rpsCap: number | null;
  throughput: TimePoint[];
  errorsSeries: TimePoint[];
  /** Latency time-series per percentile (for the p50/p95/p99 chart toggle). */
  latencySeries: { p50: TimePoint[]; p95: TimePoint[]; p99: TimePoint[] };
  /** Histogram bucket counts over the window (read-latency distribution). */
  latencyDistribution: { le: string; count: number }[];
  /** Per-upstream throughput stack (real via the provider_address label). */
  perUpstreamSeries: { upstream: string; points: TimePoint[] }[];
  /** Error layers; a single "unclassified" layer until labelled counters fire. */
  errorLayers: { layer: string; count: number }[];
  perChainLatency: ChainLatency[];
  activeRoutes: ActiveRoute[];
  /** Per-chain throughput series for the stacked "requests per chain" chart. */
  perChainSeries: { spec: string; name: string; color: string; points: TimePoint[] }[];
  lastUpdated: string | null;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

export interface MetricsQuery {
  spec?: string;
  window: MetricWindow;
}

/* ── Hero panel (Metrics · Overview tab) ─────────────────────────────────── */

/**
 * The six HeroPanel cards. Real: requests, success rate, effective read p95,
 * stale caught. Null until the router emits the family: retries, cache.
 */
export interface HeroSummary {
  requestsServed: Kpi;
  successRate: Kpi;
  /** Documented DERIVED estimate (no cache on this build ⇒ node read p95). */
  effectiveReadP95Ms: Kpi;
  staleCaught: Kpi;
  retriesRecovered: Kpi;
  cacheOffloadPct: Kpi;
  upstreamCount: number;
  chainCount: number;
  health: HealthState;
  /** Which absent-until-fired families were actually present at read time. */
  emitted: { retries: boolean; cache: boolean };
  lastUpdated: string | null;
}

/** One chain in the CurrentlyUnavailable strip (every endpoint down). */
export interface UnavailableChain {
  spec: string;
  name: string;
  color: string;
  /** Seconds since the outage began; null when not cheaply derivable. */
  sinceSeconds: number | null;
}

/* ── ChainDetail expandable row (Metrics · Overview tab) ─────────────────── */

/** Time-series bundle behind the ChainDetail metric switcher. */
export interface ChainSeries {
  spec: string;
  availability: TimePoint[];
  p95Ms: TimePoint[];
  errorRate: TimePoint[];
  rps: TimePoint[];
  /** Composite selection-score series; null when never emitted. */
  qos: TimePoint[] | null;
  /** Share of traffic on backup upstreams; null unless config marks backups. */
  backupShare: TimePoint[] | null;
}

/* ── Upstream deep-dive (Metrics · Upstreams tab, PMBody) ────────────────── */

export interface UpstreamErrorCode {
  code: string;
  count: number;
  lastSeen: string | null;
}

export interface UpstreamRecentError {
  at: string;
  method: string | null;
  code: string | null;
  message: string;
}

export interface UpstreamDetail {
  endpointId: string;
  spec: string;
  health: HealthState;
  availability: number | null;
  requests: number;
  rpsNow: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  errorRate: number | null;
  blockLag: number | null;
  inFlight: number;
  /** score_type → current score. */
  scores: Partial<Record<ScoreType, number>>;
  /** score_type → series (selection_score gauge over the window). */
  scoreSeries: Partial<Record<ScoreType, TimePoint[]>>;
  latencySeries: { p50: TimePoint[]; p95: TimePoint[]; p99: TimePoint[] };
  /** Request volume per bucket. `read` is real; write/batch null until emitted. */
  volume: {
    total: TimePoint[];
    read: TimePoint[];
    write: TimePoint[] | null;
    batch: TimePoint[] | null;
  };
  blockLagSeries: TimePoint[];
  /** Availability over fixed sub-windows (independent of the page window). */
  availabilityWindows: {
    last1h: number | null;
    last24h: number | null;
    last7d: number | null;
  };
  /**
   * Whole-number error split over the window. `transport` = derived
   * relay failures (total − success). `node`/`protocol` come from the
   * lazily-registered labelled counters — an absent family means the event
   * never fired since boot, so 0 is the honest value.
   */
  errorSplit: { node: number; protocol: number; transport: number };
  /** Node errors by method for this upstream (real once the family fires). */
  nodeErrorsByMethod: { method: string; count: number }[];
  /** Cross-validation participation: how often this upstream agreed. */
  crossValidation: {
    agreements: number;
    disagreements: number;
    /** disagreements / (agreements + disagreements); null when no rounds. */
    disagreementRate: number | null;
  };
  /** Per-code catalog stays empty — node_errors_total has no `code` label. */
  errorsByCode: UpstreamErrorCode[];
  recentErrors: UpstreamRecentError[];
  emitted: { errorsByCode: boolean; recentErrors: boolean };
}

/* ── Errors breakdown tab ────────────────────────────────────────────────── */

export interface ErrorHotspot {
  spec: string;
  name: string;
  color: string;
  upstream: string;
  errors: number;
  requests: number;
  errorRate: number | null;
  trend: TimePoint[];
  /** Top node-error methods for this (chain × upstream) pair — real once
   *  node_errors_total fires; empty (never null) before that. */
  nodeMethods: { method: string; count: number }[];
  /**
   * ALL node errors on the pair (not just the `nodeMethods` top slice). A pair
   * can sit at `errors: 0` and still be here on the strength of this: the
   * upstream answered with a JSON-RPC error, which the relay counts as served.
   * Kept separate from `errors` because they are different failures and adding
   * them would misstate both.
   */
  nodeErrors: number;
}

export interface ErrorPivotRow {
  key: string;
  label: string;
  errors: number;
  /** Share of all errors (0..1); null when total is zero. */
  share: number | null;
}

/**
 * Severity on the status page. Three tiers, and the line between the first two
 * is not ours: it is where GK8's own production alert sits.
 *
 * - `critical`  — a customer request DIED. The router exhausted its options.
 * - `attention` — the router absorbed it, at the cost of your redundancy.
 * - `config`    — the deployment is asking for something it cannot get. Will
 *                 never resolve on its own, and is usually a one-line fix.
 *
 * Deliberately NOT a severity: the chain declining a request. A reverted
 * `eth_call` is a correct answer, and on a busy testnet it outnumbers real
 * failures hundreds to one.
 */
export type StatusTier = "critical" | "attention" | "config";

/** One row on the status page: a problem, its evidence, and what to do. */
/**
 * WHY a finding exists — the failure shape, not its severity.
 *
 * The four `answered-*` kinds are the axis a failure-counter page cannot see:
 * every one of them fires while the upstream returns HTTP 200 and every error
 * counter reads zero. Every diagnosis over six hours in the incident record is
 * one of these.
 */
export type FindingKind =
  | "dead"              // nothing could serve it — the request died
  | "answered-stale"    // 200 OK, block height frozen
  | "answered-late"     // 200 OK, past the caller's usable deadline
  | "answered-error"    // 200 OK at the transport, an error in the body
  | "answered-unchecked"// nothing verified the answer's freshness
  | "no-backup"         // serving fine, nowhere to go if it stops
  | "config";           // asking for something no upstream here provides

export interface StatusFinding {
  kind: FindingKind;
  tier: StatusTier;
  /** Stable id so the UI can key rows across polls. */
  id: string;
  spec: string;
  chainName: string;
  /** The upstream at fault; null when the finding spans several. */
  upstream: string | null;
  role: "primary" | "backup" | null;
  /** One sentence: what is wrong. Plain language, no metric names. */
  headline: string;
  /** The number on the right of the row. */
  metric: { value: string; label: string };
  /** Error names behind it, for the drill-down. */
  codes: string[];
  /** The number's frame, rendered muted after the headline: the line it is
   *  judged against and, when known, the same window one week earlier. */
  reference?: string;
  /** Events per code in the window, for the codes above — what actually
   *  crashed it, with its count. Chain-level (the classified counter carries
   *  no provider); missing when a code's count is unknown. */
  codeCounts?: Record<string, number>;
  /** Key/value pairs proving the headline. */
  evidence: { k: string; v: string }[];
  /** What the operator should do. An instruction, not a description. */
  remedy: string;
  /**
   * How long this has been true, in seconds, when it can be measured. Null when
   * the window can only say "somewhere in here" — never a fabricated interval.
   */
  sinceSec: number | null;
  /** First/last observation of the driving signal (unix secs), measured from
   *  metric history and never capped at the selected window. */
  firstSeenUnix: number | null;
  lastSeenUnix: number | null;
  /** True when the driving signal was still present in the newest samples. */
  ongoing: boolean | null;
  /**
   * The optimizer's own reasoning at the moment of the finding: each upstream on
   * the chain, its selection scores, and its share of served traffic.
   *
   * This adjudicates rather than detects. A sync score of 1.0 against a frozen
   * tip says the optimizer never saw the staleness — no config change of the
   * customer's fixes that. A higher-scoring upstream taking no traffic says
   * selection ignored its own score. Either answer ends the argument.
   */
  decision: {
    upstream: string;
    sharePct: number | null;
    scores: Partial<Record<ScoreType, number>>;
  }[];
}

/**
 * A chain whose redundancy exists in the config but not in reality.
 *
 * `effective` is `1 / Σ(share²)` over the chain's traffic — the standard
 * concentration inverse. A chain with four upstreams where one serves 100% has
 * `configured: 4, effective: 1`. `provenBackups` counts backups that actually
 * served something: a backup that has never served has never been tested, and
 * on GK8 the ones that were tested failed.
 */
export interface NoFailoverChain {
  spec: string;
  name: string;
  configured: number;
  effective: number;
  topUpstream: string | null;
  topSharePct: number | null;
  provenBackups: number;
  reason: string;
}

/**
 * A standing advisory — posture, not an active fire. Judged against the
 * chain's or upstream's own history wherever possible; every row carries the
 * arithmetic behind its threshold, because a number the customer cannot
 * interrogate is a number they will not trust.
 */
export interface StatusInsight {
  id: string;
  kind:
    | "no-failover"        // one hiccup from outage — structural, no % to tune
    | "de-facto-spof"      // config declares redundancy, traffic says otherwise
    | "backup-unreliable"  // the escape route is burning its error budget
    | "timeouts-climbing"  // top-bucket share vs its own last week
    | "slower-than-history"// p95 vs the provider's own trailing median
    | "creeping-failures"  // under the alarm line but multiples of its own norm
    | "retries-crutch"     // attempts/request drifting above its own median
    | "disagrees-with-peers"; // cross-validation: this provider's answer was the odd one out
  tier: "attention" | "advisory";
  spec: string;
  chainName: string;
  upstream: string | null;
  headline: string;
  /** The number, already worded ("0.8%"), with its baseline beside it. */
  value: string;
  baseline: string | null;
  /** WHY the threshold sits where it sits — shown on the page, verbatim. */
  basis: string;
  evidence: { k: string; v: string }[];
}

/**
 * One detected incident: a burst of FINAL customer failures on a chain,
 * explained. Detection is episodes on `smartrouter_requests_failed_total`
 * (contiguous 5-minute buckets over the floor); the explanation joins what
 * the router saved (retries), who was failing (relay counters + config
 * role), and what the failures were (log lines by method). `summary` is the
 * customer-ready text, composed server-side so every surface words it the
 * same way.
 */
export interface Incident {
  id: string;
  spec: string;
  chainName: string;
  startUnix: number;
  endUnix: number;
  ongoing: boolean;
  /** Final customer failures inside the episode. */
  failures: number;
  /** Requests the router recovered by retrying, same span. */
  retriesRecovered: number | null;
  /** Providers failing during the episode, worst first. */
  blamed: { upstream: string; role: "primary" | "backup" | null; failRate: number; failed: number }[];
  /** Failed calls grouped by method, from the logs. Empty without Loki. */
  failedMethods: { method: string | null; count: number; errorName: string | null; example: string }[];
  /** The addon gap, when the config proves one ("only X serves DEBUG here"). */
  capabilityGap: string | null;
  /** Customer-ready bullets — forwardable as-is. */
  story: string[];
}

export interface IncidentsReport {
  incidents: Incident[];
  /** Hours scanned back from now. */
  lookbackHours: number;
  computedAtUnix: number;
}

/** One row of the CHAINS table — every chain, its numbers, no praise. */
export interface ChainStatusRow {
  spec: string;
  name: string;
  requests: number;
  /** Transport failure share (0..1); null under the event floor. */
  noAnswerRate: number | null;
  /** Error-answer share (0..1); null under the floor. */
  errorAnswerRate: number | null;
  /** Client answers that took >= 10s — a count, never hidden by a threshold. */
  slowAnswers: number;
  attemptsPerRequest: number | null;
  /** Same ratio, this window 7 days ago. */
  attemptsPerRequestWas: number | null;
  /** "finding" links to a row above; "quiet" = no rule crossed;
   *  "insufficient" = not enough traffic to judge — never "operational". */
  state: "finding" | "quiet" | "insufficient";
}

/** Everything the status page renders, in one round-trip. */
export interface StatusReport {
  /** When this report was computed, unix seconds. The api may serve a
   *  recently computed report while refreshing in the background — the page
   *  judges freshness by THIS stamp, not by when the response arrived. */
  computedAtUnix: number;
  findings: StatusFinding[];
  insights: StatusInsight[];
  noFailover: NoFailoverChain[];
  chains: ChainStatusRow[];
  /** Headline numbers — derived, not raw counters. */
  totals: {
    requestsServed: number;
    /** Upstream attempts ÷ customer requests. What the router costs you. */
    attemptsPerRequest: number | null;
    /** Failed attempts ÷ all attempts (0..1). */
    upstreamFailureRate: number | null;
    chainsClear: number;
    chainsTotal: number;
    /** Same four numbers, this window 7 days ago — a number without its prior
     *  is noise on a drift check. Null when no history. */
    prior: {
      requestsServed: number | null;
      attemptsPerRequest: number | null;
      upstreamFailureRate: number | null;
    };
  };
  /** The verdict's 24-hour memory: the last fatal-class fire even when the
   *  selected window is clean. "Everything healthy" over a night of fatal
   *  errors is how a status page loses its audience. */
  lastCritical24h: { spec: string; chainName: string; atUnix: number } | null;
  /** Worst chain-level delta, last 15 min vs the same 15 min yesterday —
   *  fires with no attribution gate so a ramp is on screen while it ramps. */
  worstMover: { spec: string; chainName: string; metric: string; now: string; was: string } | null;
  /** False when the classified-error family has never fired. */
  emitted: boolean;
}

/**
 * One upstream's failures, and every chain it is failing on — the view that
 * answers "is this provider broken everywhere, or just here?".
 *
 * Two INDEPENDENT counts, because a single provider error-rate lies. Verified
 * on GK8 production: Tatum on AVALANCHECT showed 635,678 `answeredWithError`
 * against 22 `unreachable` — a 30,000× gap. Their war room reads the second
 * one and reports Tatum at 0.39%, while Tatum returns 635k error bodies a day.
 * Transport-perfect, functionally broken.
 */
export interface ProviderFault {
  /** `provider_address` / `endpoint_id` — the upstream's configured name. */
  provider: string;
  /** They answered, and the answer was an error (`node_errors_total`). */
  answeredWithError: number;
  /** We could not get an answer at all (`rpc_endpoint_total_errored`). */
  unreachable: number;
  /** Distinct chains on which this provider produced either kind. */
  chainsAffected: number;
  /** Per chain, worst first. `errorRate` is null when the chain served none. */
  chains: {
    spec: string;
    name: string;
    answeredWithError: number;
    unreachable: number;
    relaysServiced: number;
    /** unreachable ÷ (serviced + unreachable) — reachability, 0..1. */
    errorRate: number | null;
  }[];
}

export interface ProviderFaultsReport {
  /** Presence of the per-provider families at read time. */
  emitted: { nodeErrors: boolean; endpointErrored: boolean };
  providers: ProviderFault[];
}

/**
 * A named diagnosis, not a number — what is wrong and what to do about it.
 *
 * The point is to close the gap the raw panels leave. "blockdaemon: 37,292
 * failed relays on Solana testnet" makes an SRE go read logs; "blockdaemon is
 * over its rate limit, every failure is a 429, you sustained 6/s before being
 * throttled" ends the investigation.
 *
 * `confidence` is load-bearing and never cosmetic. Error KINDS come from
 * `smartrouter_errors_total`, which carries `chain_id` but NO provider label,
 * while per-provider failure COUNTS come from the endpoint families. So
 * attributing a kind to a provider is an INFERENCE: sound when one provider
 * owns nearly all of the chain's failures, guesswork when several share them.
 * `attributed` says which case this is; the UI must word itself accordingly.
 */
export interface ProviderInsight {
  kind: "rate-limited" | "method-unsupported" | "unreachable" | "answering-errors";
  severity: "critical" | "warning" | "info";
  spec: string;
  /** Null when the chain's failures are spread too thin to name one upstream. */
  provider: string | null;
  /**
   * True when `provider` was proven to own the failures (it holds the dominant
   * share of the chain's failed relays); false when the finding is chain-level
   * and the provider column would be a guess.
   */
  attributed: boolean;
  /** One plain sentence: the finding. */
  headline: string;
  /** The numbers behind it, already worded. */
  detail: string;
  /** Requests involved — the thing being counted. */
  affected: number;
}

export interface ErrorsReport {
  /** Derived: clamp_min(total − success, 0). Real math, not a synthetic. */
  total: number;
  trend: TimePoint[];
  hotspots: ErrorHotspot[];
  pivots: {
    chain: ErrorPivotRow[];
    method: ErrorPivotRow[];
    /** Populated only when the labelled error counters are emitted. */
    category: ErrorPivotRow[];
    code: ErrorPivotRow[];
    retryability: ErrorPivotRow[];
  };
  /** Presence of the optional error families at read time. */
  families: {
    requestsFailedTotal: boolean;
    nodeErrorsTotal: boolean;
    protocolErrorsTotal: boolean;
  };
}

/* ── Traffic tab panels ──────────────────────────────────────────────────── */

export interface CrossValidationReport {
  emitted: boolean;
  rounds: number | null;
  consensusRate: number | null;
  /** Rounds that failed with reason="no-agreement" (true disagreements). */
  disagreements: number | null;
  /** Failure breakdown from cross_validation_failures_total{reason}. */
  failuresByReason: { reason: string; count: number }[];
  byChain: {
    spec: string;
    rounds: number;
    consensusRate: number | null;
    disagreements: number;
  }[];
  /**
   * consistency_* IS real on this build. `total` = checks run (reads that
   * enforced a minimum seen block); `caught` = checks that FAILED
   * (consistency_failed_total; 0 when the family never fired). NOTE:
   * consistency_success_total counts checks that PASSED — it must never be
   * displayed as "stale caught".
   */
  consistency: { total: number; caught: number };
}

export interface WebSocketReport {
  emitted: boolean;
  activeConnections: number | null;
  subscriptions: number | null;
  subscriptionErrors: number | null;
  /** `active` is the live per-chain gauge (ws_connections_active by spec). */
  byChain: { spec: string; active: number; subscriptions: number; errors: number }[];
}

/** Read/write/batch rollup for the MethodBreakdown class tabs. */
export interface MethodClassTotals {
  read: number;
  write: number | null;
  batch: number | null;
  unclassified: number;
  emitted: { write: boolean; batch: boolean };
}

/* ── Router topology (values-file config, both formats) ─────────────────── */

export interface RouterNodeEndpoint {
  /** Sanitized to scheme+host — upstream paths often embed API keys. */
  urlHost: string;
  interface: string;
  addons: string[];
  /**
   * Position within the owning node's `endpoints` array — the opaque handle
   * `POST /api/upstreams/relay` resolves back to the FULL (credentialed) url
   * server-side. The dashboard never ships that url to the browser, so this
   * index is how the UI names an upstream endpoint it wants dialed directly.
   */
  index: number;
  /**
   * Whether the api can dial this endpoint directly on the user's behalf.
   * True for http(s) and ws(s) urls; false for grpc(s), which needs a gRPC
   * client the relay doesn't carry.
   */
  directable: boolean;
  /**
   * The `internal-path` this node-url is pinned to (`/v2`), or null when it
   * serves the spec's root path. A provider whose versions live on different
   * hosts declares one node-url per internal path, and since `urlHost` is
   * masked to scheme+host those rows are otherwise indistinguishable.
   */
  internalPath: string | null;
}

export interface RouterNode {
  name: string;
  isBackup: boolean;
  endpoints: RouterNodeEndpoint[];
}

/**
 * One router (chain) from the mounted values file — normalized from EITHER
 * the helm-chart `routers:` format OR the router's own SR_CONFIG
 * (`endpoints:` + `direct-rpc:`) format.
 */
export interface RouterTopology {
  id: string;
  /** Prometheus spec label correlation (ETH1, SOLANA, …). */
  spec: string;
  network: string;
  pathBased: boolean;
  customUrlPrefix: string | null;
  /** First interface's local listen port (SR_CONFIG only). */
  localPort: number | null;
  /** api-interface → local listen port (SR_CONFIG only). */
  localPorts: Record<string, number>;
  /**
   * api-interface → public base URL served by the Gateway (helm values only,
   * and only when `miscellaneous.gateway.enabled`). Mirrors the host-based
   * HTTPRoute/GRPCRoute hostname scheme; empty when the mounted
   * config gives no routable address (SR_CONFIG mounts, gateway disabled).
   */
  publicUrls: Record<string, string>;
  interfaces: string[];
  nodes: RouterNode[];
}

/* ── Direct-to-upstream relay (bypasses the router) ─────────────────────── */

/**
 * Which configured upstream endpoint to dial. NOT a url — the browser never
 * holds one, because `maskNodeUrl` strips the path/query where upstream API
 * keys live. The api resolves this triple against the same mounted values
 * file it serves the topology from.
 */
export interface UpstreamEndpointRef {
  routerId: string;
  /** Node name (`eth-publicnode`) — unique per router in the values file. */
  node: string;
  endpointIndex: number;
}

export interface UpstreamRelayRequest extends UpstreamEndpointRef {
  httpMethod: "GET" | "POST";
  /** REST only — appended to the resolved url's path, never replacing it. */
  path?: string;
  body?: unknown;
  /** `ws` opens a single-shot WebSocket, sends `body`, resolves on the reply. */
  transport?: "http" | "ws";
}

export interface UpstreamRelayResponse {
  /** The UPSTREAM's status code — the relay itself answers 200 even when the
   *  upstream errors, so the drawer renders the upstream's own body. Null on
   *  the ws transport (no HTTP status in a socket reply). */
  httpStatus: number | null;
  /** Measured around the api→upstream call. NOT comparable to the browser's
   *  round-trip against the router — a different pair of hops. */
  latencyMs: number;
  body: unknown;
  /** Set when the upstream body exceeded the relay's size cap. */
  truncated: boolean;
  transport: "http" | "ws";
}

/* ── Ops Dashboard page (2-tab surface: Overview + Metrics) ──────────────── */

/** One per-chain series (requests / success-rate / latency per chain). */
export interface DashboardChainSeries {
  spec: string;
  name: string;
  color: string;
  points: TimePoint[];
}

/** One per-upstream series (upstream mix, per-upstream latency). */
export interface DashboardUpstreamSeries {
  /** provider_address / endpoint_id — the resolved upstream name. */
  upstream: string;
  points: TimePoint[];
}

/** Chain entry for the DashHeader multiselect (series filter is client-side). */
export interface DashboardChainMeta {
  spec: string;
  name: string;
  color: string;
  health: HealthState;
}

/**
 * Troublesome (chain, client) pair row. The list stays EMPTY until the router
 * emits labelled error/failover counters — never synthesised from mocks.
 */
export interface DashboardTroubleRow {
  chain: string;
  client: string;
  failoverPct: number | null;
  sr: number | null;
  p95: number | null;
  baselineRatio: number | null;
  failoverCount: number | null;
  topErr: string | null;
  topProv: string | null;
  upstreams: string[];
}

/** Upstream scorecard row (§18) — whole table null until backed. */
export interface DashboardScorecardRow {
  name: string;
  avail: number | null;
  p95: number | null;
  syncLagBlocks: number | null;
  qos: number | null;
  incident: string | null;
}

/** Per-upstream availability row (§11) — deg/incident have no metric family. */
export interface DashboardUpstreamAvailRow {
  name: string;
  chain: string | null;
  ok: number | null;
  deg: number | null;
  fail: number | null;
  incident: string | null;
  internal: boolean | null;
}

/** A labelled stacked layer (error classes, errors-handled interventions). */
export interface DashboardStackLayer {
  label: string;
  color: string;
  points: TimePoint[];
}

/**
 * Payload for the Dashboard page (Overview + Metrics tabs) in one round-trip.
 *
 * Contract: real families are computed from live `smartrouter_*` /
 * `rpc_endpoint_*` series; families the router does not emit are `null`
 * (the UI renders the design's own empty states) — values are NEVER invented.
 */
export interface DashboardData {
  kpis: {
    /** Availability ratio 0..1 (success/total over the window). */
    successRate: Kpi;
    p95Ms: Kpi;
    /** Derived error count (total − success, clamped ≥ 0). */
    errors: Kpi;
    /** Requests/sec now (5m rate) vs the prior window. */
    rps: Kpi;
    /** "Errors Handled" needs failover/hedge/retry counters — null on this build. */
    errorsHandled: Kpi;
  };
  series: {
    throughput: TimePoint[];
    /** Derived errors per bucket — the single honest "unclassified" series. */
    errors: TimePoint[];
    /** Derived error-rate ratio series (0..1) — feeds the by-class stack's
     *  single "unclassified" layer until labelled error counters exist. */
    errorRate: TimePoint[];
    /** Availability ratio series (0..1) — the Success Rate KPI spark. */
    successRate: TimePoint[];
    latency: { p50: TimePoint[]; p95: TimePoint[]; p99: TimePoint[] };
    perChain: DashboardChainSeries[];
    /** Per-chain availability ratio series (0..1). */
    perChainSuccessRate: DashboardChainSeries[];
    perChainLatency: {
      p50: DashboardChainSeries[];
      p95: DashboardChainSeries[];
      p99: DashboardChainSeries[];
    };
    /** Per-provider RPS (router counter, provider_address label). */
    upstreamMix: DashboardUpstreamSeries[];
    /** Per-upstream p95 (endpoint histogram, endpoint_id label). */
    perUpstreamLatencyP95: DashboardUpstreamSeries[];
  };
  /** Chains currently emitting metrics (header multiselect options). */
  chains: DashboardChainMeta[];
  /** Compute-unit quota is a Magma Cloud concept — not metered here. */
  scu: { used: number; quotaPct: number } | null;
  /** No region label on any series — null. */
  regions: { id: string; label: string; color: string; points: TimePoint[] }[] | null;
  /** No failover counter family — null. */
  failoverRatio: TimePoint[] | null;
  /** Needs internal-vs-fallback classification + failover math — null. */
  internalAvailability: TimePoint[] | null;
  /** cache_total_hits/misses absent until the cache fires — null. */
  cacheHitRate: TimePoint[] | null;
  /** Labelled error-class layers — null until node/protocol counters exist
   *  (series.errorRate carries the single derived "unclassified" layer). */
  errorClasses: DashboardStackLayer[] | null;
  /** Intervention-category breakdown (failover/hedge/consistency/cache) — null. */
  errorsHandledBreakdown: DashboardStackLayer[] | null;
  /** "SR without Smart Router" counterfactual is not computable — null. */
  contribution: {
    srWith: number;
    srWithout: number;
    savedPts: number;
    perfPct: number;
  } | null;
  upstreamAvailability: DashboardUpstreamAvailRow[] | null;
  scorecard: DashboardScorecardRow[] | null;
  /** Empty until labelled error counters exist (design's ✓ empty state). */
  trouble: DashboardTroubleRow[];
  lastUpdated: string | null;
}
