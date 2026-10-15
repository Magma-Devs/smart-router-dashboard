/**
 * The recorded series the fleet store's ruler evaluates once a minute in every
 * tenant's org (devops-magmadevs, `components/smart-router-fleet-mimir/configs/
 * recording-rules.yaml`), and the policy that decides when a builder reads
 * them instead of the raw families.
 *
 * Every recorded series is a two-minute rate of one counter family, summed to
 * `cluster, chain, spec, router` and at most one more label. A window total is
 * `sum_over_time(rule[W]) * RECORDED_INTERVAL_SECONDS` (one sample a minute,
 * each a per-second rate); a ratio is the ratio of two such sums; a quantile is
 * `histogram_quantile` over the summed bucket rates; a series point is
 * `avg_over_time(rule[step])`, the mean rate across the step. A 2-minute rate
 * smooths one minute of edge per window, so a total sits within about 1% of a
 * raw `increase()` at three hours and under 0.2% at a day — which is why the
 * policy has a floor: windows under it stay on raw reads, exact and cheap.
 *
 * The policy is process-wide state, set by the api (`plugins/prometheus.ts`)
 * from `METRICS_RECORDED_FROM` and a freshness probe: when the recorded
 * series are missing or stale — the ruler not deployed, stopped, or behind —
 * every builder falls back to raw. Slow again, never wrong.
 */
import { WINDOWS, type MetricWindow } from "../constants/windows.js";

/** The ruler's evaluation interval. Coupled to `interval: 1m` in the rules file. */
export const RECORDED_INTERVAL_SECONDS = 60;

/** Recorded series names, `level:family:operation`. */
export const RECORDED = {
  /** Client requests served (histogram _count), by spec, router. */
  clientRequests: "spec_router:smartrouter_end_to_end_latency_milliseconds_count:rate2m",
  /** Relays, by spec, router. */
  requests: "spec_router:smartrouter_requests_total:rate2m",
  /** Successful relays, by spec, router. */
  success: "spec_router:smartrouter_requests_success_total:rate2m",
  /** Router latency histogram buckets, by spec, router, le. */
  latencyBucket: "spec_router_le:smartrouter_end_to_end_latency_milliseconds_bucket:rate2m",
  /** Relays by spec, router, provider_address. */
  requestsByProvider: "spec_router_provider:smartrouter_requests_total:rate2m",
  /** Successful relays by spec, router, provider_address. */
  successByProvider: "spec_router_provider:smartrouter_requests_success_total:rate2m",
  /** Relays by spec, router, method. */
  requestsByMethod: "spec_router_method:smartrouter_requests_total:rate2m",
  /** Successful relays by spec, router, method. */
  successByMethod: "spec_router_method:smartrouter_requests_success_total:rate2m",
  /** Read relays by spec, router, method. */
  readByMethod: "spec_router_method:smartrouter_requests_read_total:rate2m",
  /** Upstream latency histogram buckets, by spec, router, endpoint_id, le. */
  endpointLatencyBucket: "spec_endpoint_le:rpc_endpoint_end_to_end_latency_milliseconds_bucket:rate2m",
  /** Relays served per upstream, by spec, router, endpoint_id. */
  endpointRelays: "spec_endpoint:rpc_endpoint_total_relays_serviced:rate2m",
  /** Relays errored per upstream, by spec, router, endpoint_id. */
  endpointErrored: "spec_endpoint:rpc_endpoint_total_errored:rate2m",
} as const;

const RECORDED_NAMES: ReadonlySet<string> = new Set(Object.values(RECORDED));

/** True for a recorded series name — the scope rewriter treats these as router series. */
export function isRecordedMetric(name: string): boolean {
  return RECORDED_NAMES.has(name);
}

/** The read policy: `from` is the narrowest window read from recorded series; `available` says the series are fresh. */
export interface RecordedReadsPolicy {
  from: MetricWindow | null;
  available: boolean;
}

let policy: RecordedReadsPolicy = { from: null, available: false };

/** Replace the policy. The api sets it at boot and on every freshness probe; tests reset it. */
export function setRecordedReads(next: RecordedReadsPolicy): void {
  policy = { from: next.from, available: next.available };
}

/** The current policy, as last set. */
export function recordedReadsPolicy(): RecordedReadsPolicy {
  return { ...policy };
}

/** Whether a builder should read the recorded series for this window. */
export function recordedReadsFor(window: MetricWindow): boolean {
  if (policy.from === null || !policy.available) return false;
  return WINDOWS[window].rangeSeconds >= WINDOWS[policy.from].rangeSeconds;
}
