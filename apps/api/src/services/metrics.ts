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
  qErrorCount,
  qErrorRate,
  qErrorsBy,
  qLatencyDistribution,
  qLatencyQuantile,
  qLatestBlock,
  qPresence,
  qRequestsBy,
  qRequestsTotal,
  selector,
  rangeFor,
  type ChainMetrics,
  type HealthState,
  type HeroSummary,
  type Kpi,
  type MethodClassTotals,
  type MethodUsage,
  type MetricWindow,
  type UpstreamMetrics,
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

    const [retriesPresent, cachePresent] = await Promise.all([
      this.familyPresent(OPTIONAL_METRICS.retriesSuccessTotal),
      this.familyPresent(OPTIONAL_METRICS.cacheTotalHits),
    ]);

    const [requestsServed, successRate, p95, stale, specs, upstreams, healthGauge] =
      await Promise.all([
        kpi(qRequestsTotal(spec, window), qRequestsTotal(spec, window, r)),
        kpi(qAvailability(spec, window), qAvailability(spec, window, r)),
        // No cache on this build ⇒ the documented derived "effective read p95"
        // reduces to the node read p95 (the overall router histogram).
        kpi(qLatencyQuantile(0.95, spec, window), qLatencyQuantile(0.95, spec, window, r)),
        kpi(
          `sum(increase(${ROUTER_METRICS.consistencySuccessTotal}${specSel}[${r}]))`,
          `sum(increase(${ROUTER_METRICS.consistencySuccessTotal}${specSel}[${r}] offset ${r}))`,
        ),
        this.listSpecs(),
        // Endpoint health keys on `endpoint_id`, NOT `spec`, so it can't be
        // spec-filtered here — upstreamCount + health stay account-wide even
        // when a chain is selected (the KPIs above are the ones that scope).
        this.prom.query(`count by (endpoint_id) (${ENDPOINT_METRICS.overallHealth})`),
        this.prom.scalar(ROUTER_METRICS.overallHealth),
      ]);

    const retriesRecovered: Kpi = retriesPresent
      ? await kpi(
          `sum(increase(${OPTIONAL_METRICS.retriesSuccessTotal}${specSel}[${r}]))`,
          `sum(increase(${OPTIONAL_METRICS.retriesSuccessTotal}${specSel}[${r}] offset ${r}))`,
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
      kpi(qRequestsTotal(spec, window), qRequestsTotal(spec, window, r)),
      kpi(`sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[5m]))`, `sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[5m] offset ${r}))`),
      kpi(qAvailability(spec, window), qAvailability(spec, window, r)),
      kpi(qLatencyQuantile(0.5, spec, window), qLatencyQuantile(0.5, spec, window, r)),
      kpi(qLatencyQuantile(0.95, spec, window), qLatencyQuantile(0.95, spec, window, r)),
      kpi(qLatencyQuantile(0.99, spec, window), qLatencyQuantile(0.99, spec, window, r)),
      this.prom.scalar(qAvailability(spec, window)),
      this.prom.scalar(ROUTER_METRICS.overallHealth),
      this.prom.queryRange(`sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[${win.step}]))`, start, end, win.step),
      this.prom.queryRange(`clamp_min(sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[${win.step}])) - sum(rate(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${win.step}])), 0)`, start, end, win.step),
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
            this.prom.queryRange(
              `sum(rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${win.step}]))`,
              start,
              end,
              win.step,
            ),
          ]);
          return { spec, name: meta.name, color: meta.color, p50Ms: p50c, trend: toPoints(trend[0]?.values), degraded: h !== null && h < 1 };
        }),
      ),
      this.activeRoutes(window),
      Promise.all(
        specs.map(async (spec) => {
          const meta = buildChainMetaByIndex(spec);
          const m = await this.prom.queryRange(
            `sum(rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${win.step}]))`,
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
        requests: Number(s.value[1]) || 0,
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

  async chains(window: MetricWindow): Promise<ChainMetrics[]> {
    const specs = await this.listSpecs();
    return Promise.all(specs.map((spec) => this.chainRow(spec, window)));
  }

  private async chainRow(spec: string, window: MetricWindow): Promise<ChainMetrics> {
    const meta = buildChainMetaByIndex(spec);
    const [requests, availability, errorRate, p95, qos, healthGauge, latestBlock, upstreams] =
      await Promise.all([
        this.prom.scalar(qRequestsTotal(spec, window)),
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

  async upstreams(spec: string | undefined, window: MetricWindow): Promise<UpstreamMetrics[]> {
    const sel = selector({ spec });
    const r = rangeFor(window);

    const [requests, scores, healthRows, blocks, inFlight, latency] = await Promise.all([
      this.prom.query(
        `sum by (endpoint_id, spec) (increase(${ENDPOINT_METRICS.totalRelaysServiced}${sel}[${r}]))`,
      ),
      this.prom.query(`${ENDPOINT_METRICS.selectionScore}${sel}`),
      this.prom.query(`${ENDPOINT_METRICS.overallHealth}${sel}`),
      this.prom.query(`${ENDPOINT_METRICS.latestBlock}${sel}`),
      this.prom.query(
        `sum by (endpoint_id) (${ENDPOINT_METRICS.requestsInFlight}${sel})`,
      ),
      // Per-endpoint p95 latency — the endpoint histogram carries endpoint_id.
      this.prom.query(
        `histogram_quantile(0.95, sum by (endpoint_id, le) (rate(${ENDPOINT_METRICS.latencyBucket}${sel}[${r}])))`,
      ),
    ]);

    // Config-derived identity: node name → role/interface (helm marks backups;
    // SR_CONFIG has no backup marker, so role stays null there).
    const roleByName = new Map<string, { role: "primary" | "backup"; iface: string | null }>();
    if (this.configSvc) {
      for (const router of this.configSvc.getRouters()) {
        for (const node of router.nodes) {
          if (!roleByName.has(node.name)) {
            roleByName.set(node.name, {
              role: node.isBackup ? "backup" : "primary",
              iface: node.endpoints[0]?.interface ?? null,
            });
          }
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
          // Only helm-format configs can mark backups; SR_CONFIG ⇒ null.
          role: cfg && isHelm ? cfg.role : null,
          apiInterface: cfg?.iface ?? null,
          inFlight: 0,
        };
        byId.set(endpointId, row);
      }
      return row;
    };

    for (const s of requests) {
      const id = s.metric.endpoint_id;
      if (!id) continue;
      ensure(id, s.metric.spec ?? "").requests = Number(s.value[1]) || 0;
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

    return [...byId.values()].sort((a, b) => b.requests - a.requests);
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
      this.prom.queryRange(
        `sum(rate(${ROUTER_METRICS.requestsTotal}[${win.step}]))`,
        start,
        end,
        win.step,
      ),
      this.prom.scalar(qRequestsTotal(undefined, window)),
    ]);
    const aggPoints = toPoints(aggMatrix[0]?.values);

    const chains = await Promise.all(
      specs.map(async (spec) => {
        const meta = buildChainMetaByIndex(spec);
        const [trendMatrix, requests] = await Promise.all([
          this.prom.queryRange(
            `sum(rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${win.step}]))`,
            start,
            end,
            win.step,
          ),
          this.prom.scalar(qRequestsTotal(spec, window)),
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
   * Method-level breakdown + read/write/batch class totals. `read` is real
   * (requests_read_total); write/batch counters are absent until the router
   * emits them. Per-method error rate is real (total − success, both carry
   * `method`); per-method p95 stays null — the latency histogram has no
   * `method` label on this build (Gap #3).
   */
  async methods(
    spec: string | undefined,
    window: MetricWindow,
  ): Promise<{ methods: MethodUsage[]; classTotals: MethodClassTotals }> {
    const sel = selector({ spec });
    const r = rangeFor(window);
    const [rows, reads, errRows, writePresent, batchPresent] = await Promise.all([
      this.prom.query(qRequestsBy("method", window, spec)),
      this.prom.query(
        `sum by (method) (increase(${ROUTER_METRICS.requestsReadTotal}${sel}[${r}]))`,
      ),
      this.prom.query(qErrorsBy("method", window, spec)),
      this.familyPresent(OPTIONAL_METRICS.requestsWriteTotal),
      this.familyPresent(OPTIONAL_METRICS.requestsBatchTotal),
    ]);
    const readSet = new Set(reads.map((s) => s.metric.method).filter(Boolean));
    const errByMethod = new Map(
      errRows.map((s) => [s.metric.method ?? "", Number(s.value[1]) || 0]),
    );

    const methods = rows
      .map((s) => {
        const method = s.metric.method ?? "unknown";
        const requests = Number(s.value[1]) || 0;
        const errors = errByMethod.get(method) ?? 0;
        return {
          method,
          class: (readSet.has(method) ? "read" : "unknown") as MethodUsage["class"],
          requests,
          p95Ms: null, // histogram has no `method` label on this build (Gap #3)
          errorRate: requests > 0 ? errors / requests : null,
        };
      })
      .sort((a, b) => b.requests - a.requests);

    const [readTotal, writeTotal, batchTotal] = await Promise.all([
      this.prom.scalar(`sum(increase(${ROUTER_METRICS.requestsReadTotal}${sel}[${r}]))`),
      writePresent
        ? this.prom.scalar(`sum(increase(${OPTIONAL_METRICS.requestsWriteTotal}${sel}[${r}]))`)
        : Promise.resolve(null),
      batchPresent
        ? this.prom.scalar(`sum(increase(${OPTIONAL_METRICS.requestsBatchTotal}${sel}[${r}]))`)
        : Promise.resolve(null),
    ]);
    const allTotal = methods.reduce((s, m) => s + m.requests, 0);
    const classTotals: MethodClassTotals = {
      read: readTotal ?? 0,
      write: writeTotal,
      batch: batchTotal,
      unclassified: Math.max(0, allTotal - (readTotal ?? 0) - (writeTotal ?? 0) - (batchTotal ?? 0)),
      emitted: { write: writePresent, batch: batchPresent },
    };

    return { methods, classTotals };
  }

  /** RPS time-series for the Traffic chart. */
  async rpsSeries(spec: string | undefined, window: MetricWindow): Promise<TimeSeries> {
    const win = WINDOWS[window];
    const end = Math.floor(Date.now() / 1000);
    const start = end - win.rangeSeconds;
    const expr = `sum(rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${win.step}]))`;
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
