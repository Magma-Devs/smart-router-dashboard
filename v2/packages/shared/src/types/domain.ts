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
  providerCount: number;
}

/** Per backing-endpoint roster row. */
export interface ProviderMetrics {
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
  /** From config `is_backup` (helm format only); null for SR_CONFIG. */
  role: "primary" | "backup" | null;
  apiInterface: string | null;
  inFlight: number;
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
  /** Per-provider throughput stack (real via the provider_address label). */
  perProviderSeries: { provider: string; points: TimePoint[] }[];
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
  providerCount: number;
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
  /** Share of traffic on backup providers; null unless config marks backups. */
  backupShare: TimePoint[] | null;
}

/* ── Provider deep-dive (Metrics · Providers tab, PMBody) ────────────────── */

export interface ProviderErrorCode {
  code: string;
  count: number;
  lastSeen: string | null;
}

export interface ProviderRecentError {
  at: string;
  method: string | null;
  code: string | null;
  message: string;
}

export interface ProviderDetail {
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
  /** Empty + emitted:false until node/protocol error counters exist. */
  errorsByCode: ProviderErrorCode[];
  recentErrors: ProviderRecentError[];
  emitted: { errorsByCode: boolean; recentErrors: boolean };
}

/* ── Errors breakdown tab ────────────────────────────────────────────────── */

export interface ErrorHotspot {
  spec: string;
  name: string;
  color: string;
  provider: string;
  errors: number;
  requests: number;
  errorRate: number | null;
  trend: TimePoint[];
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
  disagreements: number | null;
  byChain: { spec: string; rounds: number; consensusRate: number | null }[];
  /** consistency_* IS real on this build — surfaced under its own name. */
  consistency: { total: number; caught: number };
}

export interface WebSocketReport {
  emitted: boolean;
  activeConnections: number | null;
  subscriptions: number | null;
  subscriptionErrors: number | null;
  byChain: { spec: string; subscriptions: number; errors: number }[];
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
  interfaces: string[];
  nodes: RouterNode[];
}

/* ── Ops Dashboard page (2-tab surface: Overview + Metrics) ──────────────── */

/** One per-chain series (requests / success-rate / latency per chain). */
export interface DashboardChainSeries {
  spec: string;
  name: string;
  color: string;
  points: TimePoint[];
}

/** One per-provider series (provider mix, per-provider latency). */
export interface DashboardProviderSeries {
  /** provider_address / endpoint_id — the resolved provider name. */
  provider: string;
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
  providers: string[];
}

/** Provider scorecard row (§18) — whole table null until backed. */
export interface DashboardScorecardRow {
  name: string;
  avail: number | null;
  p95: number | null;
  syncLagBlocks: number | null;
  qos: number | null;
  incident: string | null;
}

/** Per-provider availability row (§11) — deg/incident have no metric family. */
export interface DashboardProviderAvailRow {
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
    providerMix: DashboardProviderSeries[];
    /** Per-provider p95 (endpoint histogram, endpoint_id label). */
    perProviderLatencyP95: DashboardProviderSeries[];
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
  providerAvailability: DashboardProviderAvailRow[] | null;
  scorecard: DashboardScorecardRow[] | null;
  /** Empty until labelled error counters exist (design's ✓ empty state). */
  trouble: DashboardTroubleRow[];
  lastUpdated: string | null;
}
