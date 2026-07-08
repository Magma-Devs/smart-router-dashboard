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

    const [nodeErrs, protoErrs] = await Promise.all([
      this.familyPresent(OPTIONAL_METRICS.nodeErrorsTotal),
      this.familyPresent(OPTIONAL_METRICS.protocolErrorsTotal),
    ]);

    const availOver = (w: MetricWindow) =>
      this.prom.scalar(
        `clamp_max(sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${provSel}[${rangeFor(w)}])) / sum(increase(${ROUTER_METRICS.requestsTotal}${provSel}[${rangeFor(w)}])), 1)`,
      );

    const [
      last1h,
      last24h,
      last7d,
      transportErrors,
      nodeErrorCount,
      protoErrorCount,
      nodeByMethodRows,
      cvAgree,
      cvDisagree,
    ] = await Promise.all([
      availOver("1h"),
      availOver("1d"),
      availOver("7d"),
      this.prom.scalar(
        `round(clamp_min(sum(increase(${ROUTER_METRICS.requestsTotal}${provSel}[${r}])) - sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${provSel}[${r}])), 0))`,
      ),
      nodeErrs
        ? this.prom.scalar(
            `round(sum(increase(${OPTIONAL_METRICS.nodeErrorsTotal}${provSel}[${r}])))`,
          )
        : Promise.resolve(0),
      protoErrs
        ? this.prom.scalar(
            `round(sum(increase(${OPTIONAL_METRICS.protocolErrorsTotal}${provSel}[${r}])))`,
          )
        : Promise.resolve(0),
      nodeErrs
        ? this.prom.query(
            `round(sum by (method) (increase(${OPTIONAL_METRICS.nodeErrorsTotal}${provSel}[${r}])))`,
          )
        : Promise.resolve([] as Awaited<ReturnType<PrometheusClient["query"]>>),
      this.prom.scalar(
        `round(sum(increase(${OPTIONAL_METRICS.crossValidationAgreementsTotal}${provSel}[${r}])))`,
      ),
      this.prom.scalar(
        `round(sum(increase(${OPTIONAL_METRICS.crossValidationDisagreementsTotal}${provSel}[${r}])))`,
      ),
    ]);

    const nodeErrorsByMethod = nodeByMethodRows
      .map((s) => ({ method: s.metric.method ?? "unknown", count: Number(s.value[1]) || 0 }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    const agree = cvAgree ?? 0;
    const disagree = cvDisagree ?? 0;

    return {
      endpointId,
      spec,
      health: health(healthVal),
      availability,
      requests: Math.round(requests ?? 0),
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
      availabilityWindows: { last1h, last24h, last7d },
      errorSplit: {
        node: nodeErrorCount ?? 0,
        protocol: protoErrorCount ?? 0,
        transport: transportErrors ?? 0,
      },
      nodeErrorsByMethod,
      crossValidation: {
        agreements: agree,
        disagreements: disagree,
        disagreementRate: agree + disagree > 0 ? disagree / (agree + disagree) : null,
      },
      // The classified errors_total carries codes but NO provider label, so a
      // per-UPSTREAM by-code catalog still can't be built honestly;
      // nodeErrorsByMethod above is the per-upstream breakdown.
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
          `round(clamp_min(sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}])) - (sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsSuccessTotal}${selector({ spec })}[${rangeFor(window)}])) or sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}])) * 0), 0))`,
        ),
        Promise.all([
          this.familyPresent(OPTIONAL_METRICS.requestsFailedTotal),
          this.familyPresent(OPTIONAL_METRICS.nodeErrorsTotal),
          this.familyPresent(OPTIONAL_METRICS.protocolErrorsTotal),
        ]),
      ]);

    const requestsByPair = await this.prom.query(
      `round(sum by (spec, provider_address) (increase(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[${rangeFor(window)}])))`,
    );

    // Real error-class breakdown. `transport` = derived relay failures
    // (total − success; node errors count as transport SUCCESS — verified
    // empirically: a -32601 reply increments requests_success_total). node /
    // protocol come from the labelled counters; absent family ⇒ zero events.
    const [nodePresent, protoPresent] = [families[1], families[2]];
    const sel = selector({ spec });
    const rr = rangeFor(window);

    // Classified errors — smartrouter_errors_total carries {chain_id (NOT
    // spec), error_category ∈ internal|external, error_name, retryable}.
    // When present it powers the code / category / retryability pivots the
    // design asked for.
    const classifiedPresent = await this.familyPresent(
      OPTIONAL_METRICS.errorsClassifiedTotal,
    );
    const clSel = selector({ chain_id: spec });
    const clQ = (by: string) =>
      this.prom.query(
        `round(sum by (${by}) (increase(${OPTIONAL_METRICS.errorsClassifiedTotal}${clSel}[${rr}])))`,
      );
    const [byName, byCategory, byRetryable] = classifiedPresent
      ? await Promise.all([clQ("error_name"), clQ("error_category"), clQ("retryable")])
      : [[], [], []];
    const classifiedRows = (
      rows: Awaited<ReturnType<PrometheusClient["query"]>>,
      label: string,
      pretty: (v: string) => string,
    ) => {
      const parsed = rows
        .map((s) => ({ key: s.metric[label] ?? "", errors: Number(s.value[1]) || 0 }))
        .filter((r) => r.key && r.errors > 0);
      const sum = parsed.reduce((a, r) => a + r.errors, 0);
      return parsed
        .map((r) => ({ key: r.key, label: pretty(r.key), errors: r.errors, share: sum > 0 ? r.errors / sum : null }))
        .sort((a, b) => b.errors - a.errors);
    };
    const codePivot = classifiedRows(byName, "error_name", (v) => v);
    const categoryClassified = classifiedRows(byCategory, "error_category", (v) =>
      v === "internal" ? "Internal (router / transport)" : v === "external" ? "External (upstream)" : v,
    );
    const retryabilityPivot = classifiedRows(byRetryable, "retryable", (v) =>
      v === "true" ? "Retryable" : "Non-retryable",
    );
    const [nodeTotal, protoTotal, nodeByPairMethod] = await Promise.all([
      nodePresent
        ? this.prom.scalar(
            `round(sum(increase(${OPTIONAL_METRICS.nodeErrorsTotal}${sel}[${rr}])))`,
          )
        : Promise.resolve(0),
      protoPresent
        ? this.prom.scalar(
            `round(sum(increase(${OPTIONAL_METRICS.protocolErrorsTotal}${sel}[${rr}])))`,
          )
        : Promise.resolve(0),
      nodePresent
        ? this.prom.query(
            `round(sum by (spec, provider_address, method) (increase(${OPTIONAL_METRICS.nodeErrorsTotal}${sel}[${rr}])))`,
          )
        : Promise.resolve([] as Awaited<ReturnType<PrometheusClient["query"]>>),
    ]);
    const nodeMethodsByPair = new Map<string, { method: string; count: number }[]>();
    for (const s of nodeByPairMethod) {
      const key = `${s.metric.spec ?? ""}|${s.metric.provider_address ?? ""}`;
      const count = Number(s.value[1]) || 0;
      if (count <= 0) continue;
      const list = nodeMethodsByPair.get(key) ?? [];
      list.push({ method: s.metric.method ?? "unknown", count });
      nodeMethodsByPair.set(key, list);
    }
    for (const list of nodeMethodsByPair.values()) list.sort((a, b) => b.count - a.count);
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
          nodeMethods: (nodeMethodsByPair.get(`${pairSpec}|${upstream}`) ?? []).slice(0, 5),
        };
      })
      .filter((h) => h.spec && h.upstream && (h.errors > 0 || h.nodeMethods.length > 0))
      .sort((a, b) => b.errors - a.errors);

    await Promise.all(
      hotspotRows.slice(0, 5).map(async (h) => {
        // round(): un-rounded increase() extrapolation can put a bucket ABOVE
        // the window's headline total (e.g. a 77 spike on 60 errors) — whole
        // errors per bucket keep the trend reconcilable with the total.
        h.trend = await this.series(
          `round(clamp_min(sum(increase(${ROUTER_METRICS.requestsTotal}${selector({ spec: h.spec, provider_address: h.upstream })}[${step}])) - sum(increase(${ROUTER_METRICS.requestsSuccessTotal}${selector({ spec: h.spec, provider_address: h.upstream })}[${step}])), 0))`,
          window,
        );
      }),
    );

    // Error classes: transport failures (derived), node errors (upstream
    // answered with a JSON-RPC error), protocol errors. All whole numbers.
    const classCounts = [
      { key: "node-error", label: "Node errors (upstream JSON-RPC)", errors: nodeTotal ?? 0 },
      { key: "protocol-error", label: "Protocol errors", errors: protoTotal ?? 0 },
      { key: "transport", label: "Transport / routing failures", errors: totalErrors },
    ].filter((c) => c.errors > 0);
    const classSum = classCounts.reduce((s, c) => s + c.errors, 0);

    return {
      total: totalErrors,
      trend: toPoints(trendMatrix[0]?.values),
      hotspots: hotspotRows,
      pivots: {
        chain: pivotRows(byChainRows, "spec"),
        method: pivotRows(byMethodRows, "method"),
        // Design semantics: WHO caused it (internal vs external), from the
        // classified counter; the node/protocol/transport class split is the
        // honest fallback until that family fires.
        category: categoryClassified.length
          ? categoryClassified
          : classCounts.map((c) => ({
              key: c.key,
              label: c.label,
              errors: c.errors,
              share: classSum > 0 ? c.errors / classSum : null,
            })),
        // Real per-code catalog from smartrouter_errors_total{error_name}.
        code: codePivot,
        retryability: retryabilityPivot,
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

  /**
   * Cross-validation panel — built on the families the router ACTUALLY
   * registers (`…cross_validation_requests_total` etc.; there is no bare
   * `…cross_validation_total`, which is why this panel used to stay dark
   * forever). consistency_* is real and reported alongside.
   */
  async crossValidation(window: MetricWindow): Promise<CrossValidationReport> {
    const r = rangeFor(window);
    const [emitted, consistencyFailedPresent] = await Promise.all([
      this.familyPresent(OPTIONAL_METRICS.crossValidationRequestsTotal),
      this.familyPresent(OPTIONAL_METRICS.consistencyFailedTotal),
    ]);

    // total = checks run; caught = checks that FAILED (an absent
    // consistency_failed_total family means zero failures since boot).
    // consistency_success_total counts checks that PASSED — never "caught".
    const [consTotal, consCaught] = await Promise.all([
      this.prom.scalar(`round(sum(increase(${ROUTER_METRICS.consistencyTotal}[${r}])))`),
      consistencyFailedPresent
        ? this.prom.scalar(
            `round(sum(increase(${OPTIONAL_METRICS.consistencyFailedTotal}[${r}])))`,
          )
        : Promise.resolve(0),
    ]);
    const consistency = { total: consTotal ?? 0, caught: consCaught ?? 0 };

    if (!emitted) {
      return {
        emitted: false,
        rounds: null,
        consensusRate: null,
        disagreements: null,
        failuresByReason: [],
        byChain: [],
        consistency,
      };
    }

    const [rounds, ok, reasonRows, bySpecRounds, bySpecOk, bySpecNoAgree] = await Promise.all([
      this.prom.scalar(
        `round(sum(increase(${OPTIONAL_METRICS.crossValidationRequestsTotal}[${r}])))`,
      ),
      this.prom.scalar(
        `round(sum(increase(${OPTIONAL_METRICS.crossValidationSuccessTotal}[${r}])))`,
      ),
      this.prom.query(
        `round(sum by (reason) (increase(${OPTIONAL_METRICS.crossValidationFailuresTotal}[${r}])))`,
      ),
      this.prom.query(
        `round(sum by (spec) (increase(${OPTIONAL_METRICS.crossValidationRequestsTotal}[${r}])))`,
      ),
      this.prom.query(
        `round(sum by (spec) (increase(${OPTIONAL_METRICS.crossValidationSuccessTotal}[${r}])))`,
      ),
      this.prom.query(
        `round(sum by (spec) (increase(${OPTIONAL_METRICS.crossValidationFailuresTotal}{reason="no-agreement"}[${r}])))`,
      ),
    ]);

    const okBySpec = new Map(
      bySpecOk.map((s) => [s.metric.spec ?? "", Number(s.value[1]) || 0]),
    );
    const noAgreeBySpec = new Map(
      bySpecNoAgree.map((s) => [s.metric.spec ?? "", Number(s.value[1]) || 0]),
    );
    const failuresByReason = reasonRows
      .map((s) => ({ reason: s.metric.reason ?? "unknown", count: Number(s.value[1]) || 0 }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
    // True disagreements = rounds that failed because responses didn't match —
    // NOT rounds−success (that would count capacity/timeout failures too).
    const disagreements =
      failuresByReason.find((x) => x.reason === "no-agreement")?.count ?? 0;

    return {
      emitted: true,
      rounds,
      consensusRate: rounds && rounds > 0 && ok !== null ? ok / rounds : null,
      disagreements,
      failuresByReason,
      byChain: bySpecRounds
        .map((s) => {
          const spec = s.metric.spec ?? "";
          const rds = Number(s.value[1]) || 0;
          const okc = okBySpec.get(spec) ?? 0;
          return {
            spec,
            rounds: rds,
            consensusRate: rds > 0 ? okc / rds : null,
            disagreements: noAgreeBySpec.get(spec) ?? 0,
          };
        })
        .filter((c) => c.spec && c.rounds > 0),
      consistency,
    };
  }

  /**
   * WebSocket panel; ws_* counters appear once a subscription opens.
   *
   * Totals are LIFETIME (instant sums), not windowed increase(): these
   * counters are tiny and a windowed increase() misses a young counter's
   * first increment entirely (counter birth), showing "0 subscriptions"
   * right after a real subscription fired. The UI labels them
   * "since router start".
   */
  async websocket(_window: MetricWindow): Promise<WebSocketReport> {
    const emitted = await this.familyPresent(OPTIONAL_METRICS.wsSubscriptionsTotal);
    if (!emitted) {
      return {
        emitted: false,
        activeConnections: null,
        subscriptions: null,
        subscriptionErrors: null,
        byChain: [],
      };
    }
    const [active, subs, errs, byChainRows, errsByChainRows, activeByChainRows] =
      await Promise.all([
        this.prom.scalar(`sum(${OPTIONAL_METRICS.wsConnectionsActive})`),
        this.prom.scalar(`round(sum(${OPTIONAL_METRICS.wsSubscriptionsTotal}))`),
        this.prom.scalar(`round(sum(${OPTIONAL_METRICS.wsSubscriptionErrorsTotal}))`),
        this.prom.query(`round(sum by (spec) (${OPTIONAL_METRICS.wsSubscriptionsTotal}))`),
        this.prom.query(`round(sum by (spec) (${OPTIONAL_METRICS.wsSubscriptionErrorsTotal}))`),
        // Live per-chain connections — the gauge carries `spec`.
        this.prom.query(`sum by (spec) (${OPTIONAL_METRICS.wsConnectionsActive})`),
      ]);
    const errsBySpec = new Map(
      errsByChainRows.map((s) => [s.metric.spec ?? "", Number(s.value[1]) || 0]),
    );
    const activeBySpec = new Map(
      activeByChainRows.map((s) => [s.metric.spec ?? "", Number(s.value[1]) || 0]),
    );
    return {
      emitted: true,
      activeConnections: active,
      subscriptions: subs,
      // Errors counter absent (never fired) ⇒ zero errors, not unknown.
      subscriptionErrors: errs ?? 0,
      byChain: byChainRows.map((s) => ({
        spec: s.metric.spec ?? "",
        active: activeBySpec.get(s.metric.spec ?? "") ?? 0,
        subscriptions: Number(s.value[1]) || 0,
        errors: errsBySpec.get(s.metric.spec ?? "") ?? 0,
      })),
    };
  }
}
