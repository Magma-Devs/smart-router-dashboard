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
   * Config routers that declare this upstream — `[]` when no values file is
   * mounted, one id normally, SEVERAL when routers share a node name.
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
