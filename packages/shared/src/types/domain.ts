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
 * What the HeroPanel's cards read. Real: requests, success rate, effective
 * read p95 (returned, no longer shown: its card is "Failed requests", from
 * `GET /api/error-requests/count`), stale caught. Null until the router emits
 * the family: retries, cache.
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

/**
 * What identifies ONE upstream: its name on ONE chain. Vendors reuse a node
 * name on every chain they serve (`blockdaemon` backs ~25 specs on one
 * deployment), so the name alone addresses all of them at once — and a query
 * keyed by it silently sums every chain together.
 */
export interface UpstreamRef {
  spec: string;
  endpointId: string;
}

/**
 * The time axis a chart's series were sampled on, unix seconds: a point at
 * every `start + k·stepSec` up to `end`. A chart lays points out by time on
 * it, so a stretch with no data shows as a gap instead of being squeezed out.
 */
export interface ChartGrid {
  start: number;
  end: number;
  stepSec: number;
}

/**
 * Every upstream of one chain side by side, for the charts that read an
 * upstream against its peers: p95 latency, requests per second and the tip
 * it reports, over the window - sampled on `grid`. One series per upstream;
 * an upstream with no requests at a point has no latency there, which the
 * chart draws as a gap.
 */
export interface UpstreamPeers {
  spec: string;
  /** Every read answered. False: one failed or timed out, so an empty series means nothing. */
  available: boolean;
  grid: ChartGrid;
  upstreams: { upstream: string; latencyP95: TimePoint[]; rps: TimePoint[]; latestBlock: TimePoint[] }[];
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
  /**
   * Errors per bucket, on the clock (`bucketGrid`): `failed` = tries with no
   * usable answer (requests minus successes), `node` = JSON-RPC error replies
   * (null until that family fires). A bucket at `t` covers the
   * `grid.stepSec` seconds before it, and the last one - still filling -
   * only up to `asOf` (unix seconds, when this was read). That span is what
   * the Errors tab reads when a bar is clicked.
   */
  errorsOverTime: { grid: ChartGrid; failed: TimePoint[]; node: TimePoint[] | null; asOf: number };
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

/* ── Retry counters (the Errors tab's cards) ─────────────────────────────── */

/** The Errors tab's count cards - the router's retry counters (Prometheus). */
export interface RetriesReport {
  /**
   * The retry counters exist. The router creates them on its first retry, so
   * `false` means "no retry recorded yet" - every retry value is then null.
   */
  emitted: boolean;
  retried: number | null;
  recovered: number | null;
  failed: number | null;
  /** recovered ÷ retried (0..1). */
  recoveryRate: number | null;
  /** retried ÷ client requests (0..1). */
  retryRate: number | null;
  /** Mean extra attempts per retried request. */
  avgExtraAttempts: number | null;
}

/**
 * One try at one upstream, in the order the router made them - a retried
 * request's tries one after another, or a transaction's broadcast all at once.
 */
export interface RelayAttempt {
  upstream: string;
  /** Which choice of upstreams it went out in, from 0: tries in one batch went out together. */
  batch: number;
  /**
   * - `ok`        - it answered without an error
   * - `failed`    - it answered with an error, or not usefully (timeout, 429 …)
   * - `skipped`   - chosen, then passed over: behind the chain head the request needs
   * - `cancelled` - the router called it off: another try had already answered,
   *                 or the app stopped waiting. Not an error.
   * - `no-result` - sent, and the logs show no answer (overtaken, or cut off)
   */
  outcome: "ok" | "failed" | "skipped" | "cancelled" | "no-result";
  /** Its reply is the one that went back to the client. */
  replied: boolean;
  /** The router's error code, e.g. NODE_RATE_LIMITED; null when it gave none. */
  code: string | null;
  /**
   * The router's own verdict on the error - could another upstream help? A
   * rate limit or a timeout is retryable; invalid params or a pruned state the
   * chain itself gave are not. Null when its log line doesn't say.
   */
  retryable: boolean | null;
  /** What the upstream or the router said, word for word. */
  message: string | null;
  /**
   * Why the router passed it over, or sent to it anyway - the router's
   * reasoning, never an error. E.g. "Passed over: 154 blocks behind the chain
   * head (up to 10 allowed)."
   */
  note: string | null;
  /** ms from the request's arrival to the try going out. */
  atMs: number;
  /** ms from the request's arrival to its answer or its failure; null when the logs show neither. */
  endMs: number | null;
}

/** One request that hit an error - a try failed, or the router gave up - rebuilt from the router's log lines. */
export interface ErrorRequestRow {
  /** The router's request id (`Lava-Guid`). */
  guid: string;
  /** When the router received it, unix ms. */
  time: number;
  /** Chain: the one the logs name, else the only chain serving every upstream it used; null when neither says. */
  spec: string | null;
  /** With `spec` null: the chains it could be on, when its upstreams serve several. */
  specs?: string[];
  /** JSON-RPC method, or the REST path; `unknown` when the logs don't say, `(path redacted)` when a log collector masked it. */
  method: string;
  attempts: RelayAttempt[];
  /**
   * What the app got:
   * - `ok`          - an upstream answered without an error, and nothing
   *                   failed on the way (only a look-up by ID shows these)
   * - `recovered`   - an upstream answered without an error, after one had failed
   * - `error-reply` - the reply that went back was an upstream's error
   * - `failed`      - no usable reply at all
   * - `unknown`     - the logs show no end
   */
  result: "ok" | "recovered" | "error-reply" | "failed" | "unknown";
  /** The upstream whose reply went back. */
  resolvedBy: string | null;
  /** The router tried another upstream: more than one batch of tries went out. */
  retried: boolean;
  /**
   * Why the router stopped, in its own words (`stop_reason` on its "relay
   * finished" line): Success, NonRetryableNodeError, AllProvidersExhausted,
   * ProcessingTimeout, Stateful, … Null when the logs show no end.
   */
  stopReason: string | null;
  /** The router wanted another try and had no upstream left to send it to. */
  exhausted: boolean;
  totalMs: number | null;
  /** The router's own error, for `failed`. */
  error: string | null;
}

/** Why the router's logs couldn't be read: no log store configured, or it didn't answer in time. */
export type LogUnavailable = "unconfigured" | "unreachable";

/** One request looked up by its ID - any request, whatever happened to it. `row` null: not in the logs of the range read. */
export interface RequestLookup {
  available: boolean;
  reason?: LogUnavailable;
  row: ErrorRequestRow | null;
}

/**
 * Client requests the router could not serve in a window: nothing, or
 * nothing usable, came back from the upstreams, so the router returned its
 * own error. Counted from the router's logs; `available:false` and a null
 * value when they can't be read, or (`shared-chain`) when a router was asked
 * for on a chain other routers serve too - the lines don't say which router
 * wrote them.
 */
export interface FailedRequests {
  available: boolean;
  reason?: LogUnavailable | "shared-chain";
  value: number | null;
}

/** The Errors tab's request list - from the router's logs (Loki), newest first, one read at a time. */
export interface ErrorRequestsReport {
  /** The router's logs could be read (LOKI_URL set, and Loki answered). */
  available: boolean;
  reason?: LogUnavailable;
  /** Newest first. */
  rows: ErrorRequestRow[];
  /** The range holds older requests than these: read on with `before=nextBefore`. */
  more: boolean;
  /** Unix ms the next, older read ends at (with its fraction - pass it back as is); null without `more`. */
  nextBefore: number | null;
}

/* ── Transactions tab ────────────────────────────────────────────────────── */

/**
 * How a transaction ended, as the client saw it:
 *  - `accepted` - the upstream that answered took it (in its pending pool; not yet in a block)
 *  - `rejected` - that upstream answered with an error, e.g. nonce too low
 *  - `failed`   - no usable answer: the router returned an error of its own
 *  - `unknown`  - the logs can't say: no end in them, a write the router
 *                 itself can't tell went through, or a chain that puts a
 *                 refusal inside a normal reply the router doesn't log (`note`)
 */
export type TxOutcome = "accepted" | "rejected" | "failed" | "unknown";

export interface TxLogRow {
  /** The router's request id (`Lava-Guid`); every log line of the request carries it. */
  guid: string;
  /** When the router received it, unix ms. */
  time: number;
  /** Chain: the one the logs name, else the only chain serving every upstream it went to; null when neither says. */
  spec: string | null;
  /** With `spec` null: the chains it could be on, when its upstreams serve several. */
  specs?: string[];
  /** JSON-RPC method, or the REST path. */
  method: string;
  /** Every upstream the router sent it to - all in one batch, for a broadcast - and what each answered. */
  attempts: RelayAttempt[];
  /** The upstream whose reply went back to the client. */
  answeredBy: string | null;
  /** Time until that reply, ms - not time until a block, which needs the chain. */
  replyMs: number | null;
  outcome: TxOutcome;
  /** The reply's error, for `rejected` and `failed`. */
  error: { code: string; message: string } | null;
  /** Why the outcome is `unknown`, in plain words; null otherwise. */
  note: string | null;
}

/**
 * One transaction looked up by its request ID. `found` says the logs hold the
 * request at all - with `row` null, it was found but isn't a transaction.
 */
export interface TransactionLookup {
  available: boolean;
  reason?: LogUnavailable;
  found: boolean;
  row: TxLogRow | null;
}

export interface TransactionsReport {
  /**
   * The router's logs could be read. False when no log store is configured
   * (LOKI_URL) or it did not answer - everything below is then empty.
   */
  available: boolean;
  reason?: LogUnavailable;
  total: number;
  accepted: number;
  rejected: number;
  failed: number;
  /** accepted ÷ (accepted + rejected + failed); `unknown` is left out. Null with none. */
  successRate: number | null;
  /** Newest first. */
  rows: TxLogRow[];
  /** The range holds older transactions than these: read on with `before=nextBefore`. Every number above covers `rows` only. */
  more: boolean;
  /** Unix ms the next, older read ends at (with its fraction - pass it back as is); null without `more`. */
  nextBefore: number | null;
}

/* ── Cross-validation / WebSocket reports (no screen reads them) ── */

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
