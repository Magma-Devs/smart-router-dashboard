/**
 * Deep-dive metrics behind the design's drill-in surfaces: ChainDetail series,
 * the upstream PMBody, the Errors-breakdown tab, CurrentlyUnavailable, and the
 * cross-validation / websocket Traffic panels. Same honesty contract as
 * MetricsService: absent families ⇒ nulls/empty + `emitted:false`, never
 * invented numbers. Optional families are probed with qPresence so panels
 * light up automatically the first time the router registers them.
 */
import {
  ENDPOINT_METRICS,
  OPTIONAL_METRICS,
  ROUTER_METRICS,
  buildChainMetaByIndex,
  qAvailabilitySeriesExpr,
  qBackupShareExpr,
  qChainDown,
  qEndpointBlockLagSeriesExpr,
  qEndpointLatencyQuantile,
  qEndpointLatencySeriesExpr,
  qErrorCount,
  qErrorCountSeriesExpr,
  qErrorRateSeriesExpr,
  qErrorsBy,
  qLatencySeriesExpr,
  qOptimizerScore,
  qPresence,
  qUpstreamErrorRate,
  qUpstreamReadVolumeSeriesExpr,
  qUpstreamVolumeSeriesExpr,
  qRpsSeriesExpr,
  qScoreExpr,
  rangeFor,
  selector,
  SCORE_TYPES,
  type ChainSeries,
  type CrossValidationReport,
  type ErrorsReport,
  type MetricWindow,
  type UpstreamDetail,
  type ScoreType,
  type TimePoint,
  type UnavailableChain,
  type WebSocketReport,
} from "@sr/shared";
import { WINDOWS } from "@sr/shared/constants";
import type { PrometheusClient } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import { health, toPoints } from "./metrics.js";

export class MetricsDetailService {
  constructor(
    private readonly prom: PrometheusClient,
    private readonly configSvc?: ConfigurationService,
  ) {}

  private windowBounds(window: MetricWindow): { start: number; end: number; step: string } {
    const win = WINDOWS[window];
    const end = Math.floor(Date.now() / 1000);
    return { start: end - win.rangeSeconds, end, step: win.step };
  }

  private async familyPresent(metricName: string): Promise<boolean> {
    const v = await this.prom.scalar(qPresence(metricName));
    return v !== null && v > 0;
  }

  private async series(expr: string, window: MetricWindow): Promise<TimePoint[]> {
    const { start, end, step } = this.windowBounds(window);
    const matrix = await this.prom.queryRange(expr, start, end, step);
    return toPoints(matrix[0]?.values);
  }

  /** ChainDetail metric-switcher bundle (fetched on row expand only). */
  async chainSeries(spec: string, window: MetricWindow): Promise<ChainSeries> {
    const { step } = this.windowBounds(window);

    // Backup share only exists when the config marks backups (helm format).
    const backupNames = (this.configSvc?.getRouters() ?? [])
      .filter((r) => r.spec === spec)
      .flatMap((r) => r.nodes.filter((n) => n.isBackup).map((n) => n.name));

    const [availability, p95Ms, errorRate, rps, qosProbe, backupShare] = await Promise.all([
      this.series(qAvailabilitySeriesExpr(step, spec), window),
      this.series(qLatencySeriesExpr(0.95, step, spec), window),
      this.series(qErrorRateSeriesExpr(step, spec), window),
      this.series(qRpsSeriesExpr(step, spec), window),
      this.series(qOptimizerScore("composite", spec), window),
      backupNames.length
        ? this.series(qBackupShareExpr(spec, backupNames, step), window)
        : Promise.resolve(null),
    ]);

    // Optimizer score may be absent (older builds) — fall back to the
    // endpoint-scope composite; both empty ⇒ null (honest "no QoS data").
    let qos: TimePoint[] | null = qosProbe.some((p) => p.v !== null) ? qosProbe : null;
    if (!qos) {
      const endpointScore = await this.series(qScoreExpr("composite", spec), window);
      qos = endpointScore.some((p) => p.v !== null) ? endpointScore : null;
    }

    return { spec, availability, p95Ms, errorRate, rps, qos, backupShare };
  }

  /** PMBody payload for one backing endpoint. */
  async upstreamDetail(endpointId: string, window: MetricWindow): Promise<UpstreamDetail> {
    const { step } = this.windowBounds(window);
    const r = rangeFor(window);
    const epSel = selector({ endpoint_id: endpointId });
    const provSel = selector({ provider_address: endpointId });

    // Resolve the endpoint's spec (needed for block-lag math and links).
    const healthRows = await this.prom.query(`${ENDPOINT_METRICS.overallHealth}${epSel}`);
    const spec = healthRows[0]?.metric.spec ?? "";
    const healthVal = healthRows.length ? Number(healthRows[0]!.value[1]) : null;

    const [
      requests,
      rpsNow,
      availability,
      errorRate,
      p50,
      p95,
      p99,
      inFlight,
      scoreRows,
      blockLagNow,
    ] = await Promise.all([
      this.prom.scalar(`sum(increase(${ROUTER_METRICS.requestsTotal}${provSel}[${r}]))`),
      this.prom.scalar(`sum(rate(${ROUTER_METRICS.requestsTotal}${provSel}[5m]))`),
      this.prom.scalar(
        `clamp_max(sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${provSel}[${r}])) / sum(increase(${ROUTER_METRICS.requestsTotal}${provSel}[${r}])), 1)`,
      ),
      this.prom.scalar(qUpstreamErrorRate(endpointId, window)),
      this.prom.scalar(qEndpointLatencyQuantile(0.5, endpointId, window)),
      this.prom.scalar(qEndpointLatencyQuantile(0.95, endpointId, window)),
      this.prom.scalar(qEndpointLatencyQuantile(0.99, endpointId, window)),
      this.prom.scalar(`sum(${ENDPOINT_METRICS.requestsInFlight}${epSel})`),
      this.prom.query(`${ENDPOINT_METRICS.selectionScore}${epSel}`),
      spec
        ? this.prom.scalar(qEndpointBlockLagSeriesExpr(spec, endpointId))
        : Promise.resolve(null),
    ]);

    const scores: Partial<Record<ScoreType, number>> = {};
    for (const s of scoreRows) {
      const type = s.metric.score_type as ScoreType | undefined;
      if (type) scores[type] = Number(s.value[1]);
    }

    const [latP50, latP95, latP99, volTotal, volRead, blockLagSeries] = await Promise.all([
      this.series(qEndpointLatencySeriesExpr(0.5, endpointId, step), window),
      this.series(qEndpointLatencySeriesExpr(0.95, endpointId, step), window),
      this.series(qEndpointLatencySeriesExpr(0.99, endpointId, step), window),
      this.series(qUpstreamVolumeSeriesExpr(endpointId, step), window),
      this.series(qUpstreamReadVolumeSeriesExpr(endpointId, step), window),
      spec
        ? this.series(qEndpointBlockLagSeriesExpr(spec, endpointId), window)
        : Promise.resolve([] as TimePoint[]),
    ]);

    const scoreSeries: Partial<Record<ScoreType, TimePoint[]>> = {};
    await Promise.all(
      SCORE_TYPES.map(async (type) => {
        if (scores[type] === undefined) return; // only chart emitted score types
        scoreSeries[type] = await this.series(
          qScoreExpr(type, undefined, endpointId),
          window,
        );
      }),
    );

    // Error catalogs need labelled error counters the router doesn't emit yet.
    const [nodeErrs, protoErrs] = await Promise.all([
      this.familyPresent(OPTIONAL_METRICS.nodeErrorsTotal),
      this.familyPresent(OPTIONAL_METRICS.protocolErrorsTotal),
    ]);

    return {
      endpointId,
      spec,
      health: health(healthVal),
      availability,
      requests: requests ?? 0,
      rpsNow,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      errorRate,
      blockLag: blockLagNow,
      inFlight: inFlight ?? 0,
      scores,
      scoreSeries,
      latencySeries: { p50: latP50, p95: latP95, p99: latP99 },
      volume: { total: volTotal, read: volRead, write: null, batch: null },
      blockLagSeries,
      errorsByCode: [],
      recentErrors: [],
      emitted: { errorsByCode: nodeErrs || protoErrs, recentErrors: false },
    };
  }

  /** Errors-breakdown tab. Derived math is real; labelled pivots wait for
   *  their counter families. */
  async errors(window: MetricWindow, spec?: string): Promise<ErrorsReport> {
    const { start, end, step } = this.windowBounds(window);

    const [total, trendMatrix, byChainRows, byMethodRows, byPairRows, families] =
      await Promise.all([
        this.prom.scalar(qErrorCount(spec, window)),
        this.prom.queryRange(qErrorCountSeriesExpr(step, spec), start, end, step),
        this.prom.query(qErrorsBy("spec", window, spec)),
        this.prom.query(qErrorsBy("method", window, spec)),
        // Hotspots need BOTH labels on one vector.
        this.prom.query(
          `clamp_min(sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}])) - (sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsSuccessTotal}${selector({ spec })}[${rangeFor(window)}])) or sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}])) * 0), 0)`,
        ),
        Promise.all([
          this.familyPresent(OPTIONAL_METRICS.requestsFailedTotal),
          this.familyPresent(OPTIONAL_METRICS.nodeErrorsTotal),
          this.familyPresent(OPTIONAL_METRICS.protocolErrorsTotal),
        ]),
      ]);

    const requestsByPair = await this.prom.query(
      `sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}]))`,
    );
    const reqByPair = new Map(
      requestsByPair.map((s) => [
        `${s.metric.spec ?? ""}|${s.metric.provider_address ?? ""}`,
        Number(s.value[1]) || 0,
      ]),
    );

    const totalErrors = total ?? 0;
    const pivotRows = (
      rows: { metric: Record<string, string | undefined>; value: [number, string] }[],
      label: "spec" | "method",
    ) =>
      rows
        .map((s) => {
          const key = s.metric[label] ?? "";
          const errors = Number(s.value[1]) || 0;
          return {
            key,
            label: label === "spec" ? buildChainMetaByIndex(key).name : key,
            errors,
            share: totalErrors > 0 ? errors / totalErrors : null,
          };
        })
        .filter((p) => p.key && p.errors > 0)
        .sort((a, b) => b.errors - a.errors);

    // Hotspots: (chain × upstream) pairs with errors, worst first; sparkline
    // trends only for the top rows (bounded fan-out).
    const hotspotRows = byPairRows
      .map((s) => {
        const pairSpec = s.metric.spec ?? "";
        const upstream = s.metric.provider_address ?? "";
        const errors = Number(s.value[1]) || 0;
        const requests = reqByPair.get(`${pairSpec}|${upstream}`) ?? 0;
        const meta = buildChainMetaByIndex(pairSpec);
        return {
          spec: pairSpec,
          name: meta.name,
          color: meta.color,
          upstream,
          errors,
          requests,
          errorRate: requests > 0 ? errors / requests : null,
          trend: [] as TimePoint[],
        };
      })
      .filter((h) => h.spec && h.upstream && h.errors > 0)
      .sort((a, b) => b.errors - a.errors);

    await Promise.all(
      hotspotRows.slice(0, 5).map(async (h) => {
        h.trend = await this.series(
          `clamp_min(sum(increase(${ROUTER_METRICS.requestsTotal}${selector({ spec: h.spec, provider_address: h.upstream })}[${step}])) - sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${selector({ spec: h.spec, provider_address: h.upstream })}[${step}])), 0)`,
          window,
        );
      }),
    );

    return {
      total: totalErrors,
      trend: toPoints(trendMatrix[0]?.values),
      hotspots: hotspotRows,
      pivots: {
        chain: pivotRows(byChainRows, "spec"),
        method: pivotRows(byMethodRows, "method"),
        // Populated only when the labelled error counters exist on the build.
        category: [],
        code: [],
        retryability: [],
      },
      families: {
        requestsFailedTotal: families[0],
        nodeErrorsTotal: families[1],
        protocolErrorsTotal: families[2],
      },
    };
  }

  /** Chains whose every backing endpoint reports down. */
  async unavailable(): Promise<UnavailableChain[]> {
    const rows = await this.prom.query(qChainDown());
    return rows
      .filter((s) => Number(s.value[1]) === 1)
      .map((s) => {
        const spec = s.metric.spec ?? "";
        const meta = buildChainMetaByIndex(spec);
        return {
          spec,
          name: meta.name,
          color: meta.color,
          // "down since" needs a subquery; null is the honest first pass.
          sinceSeconds: null,
        };
      })
      .filter((c) => c.spec);
  }

  /** Cross-validation panel; consistency_* is real and reported alongside. */
  async crossValidation(window: MetricWindow): Promise<CrossValidationReport> {
    const r = rangeFor(window);
    const emitted = await this.familyPresent(OPTIONAL_METRICS.crossValidationTotal);

    const [consTotal, consCaught] = await Promise.all([
      this.prom.scalar(`sum(increase(${ROUTER_METRICS.consistencyTotal}[${r}]))`),
      this.prom.scalar(`sum(increase(${ROUTER_METRICS.consistencySuccessTotal}[${r}]))`),
    ]);

    if (!emitted) {
      return {
        emitted: false,
        rounds: null,
        consensusRate: null,
        disagreements: null,
        byChain: [],
        consistency: { total: consTotal ?? 0, caught: consCaught ?? 0 },
      };
    }

    const [rounds, ok, byChainRows] = await Promise.all([
      this.prom.scalar(`sum(increase(${OPTIONAL_METRICS.crossValidationTotal}[${r}]))`),
      this.prom.scalar(`sum(increase(${OPTIONAL_METRICS.crossValidationSuccessTotal}[${r}]))`),
      this.prom.query(
        `sum by (spec) (increase(${OPTIONAL_METRICS.crossValidationTotal}[${r}]))`,
      ),
    ]);
    return {
      emitted: true,
      rounds,
      consensusRate: rounds && rounds > 0 && ok !== null ? ok / rounds : null,
      disagreements: rounds !== null && ok !== null ? Math.max(0, rounds - ok) : null,
      byChain: byChainRows.map((s) => ({
        spec: s.metric.spec ?? "",
        rounds: Number(s.value[1]) || 0,
        consensusRate: null,
      })),
      consistency: { total: consTotal ?? 0, caught: consCaught ?? 0 },
    };
  }

  /** WebSocket panel; ws_* counters appear once a subscription opens. */
  async websocket(window: MetricWindow): Promise<WebSocketReport> {
    const emitted = await this.familyPresent(OPTIONAL_METRICS.wsConnectionsActive);
    if (!emitted) {
      return {
        emitted: false,
        activeConnections: null,
        subscriptions: null,
        subscriptionErrors: null,
        byChain: [],
      };
    }
    const r = rangeFor(window);
    const [active, subs, errs, byChainRows] = await Promise.all([
      this.prom.scalar(`sum(${OPTIONAL_METRICS.wsConnectionsActive})`),
      this.prom.scalar(`sum(increase(${OPTIONAL_METRICS.wsSubscriptionsTotal}[${r}]))`),
      this.prom.scalar(`sum(increase(${OPTIONAL_METRICS.wsSubscriptionErrorsTotal}[${r}]))`),
      this.prom.query(`sum by (spec) (increase(${OPTIONAL_METRICS.wsSubscriptionsTotal}[${r}]))`),
    ]);
    return {
      emitted: true,
      activeConnections: active,
      subscriptions: subs,
      subscriptionErrors: errs,
      byChain: byChainRows.map((s) => ({
        spec: s.metric.spec ?? "",
        subscriptions: Number(s.value[1]) || 0,
        errors: 0,
      })),
    };
  }
}
