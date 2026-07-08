/**
 * Ops Dashboard payload (Dashboard page, Overview + Metrics tabs) in one
 * round-trip. Every populated field maps to a real `smartrouter_*` /
 * `rpc_endpoint_*` series; families the router does not emit (failover ratio,
 * cache, regions, SCU quota, labelled error classes, upstream incidents,
 * errors-handled interventions) come back as `null` so the UI renders the
 * design's own empty states — values are never invented.
 */
import {
  ENDPOINT_METRICS,
  ROUTER_METRICS,
  buildChainMetaByIndex,
  qAvailability,
  qAvailabilitySeriesExpr,
  qErrorCount,
  qErrorCountSeriesExpr,
  qErrorRateSeriesExpr,
  qLatencyQuantile,
  qLatencySeriesExpr,
  qPerUpstreamRpsExpr,
  qPerSpecRpsExpr,
  qRpsSeriesExpr,
  rangeFor,
  selector,
  type DashboardChainMeta,
  type DashboardChainSeries,
  type DashboardData,
  type DashboardUpstreamSeries,
  type Kpi,
  type MetricWindow,
} from "@sr/shared";
import { WINDOWS, stepSeconds } from "@sr/shared/constants";
import type { PromMatrixSample, PrometheusClient } from "./prometheus-client.js";
import { health, toGridPoints } from "./metrics.js";

export class MetricsDashboardService {
  constructor(private readonly prom: PrometheusClient) {}

  /** Matrix rows grouped by `spec` → named/coloured chain series. */
  private chainSeries(
    matrix: PromMatrixSample[],
    grid: { start: number; end: number; step: number },
    onlySpec?: string,
  ): DashboardChainSeries[] {
    const rows: DashboardChainSeries[] = [];
    for (const m of matrix) {
      const spec = m.metric.spec;
      if (!spec || (onlySpec && spec !== onlySpec)) continue;
      const meta = buildChainMetaByIndex(spec);
      // Grid-align: every per-chain series MUST share one time axis, else the
      // multi-series chart (which x-maps by index) renders garbage.
      rows.push({
        spec,
        name: meta.name,
        color: meta.color,
        points: toGridPoints(m.values, grid.start, grid.end, grid.step),
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Matrix rows keyed by an upstream-name label → upstream series. */
  private upstreamSeries(
    matrix: PromMatrixSample[],
    label: "provider_address" | "endpoint_id",
    grid: { start: number; end: number; step: number },
  ): DashboardUpstreamSeries[] {
    const rows: DashboardUpstreamSeries[] = [];
    for (const m of matrix) {
      const upstream = m.metric[label];
      if (!upstream) continue;
      rows.push({ upstream, points: toGridPoints(m.values, grid.start, grid.end, grid.step) });
    }
    return rows.sort((a, b) => a.upstream.localeCompare(b.upstream));
  }

  async dashboard(window: MetricWindow, spec?: string): Promise<DashboardData> {
    const win = WINDOWS[window];
    const end = Math.floor(Date.now() / 1000);
    const start = end - win.rangeSeconds;
    const step = win.step; // Prometheus duration string (e.g. "5m") for queryRange
    const stepSec = stepSeconds(window); // numeric seconds for grid alignment
    const grid = { start, end, step: stepSec };
    const r = rangeFor(window);
    const sel = selector({ spec });

    // KPI value + its prior-window counterpart (offset PromQL range).
    const kpi = async (cur: string, prior: string): Promise<Kpi> => {
      const [value, p] = await Promise.all([this.prom.scalar(cur), this.prom.scalar(prior)]);
      return { value, prior: p };
    };
    const range = (expr: string) => this.prom.queryRange(expr, start, end, step);

    // Per-spec latency-quantile series: qLatencyQuantile keeps the (spec, le)
    // grouping — swap the window range for the step to get per-bucket values
    // (same rewrite metrics.ts uses for the overview latency series).
    const perSpecLatencyExpr = (q: number) =>
      qLatencyQuantile(q, undefined, window).replace(`[${r}]`, `[${step}]`);
    // Per-chain availability-ratio series (success/total grouped by spec).
    const perSpecSrExpr = `clamp_max(sum by (spec) (rate(${ROUTER_METRICS.requestsSuccessTotal}[${step}])) / sum by (spec) (rate(${ROUTER_METRICS.requestsTotal}[${step}])), 1)`;
    // Per-upstream p95 — the endpoint histogram carries endpoint_id.
    const perUpstreamLatencyExpr = `histogram_quantile(0.95, sum by (endpoint_id, le) (rate(${ENDPOINT_METRICS.latencyBucket}${sel}[${step}])))`;

    const [successRate, p95Ms, rps, errorsNow, errorsPrior] = await Promise.all([
      kpi(qAvailability(spec, window), qAvailability(spec, window, r)),
      kpi(qLatencyQuantile(0.95, spec, window), qLatencyQuantile(0.95, spec, window, r)),
      kpi(
        `sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[5m]))`,
        `sum(rate(${ROUTER_METRICS.requestsTotal}${sel}[5m] offset ${r}))`,
      ),
      this.prom.scalar(qErrorCount(spec, window)),
      this.prom.scalar(qErrorCount(spec, window, r)),
    ]);

    const [
      throughput,
      errorsSeries,
      errorRateSeries,
      srSeries,
      latP50,
      latP95,
      latP99,
      perSpecRps,
      perSpecSr,
      chainLatP50,
      chainLatP95,
      chainLatP99,
      upstreamMix,
      upstreamLatP95,
      specRows,
      healthRows,
    ] = await Promise.all([
      range(qRpsSeriesExpr(step, spec)),
      range(qErrorCountSeriesExpr(step, spec)),
      range(qErrorRateSeriesExpr(step, spec)),
      range(qAvailabilitySeriesExpr(step, spec)),
      range(qLatencySeriesExpr(0.5, step, spec)),
      range(qLatencySeriesExpr(0.95, step, spec)),
      range(qLatencySeriesExpr(0.99, step, spec)),
      range(qPerSpecRpsExpr(step)),
      range(perSpecSrExpr),
      range(perSpecLatencyExpr(0.5)),
      range(perSpecLatencyExpr(0.95)),
      range(perSpecLatencyExpr(0.99)),
      range(qPerUpstreamRpsExpr(step, spec)),
      range(perUpstreamLatencyExpr),
      this.prom.query(`count by (spec) (${ROUTER_METRICS.requestsTotal})`),
      this.prom.query(`max by (spec) (${ENDPOINT_METRICS.overallHealth})`),
    ]);

    const healthBySpec = new Map<string, number>();
    for (const row of healthRows) {
      const v = Number(row.value[1]);
      if (row.metric.spec && Number.isFinite(v)) healthBySpec.set(row.metric.spec, v);
    }
    const chains: DashboardChainMeta[] = specRows
      .map((row) => row.metric.spec)
      .filter((s): s is string => Boolean(s))
      .sort()
      .map((s) => {
        const meta = buildChainMetaByIndex(s);
        return {
          spec: s,
          name: meta.name,
          color: meta.color,
          health: health(healthBySpec.get(s) ?? null),
        };
      });

    return {
      kpis: {
        successRate,
        p95Ms,
        errors: { value: errorsNow, prior: errorsPrior },
        rps,
        // Needs failover/hedge/retry counters — absent on this build.
        errorsHandled: { value: null, prior: null },
      },
      series: {
        // All series share ONE (start, end, step) grid so multi-series charts
        // (which x-map by point index) line up; absent buckets become null.
        throughput: toGridPoints(throughput[0]?.values, start, end, stepSec),
        errors: toGridPoints(errorsSeries[0]?.values, start, end, stepSec),
        errorRate: toGridPoints(errorRateSeries[0]?.values, start, end, stepSec),
        successRate: toGridPoints(srSeries[0]?.values, start, end, stepSec),
        latency: {
          p50: toGridPoints(latP50[0]?.values, start, end, stepSec),
          p95: toGridPoints(latP95[0]?.values, start, end, stepSec),
          p99: toGridPoints(latP99[0]?.values, start, end, stepSec),
        },
        perChain: this.chainSeries(perSpecRps, grid, spec),
        perChainSuccessRate: this.chainSeries(perSpecSr, grid, spec),
        perChainLatency: {
          p50: this.chainSeries(chainLatP50, grid, spec),
          p95: this.chainSeries(chainLatP95, grid, spec),
          p99: this.chainSeries(chainLatP99, grid, spec),
        },
        upstreamMix: this.upstreamSeries(upstreamMix, "provider_address", grid),
        perUpstreamLatencyP95: this.upstreamSeries(upstreamLatP95, "endpoint_id", grid),
      },
      chains,
      scu: null,
      regions: null,
      failoverRatio: null,
      internalAvailability: null,
      cacheHitRate: null,
      errorClasses: null,
      errorsHandledBreakdown: null,
      contribution: null,
      upstreamAvailability: null,
      scorecard: null,
      trouble: [],
      lastUpdated: new Date().toISOString(),
    };
  }
}
