/**
 * Domain logic: turn Prometheus query results into the typed shapes the web
 * consumes. Every value maps to a real `smartrouter_*`/`rpc_endpoint_*` series;
 * unbacked values are returned as null (never invented) — this honours the
 * design doc's "no synthetic data" rule.
 */
import {
  ENDPOINT_METRICS,
  OPTIONAL_METRICS,
  ROUTER_METRICS,
  buildChainMetaByIndex,
  qAvailability,
  qClientRequestsBy,
  qClientRequestsTotal,
  qClientRps,
  qClientRpsSeriesExpr,
  qConsistencyCaught,
  qErrorCount,
  qErrorCountSeriesExpr,
  qErrorsBy,
  qEndpointRelaysBySpec,
  qEndpointLatencyQuantileBySpec,
  qUpstreamRelays,
  qUpstreamSuccesses,
  qReadRequestsByMethod,
  qPerUpstreamRpsExpr,
  qGroupedAvailability,
  qGroupedClientRequests,
  qGroupedHealth,
  qGroupedLatencyQuantile,
  qGroupedLatestBlock,
  qGroupedQos,
  qGroupedUpstreams,
  qLatencyDistribution,
  qLatencyQuantile,
  qLatencySeriesExpr,
  qRetriesTotal,
  qBestTipBySpec,
  qBlockRateBySpec,
  qEndpointPolls,
  qOptimizerScoresByEndpoint,
  qMethodLatencyQuantile,
  qPerSpecClientRpsSeriesExpr,
  qPerSpecHealth,
  qPerSpecLatencyQuantile,
  qPresence,
  qRequestsBy,
  qRouterTipChanges,
  qRouterTips,
  qTipChanges,
  qUpstreamTips,
  TIP_WINDOW_SECONDS,
  selector,
  rangeFor,
  type BlockHeights,
  type ChainMetrics,
  type DeploymentPulse,
  type GroupBy,
  type RouterMetrics,
  type ChainTips,
  type HealthState,
  type HeroSummary,
  type Kpi,
  type MethodClassTotals,
  type MethodUsage,
  isValidScopeLabel,
  type MetricWindow,
  type RouterTip,
  type UpstreamMetrics,
  type UpstreamTip,
  type ScoreType,
  type TimeSeries,
} from "@sr/shared";
import { WINDOWS, alignedBounds, stepSeconds } from "@sr/shared/constants";
import type { PrometheusClient, PromVectorSample } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import { readUpstreamHealth } from "./upstream-health.js";

export function health(value: number | null): HealthState {
  if (value === null || !Number.isFinite(value)) return "unknown";
  return value >= 1 ? "operational" : "unhealthy";
}

/**
 * A tip gauge is STALE when it never moved over the staleness window *and* the
 * chain was fast enough to have produced blocks in it.
 *
 * The second clause is what keeps slow chains honest: Bitcoin averages a block
 * every ~9 minutes, so a frozen-looking gauge is its normal resting state and
 * flagging it would cry wolf on every poll. Requiring ≥ 2 expected blocks means
 * only a chain that should visibly have advanced can be called stuck. Unknown
 * inputs are never stale — absence of evidence isn't evidence of a freeze.
 */
export function isStale(changes: number | undefined, blocksPerSec: number | undefined): boolean {
  if (changes === undefined || blocksPerSec === undefined || blocksPerSec <= 0) return false;
  return changes === 0 && blocksPerSec * TIP_WINDOW_SECONDS >= 2;
}

/** Prometheus matrix `values` → typed points (null when the bucket is empty). */
export function toPoints(
  values: [number, string][] | undefined,
): { t: number; v: number | null }[] {
  if (!values) return [];
  return values.map(([t, v]) => {
    const n = Number(v);
    return { t, v: Number.isFinite(n) ? n : null };
  });
}

/**
 * Reindex a Prometheus matrix row onto the SHARED (start, end, step) grid.
 *
 * `query_range` trims timestamps a series has no data for, so two chains that
 * started emitting at different times come back with different point counts.
 * Multi-series charts x-map by index and assume equal lengths — mismatched
 * lengths render as garbage. This snaps every series to the same grid, filling
 * absent buckets with null (an honest gap, not an invented value).
 */
export function toGridPoints(
  values: [number, string][] | undefined,
  start: number,
  end: number,
  step: number,
): { t: number; v: number | null }[] {
  const byT = new Map<number, number | null>();
  for (const [t, v] of values ?? []) {
    const n = Number(v);
    // Snap the sample to its nearest grid bucket (prom timestamps can drift a
    // few ms off the exact step multiple).
    const bucket = start + Math.round((t - start) / step) * step;
    byT.set(bucket, Number.isFinite(n) ? n : null);
  }
  const out: { t: number; v: number | null }[] = [];
  for (let t = start; t <= end + 1; t += step) {
    out.push({ t, v: byT.has(t) ? byT.get(t)! : null });
  }
  return out;
}

/** The chain-level figures `chainFigures()` reads — a `ChainMetrics` row minus the chain's identity. */
type ChainFigures = Omit<ChainMetrics, "spec" | "name" | "color">;

/** What a chain or router shows when no grouped row covers it: the nulls a missing read always gave. */
const NO_FIGURES: ChainFigures = {
  requests: 0,
  availability: null,
  errorRate: null,
  p95Ms: null,
  qos: null,
  health: "unknown",
  latestBlock: null,
  upstreamCount: 0,
};

/** Labels the grouped reads already key or aggregate on — none can double as the target label. */
const GROUPED_LABELS: ReadonlySet<string> = new Set(["spec", "le", "endpoint_id"]);

/** Map key for one group's label values (`["ETH1"]`, `["ETH1", "eth-router"]`). */
const groupKey = (values: readonly string[]): string => values.join("\u0000");

/** Instant vector → `spec` label → finite value. Rows without either are dropped. */
function valuesBySpec(rows: PromVectorSample[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const n = Number(row.value[1]);
    if (row.metric.spec && Number.isFinite(n)) out.set(row.metric.spec, n);
  }
  return out;
}

export class MetricsService {
  constructor(
    private readonly prom: PrometheusClient,
    private readonly configSvc?: ConfigurationService,
  ) {}

  /** Distinct spec labels currently present on the requests counter. */
  async listSpecs(): Promise<string[]> {
    const rows = await this.prom.query(`count by (spec) (${ROUTER_METRICS.requestsTotal})`);
    return rows
      .map((r) => r.metric.spec)
      .filter((s): s is string => Boolean(s))
      .sort();
  }

  /**
   * Distinct values of the router-scope target label — the deployments this
   * Prometheus can tell apart. Empty when the collector attaches no such
   * label (one static scrape target, or a mislabelled `ROUTER_SCOPE_LABEL`):
   * the aggregation then returns a single row with the label absent, which
   * filters out. Empty means "can't split", never "no routers".
   */
  async listRouterScopes(label: string): Promise<string[]> {
    if (!isValidScopeLabel(label)) return [];
    const rows = await this.prom.query(`count by (${label}) (${ROUTER_METRICS.requestsTotal})`);
    return [...new Set(rows.map((r) => r.metric[label]).filter((v): v is string => Boolean(v)))].sort();
  }

  /** Per-chain health from the ENDPOINT gauge (the router gauge is label-less
   *  — using it per chain shows every chain with the same status). */
  private async chainHealth(spec: string): Promise<number | null> {
    return this.prom.scalar(qPerSpecHealth(spec));
  }

  /** True when the optional family is registered on this build. */
  private async familyPresent(metricName: string): Promise<boolean> {
    const v = await this.prom.scalar(qPresence(metricName));
    return v !== null && v > 0;
  }

  /**
   * The six HeroPanel cards (Metrics · Overview tab).
   *
   * One round: every read goes out at once and nothing waits on an earlier
   * answer. The optional families (retries, cache, consistency failures) are
   * read whether or not their presence probes find them — a read of an
   * absent family matches no series and costs the store nothing — and the
   * probes decide afterwards whether the answer is kept, so the contract
   * holds: absent ⇒ null and emitted:false, never an invented value. Gating
   * those reads behind the probes, then awaiting the retries and cache pairs
   * on their own, made this call four round trips to the store, each waiting
   * for the slowest read of the one before (MAG-4322).
   */
  async dashboardSummary(window: MetricWindow, spec?: string): Promise<HeroSummary> {
    const r = rangeFor(window);
    // Label selector for the metrics that carry a `spec` label, so the hero
    // KPIs scope to the selected chain (empty = account-wide across all chains).
    const specSel = spec ? `{spec="${spec}"}` : "";
    const kpi = async (cur: string, prior: string): Promise<Kpi> => {
      const [value, p] = await Promise.all([this.prom.scalar(cur), this.prom.scalar(prior)]);
      return { value, prior: p };
    };
    // hits / (hits + misses) over the window; `offset` reads the window before.
    const cacheOffload = (offset?: string): string => {
      const o = offset ? ` offset ${offset}` : "";
      const inc = (metric: string) => `sum(increase(${metric}${specSel}[${r}]${o}))`;
      return `${inc(OPTIONAL_METRICS.cacheTotalHits)} / (${inc(OPTIONAL_METRICS.cacheTotalHits)} + ${inc(OPTIONAL_METRICS.cacheTotalMisses)})`;
    };

    const [
      retriesPresent,
      cachePresent,
      consistencyFailedPresent,
      requestsServed,
      successRate,
      p95,
      staleRead,
      retriesRead,
      cacheRead,
      specs,
      upstreams,
      healthGauge,
    ] = await Promise.all([
      this.familyPresent(OPTIONAL_METRICS.retriesSuccessTotal),
      this.familyPresent(OPTIONAL_METRICS.cacheTotalHits),
      this.familyPresent(OPTIONAL_METRICS.consistencyFailedTotal),
      // CLIENT-scoped: the latency-histogram _count increments exactly once
      // per client request. requests_total is relay-scoped (per participant,
      // probes included) — see qRequestsTotal's doc note.
      kpi(qClientRequestsTotal(spec, window), qClientRequestsTotal(spec, window, r)),
      kpi(qAvailability(spec, window), qAvailability(spec, window, r)),
      // No cache on this build ⇒ the documented derived "effective read p95"
      // reduces to the node read p95 (the overall router histogram).
      kpi(qLatencyQuantile(0.95, spec, window), qLatencyQuantile(0.95, spec, window, r)),
      // Stale caught = consistency checks that FAILED. success_total counts
      // checks that PASSED and must never be shown here.
      kpi(qConsistencyCaught(window, undefined, spec), qConsistencyCaught(window, r, spec)),
      // Counted as the Errors tab's retry cards count it, births included.
      kpi(qRetriesTotal("recovered", window, spec), qRetriesTotal("recovered", window, spec, r)),
      kpi(cacheOffload(), cacheOffload(r)),
      this.listSpecs(),
      // `rpc_endpoint_overall_health` carries {spec, apiInterface, endpoint_id}
      // (smartrouter_metrics_manager.go endpointLabels), so it scopes exactly
      // like the KPIs above — `selector` yields "" with no chain selected,
      // which is the account-wide count. Unfiltered, this tile paired a
      // chain-scoped request count with an account-wide upstream count and
      // read "50.0K across 4 upstreams" on a chain that had one (MAG-2710).
      this.prom.query(
        `count by (endpoint_id) (${ENDPOINT_METRICS.overallHealth}${selector({ spec })})`,
      ),
      // Same reasoning for health: the ROUTER gauge is label-less, so under a
      // chain filter it reports the whole deployment. chainHealth() reads the
      // spec-labelled endpoint gauge — see chains()/chainFigures(), which has
      // always done this correctly.
      spec ? this.chainHealth(spec) : this.prom.scalar(ROUTER_METRICS.overallHealth),
    ]);

    // An absent consistency_failed_total family means zero failures since
    // boot, so the honest value is 0 — never the read's null.
    const stale: Kpi = consistencyFailedPresent ? staleRead : { value: 0, prior: 0 };
    const retriesRecovered: Kpi = retriesPresent ? retriesRead : { value: null, prior: null };
    const cacheOffloadPct: Kpi = cachePresent ? cacheRead : { value: null, prior: null };

    return {
      requestsServed,
      successRate,
      effectiveReadP95Ms: p95,
      staleCaught: stale,
      retriesRecovered,
      cacheOffloadPct,
      upstreamCount: upstreams.length,
      // When scoped to one chain, chainCount is 1 (if that spec has traffic).
      chainCount: spec ? (specs.includes(spec) ? 1 : 0) : specs.length,
      health: health(healthGauge),
      emitted: { retries: retriesPresent, cache: cachePresent },
      lastUpdated: new Date().toISOString(),
    };
  }

  async overview(
    window: MetricWindow,
    spec?: string,
    routerId?: string,
  ): Promise<import("@sr/shared").OverviewData> {
    const win = WINDOWS[window];
    const sel = selector({ spec });
    const { start, end } = alignedBounds(win.rangeSeconds, stepSeconds(window), Date.now() / 1000);
    const r = rangeFor(window);

    // KPI value + its prior-window counterpart (offset PromQL range).
    const kpi = async (cur: string, prior: string): Promise<Kpi> => {
      const [value, p] = await Promise.all([this.prom.scalar(cur), this.prom.scalar(prior)]);
      return { value, prior: p };
    };
    const range = (expr: string) => this.prom.queryRange(expr, start, end, win.step);

    // One round of reads: nothing here depends on an earlier answer. The
    // per-chain panels read one grouped series each and join on the spec
    // label below, so the cost of this call does not grow with the number of
    // chains (it used to be three reads per chain, plus the trend a second
    // time for `perChainSeries`, after a round that waited for `listSpecs()`).
    const [
      totalRequests,
      throughputRps,
      successRate,
      p50,
      p95,
      p99,
      healthGauge,
      throughput,
      errorsSeries,
      latP50,
      latencySeries,
      latP99,
      errorsNow,
      errorsPrior,
      distRows,
      provMatrix,
      specs,
      upstreamHealth,
      perSpecP50,
      perSpecHealth,
      perSpecTrend,
      activeRoutes,
    ] = await Promise.all([
      // Client-scoped requests + RPS (histogram _count) — relay-scoped
      // requests_total stays only where the per-provider lens is the point.
      kpi(qClientRequestsTotal(spec, window), qClientRequestsTotal(spec, window, r)),
      kpi(qClientRps(spec), `sum(rate(${ROUTER_METRICS.latencyCount}${sel}[5m] offset ${r}))`),
      kpi(qAvailability(spec, window), qAvailability(spec, window, r)),
      kpi(qLatencyQuantile(0.5, spec, window), qLatencyQuantile(0.5, spec, window, r)),
      kpi(qLatencyQuantile(0.95, spec, window), qLatencyQuantile(0.95, spec, window, r)),
      kpi(qLatencyQuantile(0.99, spec, window), qLatencyQuantile(0.99, spec, window, r)),
      this.prom.scalar(ROUTER_METRICS.overallHealth),
      range(qClientRpsSeriesExpr(win.step, spec, window)),
      range(qErrorCountSeriesExpr(win.step, spec, window)),
      // Latency series per percentile for the p50/p95/p99 chart toggle.
      range(qLatencySeriesExpr(0.5, win.step, spec, window)),
      range(qLatencySeriesExpr(0.95, win.step, spec, window)),
      range(qLatencySeriesExpr(0.99, win.step, spec, window)),
      // Errors = total − success over the window, for BOTH windows (the prior
      // KPI must be prior ERRORS, not prior requests).
      this.prom.scalar(qErrorCount(spec, window)),
      this.prom.scalar(qErrorCount(spec, window, r)),
      // Latency histogram distribution (per-bucket counts over the window).
      this.prom.query(qLatencyDistribution(window, spec)),
      // Per-provider throughput stack (real: provider_address label).
      range(qPerUpstreamRpsExpr(win.step, spec, window)),
      spec ? Promise.resolve([spec]) : this.listSpecs(),
      readUpstreamHealth(this.prom, this.configSvc, spec, routerId),
      // Per-chain p50, health and throughput trend — grouped, one read each.
      this.prom.query(qPerSpecLatencyQuantile(0.5, window, spec)),
      this.prom.query(qPerSpecHealth(spec)),
      range(qPerSpecClientRpsSeriesExpr(win.step, spec, window)),
      this.activeRoutes(window),
    ]);

    // The window's success ratio is the same read as the KPI's current value.
    const uptime = successRate.value;
    // 1 − success/total, the ratio `qErrorRate` gives per chain; null with no
    // requests. Not errors over `totalRequests`: that counts only the requests
    // the router answered (the latency histogram skips failures), from other
    // counters than the errors.
    const errorRate = uptime !== null ? 1 - uptime : null;

    const latencyDistribution = distRows
      .map((s) => ({ le: s.metric.le ?? "", count: Number(s.value[1]) || 0 }))
      .filter((b) => b.le !== "")
      .sort((a, b) => Number(a.le) - Number(b.le));

    const perUpstreamSeries = provMatrix
      .filter((m) => m.metric.provider_address)
      .map((m) => ({
        upstream: m.metric.provider_address ?? "",
        points: toPoints(m.values),
      }));

    // Error layers: until node/protocol error counters fire there is exactly
    // one honest layer — "unclassified" (= derived total − success).
    const errorLayers =
      errorsNow !== null && errorsNow > 0
        ? [{ layer: "unclassified", count: errorsNow }]
        : [];

    // Join the grouped reads onto the chains `listSpecs()` names. A chain no
    // grouped row covers keeps the nulls the per-chain reads gave it.
    const p50BySpec = valuesBySpec(perSpecP50);
    const healthBySpec = valuesBySpec(perSpecHealth);
    const trendBySpec = new Map<string, [number, string][]>();
    for (const row of perSpecTrend) if (row.metric.spec) trendBySpec.set(row.metric.spec, row.values);
    const perChainLatency = specs.map((s) => {
      const meta = buildChainMetaByIndex(s);
      const h = healthBySpec.get(s) ?? null;
      return {
        spec: s,
        name: meta.name,
        color: meta.color,
        p50Ms: p50BySpec.get(s) ?? null,
        trend: toPoints(trendBySpec.get(s)),
        degraded: h !== null && h < 1,
      };
    });
    // The same matrix as the trend above — not a second read of it.
    const perChainSeries = specs.map((s) => {
      const meta = buildChainMetaByIndex(s);
      return { spec: s, name: meta.name, color: meta.color, points: toPoints(trendBySpec.get(s)) };
    });

    return {
      totalRequests,
      throughputRps,
      errors: { value: errorsNow, prior: errorsPrior },
      errorRate,
      uptime,
      successRate,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      health: health(healthGauge),
      upstreamHealthCounts: {
        unhealthy: [...upstreamHealth.values()].filter((row) => row.health === "unhealthy").length,
        unknown: [...upstreamHealth.values()].filter((row) => row.health === "unknown").length,
      },
      computeUnits: { used: null, limit: null, resetsAt: null },
      rpsCap: null,
      throughput: toPoints(throughput[0]?.values),
      errorsSeries: toPoints(errorsSeries[0]?.values),
      latencySeries: {
        p50: toPoints(latP50[0]?.values),
        p95: toPoints(latencySeries[0]?.values),
        p99: toPoints(latP99[0]?.values),
      },
      latencyDistribution,
      perUpstreamSeries,
      errorLayers,
      perChainLatency,
      activeRoutes,
      perChainSeries,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * The topbar's three fields in six reads: the router's health gauge, the
   * current client RPS, and the upstream health roll-up (four reads of its
   * own). No window — the badge describes now.
   */
  async pulse(spec?: string, routerId?: string): Promise<DeploymentPulse> {
    const [healthGauge, throughputRps, upstreamHealth] = await Promise.all([
      spec ? this.chainHealth(spec) : this.prom.scalar(ROUTER_METRICS.overallHealth),
      this.prom.scalar(qClientRps(spec)),
      readUpstreamHealth(this.prom, this.configSvc, spec, routerId),
    ]);
    return {
      health: health(healthGauge),
      upstreamHealthCounts: {
        unhealthy: [...upstreamHealth.values()].filter((row) => row.health === "unhealthy").length,
        unknown: [...upstreamHealth.values()].filter((row) => row.health === "unknown").length,
      },
      throughputRps,
      lastUpdated: new Date().toISOString(),
    };
  }

  /** Active routes ranked by requests over the window (per backing endpoint). */
  private async activeRoutes(window: MetricWindow): Promise<import("@sr/shared").ActiveRoute[]> {
    const rows = await this.prom.query(
      qEndpointRelaysBySpec(window),
    );
    const parsed = rows
      .map((s) => ({
        endpointId: s.metric.endpoint_id ?? "",
        spec: s.metric.spec ?? "",
        requests: Math.round(Number(s.value[1]) || 0),
      }))
      .filter((x) => x.endpointId)
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 8);
    const max = parsed[0]?.requests || 1;
    return parsed.map((x) => ({
      ...x,
      color: buildChainMetaByIndex(x.spec).color,
      share: x.requests / max,
    }));
  }

  /**
   * The Routers table: ONE ROW PER CONFIG ROUTER, not per chain.
   *
   * Keying this by chain (as it was) collapses every router serving one chain
   * into a single row, which then wears the first router's name beside all of
   * their traffic. The config is the only place they are distinguishable — no
   * series carries a router — so the config drives the rows and Prometheus
   * fills them in.
   *
   * How far each row can be attributed differs, and the row says which:
   *
   * - The router maps to a scrape target the collector actually reports
   *   (`<id>-router` or `<id>` in `GET /api/metrics/routers`) → its chain-level
   *   numbers are re-read through that label and are genuinely its own.
   * - It doesn't, and it is alone on its chain → the chain's numbers ARE its
   *   numbers. Still `own`.
   * - It doesn't, and it has siblings → every sibling reads one shared series.
   *   The rows carry the same figures marked `shared`, naming who else is in
   *   them. Splitting them evenly, or letting each row present the total as its
   *   own, would invent a number and double the deployment's apparent traffic.
   *
   * `upstreamCount` always comes from the config, so it is per-router even when
   * the metrics can't be.
   *
   * With no values file mounted there is nothing to key on, so this degrades to
   * one row per chain — the old behaviour — with the spec as the router id.
   */
  async routers(window: MetricWindow, scopeLabel: string): Promise<RouterMetrics[]> {
    const topology = this.configSvc?.getRouters() ?? [];
    if (topology.length === 0) {
      const chains = await this.chains(window);
      return chains.map((c) => ({
        ...c,
        routerId: c.spec,
        attribution: "own" as const,
        sharedWith: [],
      }));
    }

    // Which routers the collector can actually tell apart. Checked against the
    // reported target values rather than assumed from the chart's naming, so a
    // deployment whose Service names differ degrades to `shared` instead of
    // grouping on a label nothing carries (which reads as zero). A label the
    // grouped reads already use cannot double as the target label.
    const scopable = isValidScopeLabel(scopeLabel) && !GROUPED_LABELS.has(scopeLabel);
    const scopeValues = new Set(scopable ? await this.listRouterScopes(scopeLabel) : []);
    const scopeFor = (routerId: string): string | null => {
      const candidate = `${routerId.toLowerCase()}-router`;
      if (scopeValues.has(candidate)) return candidate;
      if (scopeValues.has(routerId)) return routerId;
      return null;
    };

    const siblings = new Map<string, string[]>();
    for (const r of topology) {
      const ids = siblings.get(r.spec);
      if (!ids) siblings.set(r.spec, [r.id]);
      else ids.push(r.id);
    }

    // Two grouped reads at most, whatever the router count: one row per chain
    // for the routers the collector cannot split (the same row for every
    // sibling, so read once), one row per (chain, target) for the ones it
    // can. A set no router needs is not read.
    const scoped = topology.map((router) => scopeFor(router.id));
    const none = new Map<string, ChainFigures>();
    const [bySpec, byTarget] = await Promise.all([
      scoped.some((v) => v === null) ? this.chainFigures(window, ["spec"]) : none,
      scoped.some((v) => v !== null) ? this.chainFigures(window, ["spec", scopeLabel]) : none,
    ]);

    return topology.map((router, i): RouterMetrics => {
      const scopeValue = scoped[i] ?? null;
      const alone = (siblings.get(router.spec) ?? []).length <= 1;
      const meta = buildChainMetaByIndex(router.spec);
      const figures = scopeValue
        ? byTarget.get(groupKey([router.spec, scopeValue]))
        : bySpec.get(groupKey([router.spec]));
      return {
        spec: router.spec,
        name: meta.name,
        color: meta.color,
        ...(figures ?? NO_FIGURES),
        routerId: router.id,
        attribution: scopeValue || alone ? "own" : "shared",
        sharedWith:
          scopeValue || alone
            ? []
            : (siblings.get(router.spec) ?? []).filter((id) => id !== router.id),
        // The config's own count — the one number here that is always this
        // router's, whatever Prometheus can or cannot split.
        upstreamCount: router.nodes.length,
      };
    });
  }

  async chains(window: MetricWindow): Promise<ChainMetrics[]> {
    const [specs, figures] = await Promise.all([this.listSpecs(), this.chainFigures(window, ["spec"])]);
    return specs.map((spec) => {
      const meta = buildChainMetaByIndex(spec);
      return { spec, name: meta.name, color: meta.color, ...(figures.get(groupKey([spec])) ?? NO_FIGURES) };
    });
  }

  /**
   * The chain-level figures for EVERY group in one round of seven reads:
   * `by (spec)` is one row per chain, `by (spec, <target label>)` one row per
   * (chain, scrape target). Reading them per chain or per router cost the
   * Routers table eight queries a row; the store rejected part of each burst
   * and the rows rendered empty. A group absent from a read keeps that read's
   * null, as a missing scalar did.
   */
  private async chainFigures(window: MetricWindow, groupBy: GroupBy): Promise<Map<string, ChainFigures>> {
    const [requestRows, availabilityRows, p95Rows, qosRows, healthRows, tipRows, upstreamRows] =
      await Promise.all([
        this.prom.query(qGroupedClientRequests(groupBy, window)),
        this.prom.query(qGroupedAvailability(groupBy, window)),
        this.prom.query(qGroupedLatencyQuantile(0.95, groupBy, window)),
        this.prom.query(qGroupedQos(groupBy)),
        this.prom.query(qGroupedHealth(groupBy)),
        this.prom.query(qGroupedLatestBlock(groupBy)),
        this.prom.query(qGroupedUpstreams(groupBy)),
      ]);
    // A row missing any of the group's labels belongs to no group.
    const keyOf = (row: PromVectorSample): string | null => {
      const values = groupBy.map((label) => row.metric[label] ?? "");
      return values.every((v) => v !== "") ? groupKey(values) : null;
    };
    const finite = (rows: PromVectorSample[]): Map<string, number> => {
      const out = new Map<string, number>();
      for (const row of rows) {
        const k = keyOf(row);
        const n = Number(row.value[1]);
        if (k !== null && Number.isFinite(n)) out.set(k, n);
      }
      return out;
    };
    const requests = finite(requestRows);
    const availability = finite(availabilityRows);
    const p95 = finite(p95Rows);
    const qos = finite(qosRows);
    const healthGauge = finite(healthRows);
    const tips = finite(tipRows);
    const upstreams = new Map<string, number>();
    for (const row of upstreamRows) {
      const k = keyOf(row);
      if (k !== null) upstreams.set(k, (upstreams.get(k) ?? 0) + 1);
    }

    const out = new Map<string, ChainFigures>();
    const keys = new Set([requests, availability, p95, qos, healthGauge, tips, upstreams].flatMap((m) => [...m.keys()]));
    for (const k of keys) {
      const a = availability.get(k) ?? null;
      out.set(k, {
        requests: Math.round(requests.get(k) ?? 0),
        availability: a,
        // 1 − success/total: the same ratio, not a second read of it.
        errorRate: a === null ? null : 1 - a,
        p95Ms: p95.get(k) ?? null,
        qos: qos.get(k) ?? null,
        health: health(healthGauge.get(k) ?? null),
        latestBlock: tips.get(k) ?? null,
        upstreamCount: upstreams.get(k) ?? 0,
      });
    }
    return out;
  }

  /**
   * Latest block per ROUTER and per UPSTREAM, for one chain or all of them.
   *
   * Instant-only: these are gauges, so there is no window parameter — the
   * lag arithmetic is between series read at the same moment.
   *
   * Everything is measured against the chain's BEST upstream tip, and every
   * lag is also reported in seconds via the chain's block rate. That second
   * form is the one the UI leads with: the router gauge refreshes far more
   * coarsely than the endpoint gauge, so on a fast chain (APT1 moves ~28
   * versions/sec) its raw delta reads in the thousands while representing a
   * few seconds of real drift. Reporting only blocks would make healthy
   * routers look broken.
   *
   * @param routerId Keep only upstream tips the named CONFIG router declares —
   *   the same row-filter axis `upstreams()` takes, so a router filter narrows
   *   this list the way it narrows the roster. It does NOT narrow the `routers`
   *   rows: `smartrouter_latest_block` is labelled with the chain, so only the
   *   collector's target label can split those, and that axis arrives as the
   *   `?router=` scope this service was constructed with.
   */
  async blockTips(
    scopeLabel: string,
    spec?: string,
    routerId?: string,
  ): Promise<BlockHeights> {
    const label = isValidScopeLabel(scopeLabel) ? scopeLabel : null;

    const [bestRows, rateRows, routerRows, routerChangeRows, upstreamRows, changeRows, healthRows] =
      await Promise.all([
        this.prom.query(qBestTipBySpec(spec)),
        this.prom.query(qBlockRateBySpec(spec)),
        this.prom.query(qRouterTips(label ?? undefined, spec)),
        this.prom.query(qRouterTipChanges(label ?? undefined, spec)),
        this.prom.query(qUpstreamTips(spec)),
        this.prom.query(qTipChanges(spec)),
        this.prom.query(`${ENDPOINT_METRICS.overallHealth}${selector({ spec })}`),
      ]);

    const num = (v: string): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const best = new Map<string, number>();
    for (const r of bestRows) {
      const v = num(r.value[1]);
      if (r.metric.spec && v !== null) best.set(r.metric.spec, v);
    }
    const rate = new Map<string, number>();
    for (const r of rateRows) {
      const v = num(r.value[1]);
      // A negative deriv is a chain reset or a re-adopted tip, not a rate.
      if (r.metric.spec && v !== null && v > 0) rate.set(r.metric.spec, v);
    }
    // changes() and the health gauge key on (endpoint_id, apiInterface), the
    // same identity the tip rows carry — an endpoint serving two interfaces is
    // two independent tips and must not collapse.
    const key = (id: string, iface: string) => `${id}\u0000${iface}`;
    const changes = new Map<string, number>();
    for (const r of changeRows) {
      const v = num(r.value[1]);
      if (r.metric.endpoint_id && v !== null) {
        changes.set(key(r.metric.endpoint_id, r.metric.apiInterface ?? ""), v);
      }
    }
    const healthByKey = new Map<string, number>();
    for (const r of healthRows) {
      const v = num(r.value[1]);
      if (r.metric.endpoint_id && v !== null) {
        healthByKey.set(key(r.metric.endpoint_id, r.metric.apiInterface ?? ""), v);
      }
    }

    /** Block delta → seconds, or null when the chain's rate is unmeasurable. */
    const secondsBehind = (specLabel: string, blocks: number | null): number | null => {
      const bps = rate.get(specLabel);
      if (blocks === null || bps === undefined) return null;
      return blocks / bps;
    };

    const bySpec = new Map<string, ChainTips>();
    const ensure = (specLabel: string): ChainTips => {
      let row = bySpec.get(specLabel);
      if (!row) {
        const meta = buildChainMetaByIndex(specLabel);
        row = {
          spec: specLabel,
          name: meta.name,
          color: meta.color,
          blocksPerSec: rate.get(specLabel) ?? null,
          bestBlock: best.get(specLabel) ?? null,
          routers: [],
          upstreams: [],
        };
        bySpec.set(specLabel, row);
      }
      return row;
    };

    // The router gauge's own refresh cadence, keyed the same way its tips are.
    const routerKey = (routerId: string | null, specLabel: string, iface: string) =>
      `${routerId ?? ""}\u0000${specLabel}\u0000${iface}`;
    const refreshSec = new Map<string, number>();
    for (const r of routerChangeRows) {
      const changesCount = num(r.value[1]);
      if (!r.metric.spec || changesCount === null || changesCount <= 0) continue;
      refreshSec.set(
        routerKey(label ? (r.metric[label] ?? null) : null, r.metric.spec, r.metric.apiInterface ?? ""),
        TIP_WINDOW_SECONDS / changesCount,
      );
    }

    for (const r of routerRows) {
      const specLabel = r.metric.spec;
      if (!specLabel) continue;
      const block = num(r.value[1]);
      const reference = best.get(specLabel);
      const behindBlocks =
        block !== null && reference !== undefined ? Math.max(0, reference - block) : null;
      const tip: RouterTip = {
        router: label ? (r.metric[label] ?? null) : null,
        apiInterface: r.metric.apiInterface ?? "",
        block,
        behindBlocks,
        behindSec: secondsBehind(specLabel, behindBlocks),
        refreshSec:
          refreshSec.get(
            routerKey(
              label ? (r.metric[label] ?? null) : null,
              specLabel,
              r.metric.apiInterface ?? "",
            ),
          ) ?? null,
      };
      ensure(specLabel).routers.push(tip);
    }

    // Node name → the config routers declaring it, the sole source of router
    // attribution for a per-endpoint series (mirrors `upstreams()`).
    const routersByName = new Map<string, string[]>();
    if (this.configSvc) {
      for (const router of this.configSvc.getRouters()) {
        for (const node of router.nodes) {
          const ids = routersByName.get(node.name);
          if (!ids) routersByName.set(node.name, [router.id]);
          else if (!ids.includes(router.id)) ids.push(router.id);
        }
      }
    }

    for (const r of upstreamRows) {
      const specLabel = r.metric.spec;
      const endpointId = r.metric.endpoint_id;
      if (!specLabel || !endpointId) continue;
      if (routerId && !(routersByName.get(endpointId) ?? []).includes(routerId)) continue;
      const iface = r.metric.apiInterface ?? "";
      const block = num(r.value[1]);
      const reference = best.get(specLabel);
      const behindBlocks =
        block !== null && reference !== undefined ? Math.max(0, reference - block) : null;
      const tip: UpstreamTip = {
        endpointId,
        apiInterface: iface,
        block,
        behindBlocks,
        behindSec: secondsBehind(specLabel, behindBlocks),
        stale: isStale(changes.get(key(endpointId, iface)), rate.get(specLabel)),
        health: health(healthByKey.get(key(endpointId, iface)) ?? null),
      };
      ensure(specLabel).upstreams.push(tip);
    }

    for (const chain of bySpec.values()) {
      chain.routers.sort(
        (a, b) =>
          (a.router ?? "").localeCompare(b.router ?? "") ||
          a.apiInterface.localeCompare(b.apiInterface),
      );
      chain.upstreams.sort(
        (a, b) =>
          a.endpointId.localeCompare(b.endpointId) ||
          a.apiInterface.localeCompare(b.apiInterface),
      );
    }

    return {
      routerLabel: label,
      chains: [...bySpec.values()].sort((a, b) => a.spec.localeCompare(b.spec)),
    };
  }

  /**
   * @param routerId Keep only upstreams the named CONFIG router declares. A
   *   different axis from the `?router=` scope this service is constructed
   *   with: that one narrows the PromQL to a collector target label, this one
   *   filters rows by what the mounted values file says. See `routerIds` on
   *   `UpstreamMetrics`.
   */
  async upstreams(
    spec: string | undefined,
    window: MetricWindow,
    routerId?: string,
  ): Promise<UpstreamMetrics[]> {
    const sel = selector({ spec });
    const r = rangeFor(window);

    const [
      requests,
      optimizerScores,
      scores,
      currentHealth,
      blocks,
      inFlight,
      latency,
      rateRows,
      changeRows,
      pollsOk,
      pollsFailed,
    ] = await Promise.all([
      this.prom.query(
        qEndpointRelaysBySpec(window, spec),
      ),
      // QoS, preferred source. The router samples this for EVERY upstream on a
      // timer, so an idle row — a backup nobody has failed over to — still has
      // a current score. See `qOptimizerScoresByEndpoint`.
      this.prom.query(qOptimizerScoresByEndpoint(spec)),
      // Fallback for a router too old to publish the sampler's gauge. Same
      // numbers, but written only when a relay was routed here.
      this.prom.query(`${ENDPOINT_METRICS.selectionScore}${sel}`),
      readUpstreamHealth(this.prom, this.configSvc, spec, routerId),
      this.prom.query(`${ENDPOINT_METRICS.latestBlock}${sel}`),
      this.prom.query(
        `sum by (endpoint_id, spec) (${ENDPOINT_METRICS.requestsInFlight}${sel})`,
      ),
      // Per-endpoint p95 latency — the endpoint histogram carries endpoint_id.
      // `spec` stays in the by-clause: one node name serving several chains is
      // several endpoints, and folding their histograms quotes one chain's
      // latency for another.
      this.prom.query(
        qEndpointLatencyQuantileBySpec(0.95, window, spec),
      ),
      // Block rate + tip-change count turn the raw block lag below into the
      // seconds-behind figure the roster leads with, and into a stale flag.
      this.prom.query(qBlockRateBySpec(spec)),
      this.prom.query(qTipChanges(spec)),
      // Poll outcomes — the liveness an upstream with no relays still has.
      this.prom.query(qEndpointPolls("ok", spec, window)),
      this.prom.query(qEndpointPolls("failed", spec, window)),
    ]);

    // Config-derived identity, keyed by (node name × chain): role/interface
    // (helm marks backups; SR_CONFIG has no backup marker, so role stays null
    // there) + every router that declares the name ON THAT CHAIN. The series
    // carries `endpoint_id` + `spec`, so the config is the sole source of
    // router attribution — and a name-only key was the bug: vendors reused
    // across chains ("lava", "publicnode") attributed every chain's row to
    // whichever router declared the name first in the values file.
    const nodeKey = (name: string, spec: string) => `${name}\u0000${spec}`;
    const roleByNode = new Map<string, { role: "primary" | "backup"; iface: string | null }>();
    const routersByNode = new Map<string, string[]>();
    if (this.configSvc) {
      for (const router of this.configSvc.getRouters()) {
        for (const node of router.nodes) {
          const key = nodeKey(node.name, router.spec);
          if (!roleByNode.has(key)) {
            roleByNode.set(key, {
              role: node.isBackup ? "backup" : "primary",
              iface: node.endpoints[0]?.interface ?? null,
            });
          }
          const ids = routersByNode.get(key);
          if (!ids) routersByNode.set(key, [router.id]);
          else if (!ids.includes(router.id)) ids.push(router.id);
        }
      }
    }
    const isHelm = this.configSvc
      ? this.configSvc.getRouters().some((rt) => rt.localPort === null && rt.nodes.length > 0)
      : false;

    // One row per (endpoint × chain). Keyed by endpoint_id alone, a node name
    // serving several chains collapsed into a single row wearing whichever
    // spec Prometheus happened to return first.
    const byId = new Map<string, UpstreamMetrics>();
    const ensure = (endpointId: string, specLabel: string): UpstreamMetrics => {
      const key = nodeKey(endpointId, specLabel);
      let row = byId.get(key);
      if (!row) {
        const cfg = roleByNode.get(key);
        row = {
          endpointId,
          spec: specLabel,
          requests: 0,
          uptime: null,
          p95Ms: null,
          errorRate: null,
          scores: {},
          scoreSource: null,
          polls: null,
          health: "unknown",
          healthReason: "No current health measurement or successful block polls reported; check the router and Prometheus scrape.",
          latestBlock: null,
          blockLag: null,
          behindSec: null,
          stale: false,
          // Only helm-format configs can mark backups; SR_CONFIG ⇒ null.
          role: cfg && isHelm ? cfg.role : null,
          apiInterface: cfg?.iface ?? null,
          inFlight: 0,
          routerIds: routersByNode.get(key) ?? [],
        };
        byId.set(key, row);
      }
      return row;
    };

    for (const s of requests) {
      const id = s.metric.endpoint_id;
      if (!id) continue;
      // Relay counts are whole events — round off increase() extrapolation.
      ensure(id, s.metric.spec ?? "").requests = Math.round(Number(s.value[1]) || 0);
    }
    // QoS, optimizer-first. Both gauges carry the same five numbers — one
    // optimizer computation fills both — so this is not a choice between two
    // measurements, it is a choice between two publication schedules. The
    // sampler's covers every upstream on a timer; the routing path's only
    // exists where a relay went. Preferring the sampler is what lets an idle
    // upstream keep a live score instead of an empty column.
    //
    // Per ROW, not per response: a deployment can have the sampler's gauge for
    // most upstreams and fall back for one that predates it, and mixing within
    // one row would silently blend two write cadences under one number.
    const scoreRows = (
      rows: PromVectorSample[],
      source: "optimizer" | "endpoint",
    ): void => {
      for (const s of rows) {
        const id = s.metric.endpoint_id;
        const type = s.metric.score_type as ScoreType | undefined;
        if (!id || !type) continue;
        const row = ensure(id, s.metric.spec ?? "");
        // First source to claim a row owns it — optimizer runs first below.
        if (row.scoreSource !== null && row.scoreSource !== source) continue;
        const v = Number(s.value[1]);
        if (!Number.isFinite(v)) continue;
        row.scores[type] = v;
        row.scoreSource = source;
      }
    };
    scoreRows(optimizerScores, "optimizer");
    scoreRows(scores, "endpoint");
    for (const status of currentHealth.values()) {
      const row = ensure(status.endpointId, status.spec);
      row.health = status.health;
      row.healthReason = status.healthReason;
    }
    for (const s of blocks) {
      const id = s.metric.endpoint_id;
      if (!id) continue;
      ensure(id, s.metric.spec ?? "").latestBlock = Number(s.value[1]) || null;
    }
    for (const s of inFlight) {
      const id = s.metric.endpoint_id;
      if (!id) continue;
      ensure(id, s.metric.spec ?? "").inFlight = Number(s.value[1]) || 0;
    }
    for (const s of latency) {
      const id = s.metric.endpoint_id;
      if (!id) continue;
      const v = Number(s.value[1]);
      ensure(id, s.metric.spec ?? "").p95Ms = Number.isFinite(v) ? v : null;
    }

    // Poll outcomes. Written for every endpoint the tracker polls, which is
    // every configured endpoint — so this is the only per-upstream signal a row
    // with no relays still carries. A row stays `null` until one of the two
    // counters names it, keeping "family absent" (old router) distinct from
    // "polled zero times in this window" (the gate suppressed them).
    const poll = (id: string, specLabel: string): { ok: number; failed: number } => {
      const row = ensure(id, specLabel);
      if (row.polls === null) row.polls = { ok: 0, failed: 0 };
      return row.polls;
    };
    for (const s of pollsOk) {
      const id = s.metric.endpoint_id;
      if (!id) continue;
      poll(id, s.metric.spec ?? "").ok = Math.round(Number(s.value[1]) || 0);
    }
    for (const s of pollsFailed) {
      const id = s.metric.endpoint_id;
      if (!id) continue;
      poll(id, s.metric.spec ?? "").failed = Math.round(Number(s.value[1]) || 0);
    }

    // Block lag = spec-max latest block − this endpoint's latest block.
    const maxBySpec = new Map<string, number>();
    for (const row of byId.values()) {
      if (row.latestBlock === null) continue;
      const cur = maxBySpec.get(row.spec) ?? 0;
      if (row.latestBlock > cur) maxBySpec.set(row.spec, row.latestBlock);
    }
    for (const row of byId.values()) {
      const specMax = maxBySpec.get(row.spec);
      if (specMax !== undefined && row.latestBlock !== null) {
        row.blockLag = Math.max(0, specMax - row.latestBlock);
      }
    }

    // Same lag in seconds — a block count only means something once divided by
    // the chain's own block rate (see blockTips). Rows keep `blockLag` too, so
    // a caller that wants the raw delta still has it.
    const rateBySpec = new Map<string, number>();
    for (const s2 of rateRows) {
      const v = Number(s2.value[1]);
      if (s2.metric.spec && Number.isFinite(v) && v > 0) rateBySpec.set(s2.metric.spec, v);
    }
    // The roster keys rows by (endpoint × chain), so an endpoint on two
    // interfaces gets the WORST (lowest) change count of the two — a freeze on
    // either interface is worth surfacing on the row.
    const changesById = new Map<string, number>();
    for (const s2 of changeRows) {
      const id = s2.metric.endpoint_id;
      const v = Number(s2.value[1]);
      if (!id || !Number.isFinite(v)) continue;
      const key = nodeKey(id, s2.metric.spec ?? "");
      const cur = changesById.get(key);
      if (cur === undefined || v < cur) changesById.set(key, v);
    }
    for (const row of byId.values()) {
      const bps = rateBySpec.get(row.spec);
      row.behindSec = row.blockLag !== null && bps !== undefined ? row.blockLag / bps : null;
      row.stale = isStale(changesById.get(nodeKey(row.endpointId, row.spec)), bps);
    }

    // Uptime + error rate per (endpoint × chain) = success/total over the
    // window, keyed by provider_address (= the endpoint name) + spec on the
    // router request counters.
    const [okByProv, totByProv] = await Promise.all([
      this.prom.query(qUpstreamSuccesses(window, spec)),
      this.prom.query(qUpstreamRelays(window, spec)),
    ]);
    const okMap = new Map(
      okByProv.map((s) => [nodeKey(s.metric.provider_address ?? "", s.metric.spec ?? ""), Number(s.value[1]) || 0]),
    );
    for (const s of totByProv) {
      const id = s.metric.provider_address;
      if (!id) continue;
      const key = nodeKey(id, s.metric.spec ?? "");
      const tot = Number(s.value[1]) || 0;
      const row = byId.get(key);
      if (row && tot > 0) {
        row.uptime = (okMap.get(key) ?? 0) / tot;
        row.errorRate = Math.max(0, 1 - row.uptime);
      }
    }

    const rows = [...byId.values()].sort((a, b) => b.requests - a.requests);
    // Router filter last: it drops rows, it never changes a number. A row the
    // config doesn't place (`routerIds: []` — traffic under a name no longer in
    // the values file) can't belong to the asked-for router, so it goes too.
    return routerId ? rows.filter((row) => row.routerIds.includes(routerId)) : rows;
  }

  /**
   * Aggregate RPS-now + per-chain rows (rpsNow, requests, share, trend
   * sparkline): the design's "Requests / sec · N chains" view, which the
   * removed Traffic tab drew. No web consumer now.
   */
  async traffic(window: MetricWindow): Promise<{
    rpsNow: number | null;
    chainCount: number;
    aggregate: { t: number; v: number | null }[];
    chains: {
      spec: string;
      name: string;
      color: string;
      rpsNow: number | null;
      requests: number;
      share: number | null;
      trend: { t: number; v: number | null }[];
    }[];
  }> {
    const win = WINDOWS[window];
    const { start, end } = alignedBounds(win.rangeSeconds, stepSeconds(window), Date.now() / 1000);
    const specs = await this.listSpecs();

    const [aggMatrix, totalAll] = await Promise.all([
      this.prom.queryRange(qClientRpsSeriesExpr(win.step, undefined, window), start, end, win.step),
      this.prom.scalar(qClientRequestsTotal(undefined, window)),
    ]);
    const aggPoints = toPoints(aggMatrix[0]?.values);

    const chains = await Promise.all(
      specs.map(async (spec) => {
        const meta = buildChainMetaByIndex(spec);
        const [trendMatrix, requests] = await Promise.all([
          this.prom.queryRange(qClientRpsSeriesExpr(win.step, spec, window), start, end, win.step),
          this.prom.scalar(qClientRequestsTotal(spec, window)),
        ]);
        const trend = toPoints(trendMatrix[0]?.values);
        const last = trend.length ? trend[trend.length - 1] : undefined;
        return {
          spec,
          name: meta.name,
          color: meta.color,
          rpsNow: last?.v ?? null,
          requests: requests ?? 0,
          share: totalAll && totalAll > 0 ? (requests ?? 0) / totalAll : null,
          trend,
        };
      }),
    );

    chains.sort((a, b) => b.requests - a.requests);
    const aggLast = aggPoints.length ? aggPoints[aggPoints.length - 1] : undefined;
    return {
      rpsNow: aggLast?.v ?? null,
      chainCount: specs.length,
      aggregate: aggPoints,
      chains,
    };
  }

  /**
   * Method-level breakdown + read/write/batch class totals.
   *
   * Requests are CLIENT-scoped: the latency histogram increments once per
   * client request and carries the method as its `function` label — this also
   * makes per-method p95 REAL (the "no method label" note in the design doc
   * was wrong; the label is just named `function`, not `method`).
   * Error rates stay relay-scoped (errors ÷ relays, both from the
   * `method`-labelled relay counters) so a cross-validated failure doesn't
   * produce a >100% rate against the client denominator.
   */
  async methods(
    spec: string | undefined,
    window: MetricWindow,
  ): Promise<{ methods: MethodUsage[]; classTotals: MethodClassTotals }> {
    const sel = selector({ spec });
    const r = rangeFor(window);
    const [rows, p95Rows, reads, relayRows, errRows, writePresent, batchPresent] =
      await Promise.all([
        this.prom.query(qClientRequestsBy("function", window, spec)),
        this.prom.query(qMethodLatencyQuantile(0.95, window, spec)),
        this.prom.query(
          qReadRequestsByMethod(window, spec),
        ),
        this.prom.query(qRequestsBy("method", window, spec)),
        this.prom.query(qErrorsBy("method", window, spec)),
        this.familyPresent(OPTIONAL_METRICS.requestsWriteTotal),
        this.familyPresent(OPTIONAL_METRICS.requestsBatchTotal),
      ]);
    const readSet = new Set(reads.map((s) => s.metric.method).filter(Boolean));
    const relayByMethod = new Map(
      relayRows.map((s) => [s.metric.method ?? "", Number(s.value[1]) || 0]),
    );
    const errByMethod = new Map(
      errRows.map((s) => [s.metric.method ?? "", Number(s.value[1]) || 0]),
    );
    const p95ByMethod = new Map(
      p95Rows
        .map((s) => [s.metric.function ?? "", Number(s.value[1])] as const)
        .filter(([, v]) => Number.isFinite(v)),
    );

    const methods = rows
      .map((s) => {
        const method = s.metric.function ?? "unknown";
        const requests = Number(s.value[1]) || 0;
        const errors = errByMethod.get(method) ?? 0;
        const relays = relayByMethod.get(method) ?? 0;
        return {
          method,
          class: (readSet.has(method) ? "read" : "unknown") as MethodUsage["class"],
          requests,
          p95Ms: p95ByMethod.get(method) ?? null,
          errorRate: relays > 0 ? errors / relays : null,
        };
      })
      .filter((m) => m.requests > 0)
      .sort((a, b) => b.requests - a.requests);

    const [writeTotal, batchTotal] = await Promise.all([
      writePresent
        ? this.prom.scalar(`round(sum(increase(${OPTIONAL_METRICS.requestsWriteTotal}${sel}[${r}])))`)
        : Promise.resolve(null),
      batchPresent
        ? this.prom.scalar(`round(sum(increase(${OPTIONAL_METRICS.requestsBatchTotal}${sel}[${r}])))`)
        : Promise.resolve(null),
    ]);
    // Class totals on the same client-scoped counts as the rows, so the class
    // tabs and the table always reconcile.
    const readTotal = methods.reduce((s, m) => s + (m.class === "read" ? m.requests : 0), 0);
    const allTotal = methods.reduce((s, m) => s + m.requests, 0);
    const classTotals: MethodClassTotals = {
      read: readTotal,
      write: writeTotal,
      batch: batchTotal,
      unclassified: Math.max(0, allTotal - readTotal - (writeTotal ?? 0) - (batchTotal ?? 0)),
      emitted: { write: writePresent, batch: batchPresent },
    };

    return { methods, classTotals };
  }

  /** RPS time-series for the Traffic chart (client-scoped). */
  async rpsSeries(spec: string | undefined, window: MetricWindow): Promise<TimeSeries> {
    const win = WINDOWS[window];
    const { start, end } = alignedBounds(win.rangeSeconds, stepSeconds(window), Date.now() / 1000);
    const expr = qClientRpsSeriesExpr(win.step, spec, window);
    const matrix = await this.prom.queryRange(expr, start, end, win.step);
    const first = matrix[0];
    return {
      label: spec ?? "all chains",
      points: first
        ? first.values.map(([t, v]) => ({ t, v: Number.isFinite(Number(v)) ? Number(v) : null }))
        : [],
    };
  }
}
