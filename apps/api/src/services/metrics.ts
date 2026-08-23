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
  qErrorRate,
  qEndpointHealth,
  qEndpointLatestBlock,
  qEndpointScores,
  qErrorsBy,
  qLatencyDistribution,
  qLatencyQuantile,
  qBestTipBySpec,
  qBlockRateBySpec,
  qLatestBlock,
  qMethodLatencyQuantile,
  qOverallHealth,
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
import { WINDOWS } from "@sr/shared/constants";
import type { PrometheusClient } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";

export function health(value: number | null): HealthState {
  if (value === null) return "unknown";
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
    return this.prom.scalar(
      `max by (spec) (${ENDPOINT_METRICS.overallHealth}${selector({ spec })})`,
    );
  }

  /** True when the optional family is registered on this build. */
  private async familyPresent(metricName: string): Promise<boolean> {
    const v = await this.prom.scalar(qPresence(metricName));
    return v !== null && v > 0;
  }

  /** The six HeroPanel cards (Metrics · Overview tab). */
  async dashboardSummary(window: MetricWindow, spec?: string): Promise<HeroSummary> {
    const r = rangeFor(window);
    // Label selector for the metrics that carry a `spec` label, so the hero
    // KPIs scope to the selected chain (empty = account-wide across all chains).
    const specSel = spec ? `{spec="${spec}"}` : "";
    const kpi = async (cur: string, prior: string): Promise<Kpi> => {
      const [value, p] = await Promise.all([this.prom.scalar(cur), this.prom.scalar(prior)]);
      return { value, prior: p };
    };

    const [retriesPresent, cachePresent, consistencyFailedPresent] = await Promise.all([
      this.familyPresent(OPTIONAL_METRICS.retriesSuccessTotal),
      this.familyPresent(OPTIONAL_METRICS.cacheTotalHits),
      this.familyPresent(OPTIONAL_METRICS.consistencyFailedTotal),
    ]);

    const [requestsServed, successRate, p95, staleKpi, specs, upstreams, healthGauge] =
      await Promise.all([
        // CLIENT-scoped: the latency-histogram _count increments exactly once
        // per client request. requests_total is relay-scoped (per participant,
        // probes included) — see qRequestsTotal's doc note.
        kpi(qClientRequestsTotal(spec, window), qClientRequestsTotal(spec, window, r)),
        kpi(qAvailability(spec, window), qAvailability(spec, window, r)),
        // No cache on this build ⇒ the documented derived "effective read p95"
        // reduces to the node read p95 (the overall router histogram).
        kpi(qLatencyQuantile(0.95, spec, window), qLatencyQuantile(0.95, spec, window, r)),
        // Stale caught = consistency checks that FAILED. An absent
        // consistency_failed_total family means zero failures since boot, so
        // the honest value is 0 — success_total counts checks that PASSED and
        // must never be shown here.
        consistencyFailedPresent
          ? kpi(qConsistencyCaught(window, undefined, spec), qConsistencyCaught(window, r, spec))
          : Promise.resolve({ value: 0, prior: 0 } as Kpi),
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
        // spec-labelled endpoint gauge — see chains()/chainRow(), which has
        // always done this correctly.
        spec ? this.chainHealth(spec) : this.prom.scalar(qOverallHealth()),
      ]);
    const stale = staleKpi;

    const retriesRecovered: Kpi = retriesPresent
      ? await kpi(
          `round(sum(increase(${OPTIONAL_METRICS.retriesSuccessTotal}${specSel}[${r}])))`,
          `round(sum(increase(${OPTIONAL_METRICS.retriesSuccessTotal}${specSel}[${r}] offset ${r})))`,
        )
      : { value: null, prior: null };
    const cacheOffloadPct: Kpi = cachePresent
      ? await kpi(
          `sum(increase(${OPTIONAL_METRICS.cacheTotalHits}${specSel}[${r}])) / (sum(increase(${OPTIONAL_METRICS.cacheTotalHits}${specSel}[${r}])) + sum(increase(${OPTIONAL_METRICS.cacheTotalMisses}${specSel}[${r}])))`,
          `sum(increase(${OPTIONAL_METRICS.cacheTotalHits}${specSel}[${r}] offset ${r})) / (sum(increase(${OPTIONAL_METRICS.cacheTotalHits}${specSel}[${r}] offset ${r})) + sum(increase(${OPTIONAL_METRICS.cacheTotalMisses}${specSel}[${r}] offset ${r})))`,
        )
      : { value: null, prior: null };

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

  /**
   * One-shot payload for the Overview + Dashboard screens. Every value maps to
   * a real series; quota/cap (Compute Units, RPS cap) are NOT router metrics —
   * they stay null and the UI shows an honest "not tracked" state.
   */
  async overview(
    window: MetricWindow,
    spec?: string,
  ): Promise<import("@sr/shared").OverviewData> {
    const win = WINDOWS[window];
    const sel = selector({ spec });
    const end = Math.floor(Date.now() / 1000);
    const start = end - win.rangeSeconds;
    const r = rangeFor(window);

    // KPI value + its prior-window counterpart (offset PromQL range).
    const kpi = async (cur: string, prior: string): Promise<Kpi> => {
      const [value, p] = await Promise.all([this.prom.scalar(cur), this.prom.scalar(prior)]);
      return { value, prior: p };
    };

    const [
      totalRequests,
      throughputRps,
      successRate,
      p50,
      p95,
      p99,
      uptime,
      healthGauge,
      throughput,
      errorsSeries,
      latencySeries,
      specs,
    ] = await Promise.all([
      // Client-scoped requests + RPS (histogram _count) — relay-scoped
      // requests_total stays only where the per-provider lens is the point.
      kpi(qClientRequestsTotal(spec, window), qClientRequestsTotal(spec, window, r)),
      kpi(qClientRps(spec), `sum(rate(${ROUTER_METRICS.latencyCount}${sel}[5m] offset ${r}))`),
      kpi(qAvailability(spec, window), qAvailability(spec, window, r)),
      kpi(qLatencyQuantile(0.5, spec, window), qLatencyQuantile(0.5, spec, window, r)),
      kpi(qLatencyQuantile(0.95, spec, window), qLatencyQuantile(0.95, spec, window, r)),
      kpi(qLatencyQuantile(0.99, spec, window), qLatencyQuantile(0.99, spec, window, r)),
      this.prom.scalar(qAvailability(spec, window)),
      this.prom.scalar(qOverallHealth()),
      this.prom.queryRange(qClientRpsSeriesExpr(win.step, spec), start, end, win.step),
      this.prom.queryRange(`round(clamp_min(sum(increase(${ROUTER_METRICS.requestsTotal}${sel}[${win.step}])) - sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${win.step}])), 0))`, start, end, win.step),
      this.prom.queryRange(qLatencyQuantile(0.95, spec, window).replace(`[${r}]`, `[${win.step}]`), start, end, win.step),
      spec ? Promise.resolve([spec]) : this.listSpecs(),
    ]);

    // Latency series per percentile for the p50/p95/p99 chart toggle.
    const [latP50, latP99] = await Promise.all([
      this.prom.queryRange(qLatencyQuantile(0.5, spec, window).replace(`[${r}]`, `[${win.step}]`), start, end, win.step),
      this.prom.queryRange(qLatencyQuantile(0.99, spec, window).replace(`[${r}]`, `[${win.step}]`), start, end, win.step),
    ]);

    // Errors = total − success over the window, for BOTH windows (the prior
    // KPI must be prior ERRORS, not prior requests).
    const [errorsNow, errorsPrior] = await Promise.all([
      this.prom.scalar(qErrorCount(spec, window)),
      this.prom.scalar(qErrorCount(spec, window, r)),
    ]);
    const reqWin = totalRequests.value;
    const errorRate =
      reqWin && reqWin > 0 && errorsNow !== null ? errorsNow / reqWin : null;

    // Latency histogram distribution (per-bucket counts over the window).
    const distRows = await this.prom.query(qLatencyDistribution(window, spec));
    const latencyDistribution = distRows
      .map((s) => ({ le: s.metric.le ?? "", count: Number(s.value[1]) || 0 }))
      .filter((b) => b.le !== "")
      .sort((a, b) => Number(a.le) - Number(b.le));

    // Per-provider throughput stack (real: provider_address label).
    const provMatrix = await this.prom.queryRange(
      `sum by (provider_address) (rate(${ROUTER_METRICS.requestsTotal}${sel}[${win.step}]))`,
      start,
      end,
      win.step,
    );
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

    // Per-chain latency + active routes + per-chain series.
    const [perChainLatency, activeRoutes, perChainSeries] = await Promise.all([
      Promise.all(
        specs.map(async (spec) => {
          const meta = buildChainMetaByIndex(spec);
          const [p50c, h, trend] = await Promise.all([
            this.prom.scalar(qLatencyQuantile(0.5, spec, window)),
            this.chainHealth(spec),
            this.prom.queryRange(qClientRpsSeriesExpr(win.step, spec), start, end, win.step),
          ]);
          return { spec, name: meta.name, color: meta.color, p50Ms: p50c, trend: toPoints(trend[0]?.values), degraded: h !== null && h < 1 };
        }),
      ),
      this.activeRoutes(window),
      Promise.all(
        specs.map(async (spec) => {
          const meta = buildChainMetaByIndex(spec);
          const m = await this.prom.queryRange(
            qClientRpsSeriesExpr(win.step, spec),
            start,
            end,
            win.step,
          );
          return { spec, name: meta.name, color: meta.color, points: toPoints(m[0]?.values) };
        }),
      ),
    ]);

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

  /** Active routes ranked by requests over the window (per backing endpoint). */
  private async activeRoutes(window: MetricWindow): Promise<import("@sr/shared").ActiveRoute[]> {
    const rows = await this.prom.query(
      `sum by (endpoint_id, spec) (increase(${ENDPOINT_METRICS.totalRelaysServiced}[${rangeFor(window)}]))`,
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
    // scoping every query to a label nothing carries (which reads as zero).
    const scopeValues = new Set(
      isValidScopeLabel(scopeLabel) ? await this.listRouterScopes(scopeLabel) : [],
    );
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

    // One chain-level read per spec, shared by every router that can't be
    // scoped — the unscoped row is identical for all of them, so re-running it
    // per router would be the same queries for the same answer.
    const unscopedBySpec = new Map<string, Promise<ChainMetrics>>();
    const chainRowFor = (spec: string): Promise<ChainMetrics> => {
      let row = unscopedBySpec.get(spec);
      if (!row) {
        row = this.chainRow(spec, window);
        unscopedBySpec.set(spec, row);
      }
      return row;
    };

    return Promise.all(
      topology.map(async (router): Promise<RouterMetrics> => {
        const scopeValue = scopeFor(router.id);
        const alone = (siblings.get(router.spec) ?? []).length <= 1;
        const base = scopeValue
          ? await new MetricsService(
              this.prom.withScope({ label: scopeLabel, value: scopeValue }),
              this.configSvc,
            ).chainRow(router.spec, window)
          : await chainRowFor(router.spec);

        return {
          ...base,
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
      }),
    );
  }

  async chains(window: MetricWindow): Promise<ChainMetrics[]> {
    const specs = await this.listSpecs();
    return Promise.all(specs.map((spec) => this.chainRow(spec, window)));
  }

  /** @internal Reused by `routers()`, including on a scoped sibling instance. */
  async chainRow(spec: string, window: MetricWindow): Promise<ChainMetrics> {
    const meta = buildChainMetaByIndex(spec);
    const [requests, availability, errorRate, p95, qos, healthGauge, latestBlock, upstreams] =
      await Promise.all([
        this.prom.scalar(qClientRequestsTotal(spec, window)),
        this.prom.scalar(qAvailability(spec, window)),
        this.prom.scalar(qErrorRate(spec, window)),
        this.prom.scalar(qLatencyQuantile(0.95, spec, window)),
        this.prom.scalar(
          `avg(${ENDPOINT_METRICS.selectionScore}${selector({ spec, score_type: "composite" })})`,
        ),
        this.chainHealth(spec),
        this.prom.scalar(qLatestBlock(spec)),
        this.prom.query(
          `count by (endpoint_id) (${ENDPOINT_METRICS.overallHealth}${selector({ spec })})`,
        ),
      ]);

    return {
      spec,
      name: meta.name,
      color: meta.color,
      requests: requests ?? 0,
      availability,
      errorRate,
      p95Ms: p95,
      qos,
      health: health(healthGauge),
      latestBlock,
      upstreamCount: upstreams.length,
    };
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
        this.prom.query(qEndpointHealth(spec)),
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

    const [requests, scores, healthRows, blocks, inFlight, latency, rateRows, changeRows] =
      await Promise.all([
      this.prom.query(
        `sum by (endpoint_id, spec) (increase(${ENDPOINT_METRICS.totalRelaysServiced}${sel}[${r}]))`,
      ),
      // Gauges fold replicas (avg / max by endpoint) — raw selectors return one
      // series per pod and the Map below would keep whichever came last.
      this.prom.query(qEndpointScores(spec)),
      this.prom.query(qEndpointHealth(spec)),
      this.prom.query(qEndpointLatestBlock(spec)),
      this.prom.query(
        `sum by (endpoint_id) (${ENDPOINT_METRICS.requestsInFlight}${sel})`,
      ),
      // Per-endpoint p95 latency — the endpoint histogram carries endpoint_id.
      this.prom.query(
        `histogram_quantile(0.95, sum by (endpoint_id, le) (rate(${ENDPOINT_METRICS.latencyBucket}${sel}[${r}])))`,
      ),
      // Block rate + tip-change count turn the raw block lag below into the
      // seconds-behind figure the roster leads with, and into a stale flag.
      this.prom.query(qBlockRateBySpec(spec)),
      this.prom.query(qTipChanges(spec)),
    ]);

    // Config-derived identity: node name → role/interface (helm marks backups;
    // SR_CONFIG has no backup marker, so role stays null there) + every router
    // that declares the name. The series only carries `endpoint_id`, so the
    // config is the sole source of router attribution.
    const roleByName = new Map<string, { role: "primary" | "backup"; iface: string | null }>();
    const routersByName = new Map<string, string[]>();
    if (this.configSvc) {
      for (const router of this.configSvc.getRouters()) {
        for (const node of router.nodes) {
          if (!roleByName.has(node.name)) {
            roleByName.set(node.name, {
              role: node.isBackup ? "backup" : "primary",
              iface: node.endpoints[0]?.interface ?? null,
            });
          }
          const ids = routersByName.get(node.name);
          if (!ids) routersByName.set(node.name, [router.id]);
          else if (!ids.includes(router.id)) ids.push(router.id);
        }
      }
    }
    const isHelm = this.configSvc
      ? this.configSvc.getRouters().some((rt) => rt.localPort === null && rt.nodes.length > 0)
      : false;

    const byId = new Map<string, UpstreamMetrics>();
    const ensure = (endpointId: string, specLabel: string): UpstreamMetrics => {
      let row = byId.get(endpointId);
      if (!row) {
        const cfg = roleByName.get(endpointId);
        row = {
          endpointId,
          spec: specLabel,
          requests: 0,
          uptime: null,
          p95Ms: null,
          errorRate: null,
          scores: {},
          health: "unknown",
          latestBlock: null,
          blockLag: null,
          behindSec: null,
          stale: false,
          // Only helm-format configs can mark backups; SR_CONFIG ⇒ null.
          role: cfg && isHelm ? cfg.role : null,
          apiInterface: cfg?.iface ?? null,
          inFlight: 0,
          routerIds: routersByName.get(endpointId) ?? [],
        };
        byId.set(endpointId, row);
      }
      return row;
    };

    for (const s of requests) {
      const id = s.metric.endpoint_id;
      if (!id) continue;
      // Relay counts are whole events — round off increase() extrapolation.
      ensure(id, s.metric.spec ?? "").requests = Math.round(Number(s.value[1]) || 0);
    }
    for (const s of scores) {
      const id = s.metric.endpoint_id;
      const type = s.metric.score_type as ScoreType | undefined;
      if (!id || !type) continue;
      ensure(id, s.metric.spec ?? "").scores[type] = Number(s.value[1]);
    }
    for (const s of healthRows) {
      const id = s.metric.endpoint_id;
      if (!id) continue;
      ensure(id, s.metric.spec ?? "").health = health(Number(s.value[1]));
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
    // The roster keys rows by endpoint_id alone, so an endpoint on two
    // interfaces gets the WORST (lowest) change count of the two — a freeze on
    // either interface is worth surfacing on the row.
    const changesById = new Map<string, number>();
    for (const s2 of changeRows) {
      const id = s2.metric.endpoint_id;
      const v = Number(s2.value[1]);
      if (!id || !Number.isFinite(v)) continue;
      const cur = changesById.get(id);
      if (cur === undefined || v < cur) changesById.set(id, v);
    }
    for (const row of byId.values()) {
      const bps = rateBySpec.get(row.spec);
      row.behindSec = row.blockLag !== null && bps !== undefined ? row.blockLag / bps : null;
      row.stale = isStale(changesById.get(row.endpointId), bps);
    }

    // Uptime + error rate per endpoint = success/total over the window, keyed
    // by provider_address (= the endpoint name) on the router request counters.
    const [okByProv, totByProv] = await Promise.all([
      this.prom.query(`sum by (provider_address) (increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]))`),
      this.prom.query(`sum by (provider_address) (increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]))`),
    ]);
    const okMap = new Map(okByProv.map((s) => [s.metric.provider_address ?? "", Number(s.value[1]) || 0]));
    for (const s of totByProv) {
      const id = s.metric.provider_address;
      if (!id) continue;
      const tot = Number(s.value[1]) || 0;
      const row = byId.get(id);
      if (row && tot > 0) {
        row.uptime = (okMap.get(id) ?? 0) / tot;
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
   * Traffic tab: aggregate RPS-now + per-chain rows (rpsNow, requests, share,
   * trend sparkline). Mirrors the design's "Requests / sec · N chains" view.
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
    const end = Math.floor(Date.now() / 1000);
    const start = end - win.rangeSeconds;
    const specs = await this.listSpecs();

    const [aggMatrix, totalAll] = await Promise.all([
      this.prom.queryRange(qClientRpsSeriesExpr(win.step), start, end, win.step),
      this.prom.scalar(qClientRequestsTotal(undefined, window)),
    ]);
    const aggPoints = toPoints(aggMatrix[0]?.values);

    const chains = await Promise.all(
      specs.map(async (spec) => {
        const meta = buildChainMetaByIndex(spec);
        const [trendMatrix, requests] = await Promise.all([
          this.prom.queryRange(qClientRpsSeriesExpr(win.step, spec), start, end, win.step),
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
          `sum by (method) (increase(${ROUTER_METRICS.requestsReadTotal}${sel}[${r}]))`,
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
    const end = Math.floor(Date.now() / 1000);
    const start = end - win.rangeSeconds;
    const expr = qClientRpsSeriesExpr(win.step, spec);
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
