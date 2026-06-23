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
  inFlight: number;
}

/** Hero cards on the Overview tab. Any field is null when unbacked. */
export interface DashboardSummary {
  requestsServed: number;
  successRate: number | null;
  effectiveReadP95Ms: number | null;
  staleResponsesCaught: number | null;
  providerCount: number;
  chainCount: number;
  health: HealthState;
  lastUpdated: string | null;
}

export interface RouterConfigNode {
  name: string;
  url: string;
  addons: string[];
}

export interface RouterConfig {
  spec: string;
  apiInterface: string;
  listenPort: number | null;
  nodes: RouterConfigNode[];
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

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

export interface MetricsQuery {
  spec?: string;
  window: MetricWindow;
}
