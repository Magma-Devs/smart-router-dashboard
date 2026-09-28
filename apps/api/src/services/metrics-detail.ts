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
  qClassifiedErrorsByChainAndName,
  qCrossValidationAgreementsByUpstream,
  qCrossValidationDisagreementsByUpstream,
  qCrossValidationFailedByReason,
  qCrossValidationRounds,
  qSelectionScores,
  qAnsweredWithin,
  qTipMovement,
  qTipNow,
  qLatencySeriesExpr,
  qNodeErrorsByUpstream,
  qOptimizerScore,
  qPeakServedRateByUpstream,
  qPresence,
  qRelaysServicedByUpstream,
  qUnreachableByUpstream,
  qUpstreamErrorRate,
  qUpstreamReadVolumeSeriesExpr,
  qUpstreamVolumeSeriesExpr,
  qClientRpsSeriesExpr,
  qScoreExpr,
  rangeFor,
  selector,
  SCORE_TYPES,
  type ChainSeries,
  type CrossValidationReport,
  type ErrorsReport,
  type MetricWindow,
  type ProviderFault,
  type ProviderFaultsReport,
  type StatusReport,
  type UpstreamDetail,
  type ScoreType,
  type TimePoint,
  type UnavailableChain,
  type WebSocketReport,
} from "@sr/shared";
import { DEFAULT_WINDOW, WINDOWS } from "@sr/shared/constants";
import type { PrometheusClient, PromVectorSample } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import { health, toPoints } from "./metrics.js";
import { buildStatusReport, type StatusCell } from "./status.js";

/** How long a computed status report is served as-is before a background
 *  refresh — matched to the page's own 15s poll. */
const STATUS_TTL_MS = 15 * 1000;
/** Standing-loop tick. Faster is fake: Prometheus scrapes the router every
 *  15s, so the truth itself changes at most that often. */
const STATUS_LOOP_MS = 30 * 1000;
/** How long a non-default window stays in the loop after its last request —
 *  someone viewing 15m keeps it warm; when they leave, it drops out. */
const STATUS_WANTED_TTL_MS = 5 * 60 * 1000;

/** How long a status report's week-long baselines are held before re-read. */
const BASELINE_TTL_MS = 10 * 60 * 1000;
/** How long a FAILED baseline read is remembered before retrying. Without
 *  this, every poll re-fires reads a slow Prometheus already timed out on,
 *  and they clog the gate until the whole report misses the page's clock. */
const BASELINE_RETRY_MS = 2 * 60 * 1000;

export class MetricsDetailService {
  constructor(
    private readonly prom: PrometheusClient,
    private readonly configSvc?: ConfigurationService,
  ) {}

  /** Does this config router declare an upstream by that name? The metrics
   *  carry `provider_address` (the node name) and nothing about routers, so the
   *  mounted values file is the only place the question can be answered. */
  private declaredBy(routerId: string, upstream: string): boolean {
    const router = this.configSvc?.getRouters().find((r) => r.id === routerId);
    return router ? router.nodes.some((n) => n.name === upstream) : false;
  }

  private windowBounds(window: MetricWindow): { start: number; end: number; step: string } {
    const win = WINDOWS[window];
    const end = Math.floor(Date.now() / 1000);
    return { start: end - win.rangeSeconds, end, step: win.step };
  }

  private async familyPresent(metricName: string, strict = false): Promise<boolean> {
    const v = strict ? await this.prom.scalarStrict(qPresence(metricName)) : await this.prom.scalar(qPresence(metricName));
    return v !== null && v > 0;
  }

  /**
   * A grouped `sum(increase(...))` that survives a slow Prometheus. Short
   * windows read as one instant query. From 3h up, the same total is read as
   * 30-minute slices via a range query and summed here: one big `increase`
   * over a high-cardinality counter can outlive the metrics server's own
   * request timeout (measured: a 6h total over ~25k series dies at a 15s
   * ingress wall), while the sliced form answers in seconds because each
   * evaluation only touches 30 minutes of samples. The seams between slices
   * lose a little extrapolation at counter resets — the same trade the 24h
   * timing reads already make.
   */
  private async sumIncrease(groupBy: string, metricWithSelector: string, window: MetricWindow): Promise<PromVectorSample[]> {
    const secs = WINDOWS[window].rangeSeconds;
    const by = groupBy ? `sum by (${groupBy})` : "sum";
    if (secs < 3 * 3600) {
      return this.prom.queryStrict(`round(${by} (increase(${metricWithSelector}[${secs}s])))`);
    }
    // One request per 2h of history, merged here. The split must be across
    // HTTP requests, not steps inside one: the server's ingress cuts a
    // request at its own deadline no matter how it is stepped, and total
    // evaluation work is the same either way. 2h per request is measured to
    // pass where a 6h single read does not; the gate bounds the fan-out.
    const now = Math.floor(Date.now() / 1000);
    const chunk = secs <= 6 * 3600 ? 3600 : 7200;
    const spans: [number, number][] = [];
    for (let t = now - secs; t < now; t += chunk) spans.push([t, Math.min(t + chunk, now)]);
    const parts = await Promise.all(
      spans.map(([a, b]) =>
        this.prom.queryRangeStrict(`${by} (increase(${metricWithSelector}[1800s]))`, a + 1800, b, "1800"),
      ),
    );
    const totals = new Map<string, { metric: PromVectorSample["metric"]; sum: number }>();
    for (const rows of parts) {
      for (const row of rows) {
        const key = JSON.stringify(row.metric);
        const t = totals.get(key) ?? { metric: row.metric, sum: 0 };
        t.sum += row.values.reduce((a, [, v]) => a + (Number(v) || 0), 0);
        totals.set(key, t);
      }
    }
    return [...totals.values()].map((t) => ({
      metric: t.metric,
      value: [now, String(Math.round(t.sum))] as [number, string],
    }));
  }

  private async sumIncreaseScalar(metricWithSelector: string, window: MetricWindow): Promise<number | null> {
    const rows = await this.sumIncrease("", metricWithSelector, window);
    const v = rows[0] ? Number(rows[0].value[1]) : null;
    return v != null && Number.isFinite(v) ? v : null;
  }

  /** In-flight status reads by window — see `status()`. */
  private readonly statusInflight = new Map<string, Promise<StatusReport>>();
  /** Last computed report per window, served instantly while a refresh runs. */
  private readonly statusCache = new Map<string, { at: number; report: StatusReport }>();
  /** window → when it was last requested; keeps recently viewed windows in the loop. */
  private readonly statusWanted = new Map<string, number>();
  private statusLoop: ReturnType<typeof setInterval> | null = null;

  /**
   * The standing loop: compute the status continuously, viewer or no viewer.
   * A dashboard that only measures while someone looks misses every incident
   * that recovers between visits, and can never notify anyone. The default
   * window is always kept current; other windows ride along for a few
   * minutes after someone viewed them. Failures are swallowed — the cache
   * keeps the last good report and the next tick retries.
   */
  startStatusLoop(): void {
    if (this.statusLoop) return;
    this.statusLoop = setInterval(() => {
      const now = Date.now();
      const wanted = new Set<MetricWindow>([DEFAULT_WINDOW]);
      for (const [w, at] of this.statusWanted) {
        if (now - at < STATUS_WANTED_TTL_MS) wanted.add(w as MetricWindow);
        else this.statusWanted.delete(w);
      }
      for (const w of wanted) {
        const cached = this.statusCache.get(w);
        if (cached && now - cached.at < STATUS_TTL_MS) continue;
        this.refreshStatus(w, w).catch(() => {});
      }
    }, STATUS_LOOP_MS);
    // Never hold the process open for the loop's sake.
    this.statusLoop.unref?.();
  }

  stopStatusLoop(): void {
    if (this.statusLoop) clearInterval(this.statusLoop);
    this.statusLoop = null;
  }

  /**
   * Week-long baselines (`offset 7d`, `[7d:1h]` subqueries, the 7d share)
   * are the heaviest reads in a status report and move slowly, so they are
   * held for `BASELINE_TTL_MS` and shared across polls. Keyed by the
   * evaluated query text, so a different window is a different entry.
   * A rejected read is not kept — the next poll retries it.
   */
  private readonly baselineCache = new Map<string, { at: number; ok: boolean; value: Promise<unknown> }>();
  private baseline<T>(key: string, read: () => Promise<T>): Promise<T> {
    const hit = this.baselineCache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < (hit.ok ? BASELINE_TTL_MS : BASELINE_RETRY_MS)) return hit.value as Promise<T>;
    const value: Promise<T> = read().then(
      (v) => v,
      (err: unknown) => {
        const cur = this.baselineCache.get(key);
        if (cur?.value === value) this.baselineCache.set(key, { ...cur, ok: false });
        throw err;
      },
    );
    this.baselineCache.set(key, { at: now, ok: true, value });
    return value;
  }
  // Baselines are tolerant where the core counts are strict: they only feed
  // "vs last week" comparisons, and every consumer treats a missing baseline
  // as "no history". A slow Prometheus hour should cost the comparisons, not
  // the report. The failed read is not cached, so the next poll retries it.
  private baselineQuery(expr: string): Promise<PromVectorSample[]> {
    return this.baseline(`q|${expr}`, () => this.prom.queryStrict(expr)).catch(() => []);
  }
  private baselineScalar(expr: string): Promise<number | null> {
    return this.baseline(`s|${expr}`, () => this.prom.scalarStrict(expr)).catch(() => null);
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

    const [availability, p95Ms, errorRate, rps, qosProbe, backupProbe] = await Promise.all([
      this.series(qAvailabilitySeriesExpr(step, spec), window),
      this.series(qLatencySeriesExpr(0.95, step, spec), window),
      this.series(qErrorRateSeriesExpr(step, spec), window),
      // CLIENT-scoped, matching the Traffic tab and the hero "Requests served"
      // card. The relay-scoped counter (qRpsSeriesExpr) counts health probes
      // and one increment per cross-validation participant, so this chart used
      // to show a permanent non-zero floor on an idle chain (MAG-2737).
      this.series(qClientRpsSeriesExpr(step, spec), window),
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

    // A backup selector that matched nothing is "no data", NOT "0% backup".
    // Collapsing the empty matrix to null here keeps the two cases distinct for
    // the UI — same treatment `qos` above already gets.
    const backupShare =
      backupProbe && backupProbe.some((p) => p.v !== null) ? backupProbe : null;

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
  /**
   * @param routerId Keep only the hotspots whose upstream the named CONFIG
   *   router declares. Hotspots are (chain × upstream) pairs, and the config
   *   says which router declares an upstream — so unlike the pivots below them,
   *   they CAN be attributed. The pivots stay deployment-wide: they aggregate by
   *   chain / method / error code, and no series says which router served a
   *   request. Callers narrow those by chain instead (a config router serves
   *   one chain, so selecting it implies its spec).
   */
  async errors(window: MetricWindow, spec?: string, routerId?: string): Promise<ErrorsReport> {
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
    // Birth-aware delta, NOT increase() — every error code is its own series,
    // born the first time that code fires, and increase() reads a series born
    // mid-window as 0. See qClassifiedErrorsByName for the verified case.
    const clM = `${OPTIONAL_METRICS.errorsClassifiedTotal}${clSel}`;
    const clQ = (by: string) =>
      this.prom.query(
        `round(sum by (${by}) ((${clM} - (${clM} offset ${rr})) or ${clM}))`,
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
          // Every node error on the pair, not just the top-5 methods shown.
          nodeErrors: (nodeMethodsByPair.get(`${pairSpec}|${upstream}`) ?? []).reduce(
            (sum, m) => sum + m.count,
            0,
          ),
        };
      })
      .filter((h) => h.spec && h.upstream && (h.errors > 0 || h.nodeMethods.length > 0))
      .filter((h) => routerId === undefined || this.declaredBy(routerId, h.upstream))
      // Pairs that FAILED first, worst first; then the node-error-only pairs,
      // which are here for a different reason and shouldn't outrank a failure.
      .sort((a, b) => b.errors - a.errors || b.nodeErrors - a.nodeErrors);

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

  /**
   * Per-upstream faults: which provider is failing, and on how many chains.
   *
   * Two independent counts per (provider × chain) — see `ProviderFault`. They
   * come from different families with different label names for the same thing
   * (`provider_address` on the router counter, `endpoint_id` on the endpoint
   * ones), so they are joined on the upstream name here rather than in PromQL.
   *
   * Providers are ranked by chains affected first, then by returned errors: a
   * provider degrading across six chains is a different incident from one
   * having a bad day on a single chain, and the count alone cannot tell them
   * apart — one busy chain outweighs five broken quiet ones.
   */
  async providerFaults(
    window: MetricWindow,
    spec?: string,
  ): Promise<ProviderFaultsReport> {
    const [nodePresent, erroredPresent] = await Promise.all([
      this.familyPresent(OPTIONAL_METRICS.nodeErrorsTotal),
      this.familyPresent(ENDPOINT_METRICS.totalErrored),
    ]);

    const [answered, unreachable, serviced, peakRates] = await Promise.all([
      nodePresent
        ? this.prom.query(qNodeErrorsByUpstream(window, spec))
        : Promise.resolve([]),
      erroredPresent
        ? this.prom.query(qUnreachableByUpstream(window, spec))
        : Promise.resolve([]),
      this.prom.query(qRelaysServicedByUpstream(window, spec)),
      this.prom.query(qPeakServedRateByUpstream(window, spec)),
    ]);

    /** (provider, spec) → every count, filled in from whichever family has it. */
    const cells = new Map<
      string,
      { provider: string; spec: string; answeredWithError: number; unreachable: number; relaysServiced: number; peakServedRps: number | null }
    >();
    const cell = (provider: string, specLabel: string) => {
      const key = `${provider}\u0000${specLabel}`;
      let c = cells.get(key);
      if (!c) {
        c = {
          provider,
          spec: specLabel,
          answeredWithError: 0,
          unreachable: 0,
          relaysServiced: 0,
          peakServedRps: null,
        };
        cells.set(key, c);
      }
      return c;
    };
    for (const s of answered) {
      const p = s.metric.provider_address;
      const sp = s.metric.spec;
      if (!p || !sp) continue;
      cell(p, sp).answeredWithError += Number(s.value[1]) || 0;
    }
    for (const s of unreachable) {
      const p = s.metric.endpoint_id;
      const sp = s.metric.spec;
      if (!p || !sp) continue;
      cell(p, sp).unreachable += Number(s.value[1]) || 0;
    }
    for (const s of serviced) {
      const p = s.metric.endpoint_id;
      const sp = s.metric.spec;
      if (!p || !sp) continue;
      cell(p, sp).relaysServiced += Number(s.value[1]) || 0;
    }
    for (const s of peakRates) {
      const p = s.metric.endpoint_id;
      const sp = s.metric.spec;
      if (!p || !sp) continue;
      const v = Number(s.value[1]);
      if (Number.isFinite(v)) cell(p, sp).peakServedRps = v;
    }

    const byProvider = new Map<string, ProviderFault>();
    for (const c of cells.values()) {
      // A (provider × chain) pair with neither kind of failure is just a
      // healthy upstream — it belongs on the roster, not on a faults page.
      if (c.answeredWithError <= 0 && c.unreachable <= 0) continue;
      let row = byProvider.get(c.provider);
      if (!row) {
        row = {
          provider: c.provider,
          answeredWithError: 0,
          unreachable: 0,
          chainsAffected: 0,
          chains: [],
        };
        byProvider.set(c.provider, row);
      }
      const attempts = c.relaysServiced + c.unreachable;
      row.answeredWithError += c.answeredWithError;
      row.unreachable += c.unreachable;
      row.chainsAffected += 1;
      row.chains.push({
        spec: c.spec,
        name: buildChainMetaByIndex(c.spec).name,
        answeredWithError: c.answeredWithError,
        unreachable: c.unreachable,
        relaysServiced: c.relaysServiced,
        errorRate: attempts > 0 ? c.unreachable / attempts : null,
      });
    }

    const providers = [...byProvider.values()]
      .map((p) => ({
        ...p,
        chains: p.chains.sort(
          (a, b) =>
            b.unreachable - a.unreachable ||
            b.answeredWithError - a.answeredWithError,
        ),
      }))
      .sort(
        (a, b) =>
          b.chainsAffected - a.chainsAffected ||
          b.answeredWithError + b.unreachable - (a.answeredWithError + a.unreachable),
      );

    return {
      emitted: { nodeErrors: nodePresent, endpointErrored: erroredPresent },
      providers,
    };
  }

  /**
   * The Status page in one round-trip.
   *
   * Prometheus plus the mounted config; no Loki, so it works on any
   * deployment. Baselines are offset queries — every "against its own history"
   * rule reads the same metric shifted back in time. The health gauge is never
   * used for timing (hourly epoch reset); durations come from counter history
   * and gauge flatness.
   */
  /**
   * The Status report. Identical in-flight reads are coalesced — the page,
   * the topbar pill and a second tab all poll the same window, and each read
   * fans out to ~35 queries. A failed Prometheus read rejects with
   * `PrometheusQueryError` (503) rather than producing a report missing one
   * input: on this page a half-read is a wrong verdict, not a gap.
   */
  async status(window: MetricWindow): Promise<StatusReport> {
    const key = window;
    this.statusWanted.set(key, Date.now());
    const cached = this.statusCache.get(key);
    const fresh = cached && Date.now() - cached.at < STATUS_TTL_MS;
    // Serve the last computed report immediately and refresh behind it when
    // it is past its TTL — on a slow Prometheus a full read takes 30s+, and a
    // page that blanks for 30s on every visit reads as broken. The report
    // carries `computedAtUnix`, so the page shows the data's real age.
    // The background refresh must swallow its own failure: the cache keeps
    // the last good report and the next poll retries. An uncaught rejection
    // here took the whole process down.
    if (cached && !fresh) this.refreshStatus(key, window).catch(() => {});
    if (cached) return cached.report;
    return this.refreshStatus(key, window);
  }

  private refreshStatus(key: string, window: MetricWindow): Promise<StatusReport> {
    const inflight = this.statusInflight.get(key);
    if (inflight) return inflight;
    const p = this.readStatus(window)
      .then((report) => {
        this.statusCache.set(key, { at: Date.now(), report });
        return report;
      })
      .finally(() => {
        if (this.statusInflight.get(key) === p) this.statusInflight.delete(key);
      });
    this.statusInflight.set(key, p);
    return p;
  }

  private async readStatus(window: MetricWindow): Promise<StatusReport> {
    const r = rangeFor(window);
    const E = ENDPOINT_METRICS;
    const R = ROUTER_METRICS;
    const nowSec = Math.floor(Date.now() / 1000);

    const [classifiedPresent, nodePresent, xvalPresent, consistencyPresent] = await Promise.all([
      this.familyPresent(OPTIONAL_METRICS.errorsClassifiedTotal, true),
      this.familyPresent(OPTIONAL_METRICS.nodeErrorsTotal, true),
      this.familyPresent(OPTIONAL_METRICS.crossValidationRequestsTotal, true),
      this.familyPresent(R.consistencyTotal, true),
    ]);

    const FATAL_RE = 'PROTOCOL_NO_PROVIDERS|PROTOCOL_ALL_ENDPOINTS_DISABLED|PROTOCOL_INSUFFICIENT_PROVIDERS';
    const upFail = `sum by (endpoint_id, spec) (rate(${E.totalErrored}[5m])) / clamp_min(sum by (endpoint_id, spec) (rate(${E.totalRelaysServiced}[5m])) + sum by (endpoint_id, spec) (rate(${E.totalErrored}[5m])), 1e-10)`;
    const chainNoAns15 = (offset: string) =>
      `sum by (spec) (increase(${E.totalErrored}[15m]${offset})) / clamp_min(sum by (spec) (increase(${E.totalRelaysServiced}[15m]${offset})) + sum by (spec) (increase(${E.totalErrored}[15m]${offset})), 1)`;

    const [
      badRows, noAnsRows, servedRows, peakRows, kindRows,
      failedAtt,
      tipMoveRows, tipRows, scoreRows,
      // chain window stats
      clientBySpec, withinBySpec, clientBySpecWas, withinBySpecWas, attemptsBySpec, attemptsBySpecWas,
      // upstream baselines
      avgRows, avgWasRows, failWasNum, badWasRows, failWasDen, servedDayRows,
      unviable6hRows, unviable1hRows,
      // verdict memory + movers + priors
      fatalRange, tipRange, erroredRange, nodeErrRange,
      mover15Now, mover15Was, moverEvents,
      priorClient, priorAttempts, priorFailed,
      // verification
      consChecks, consCaught, xvalRounds, xvalFailed, xvalDis, xvalAgr,
    ] = await Promise.all([
      nodePresent ? this.sumIncrease("provider_address, spec", OPTIONAL_METRICS.nodeErrorsTotal, window) : Promise.resolve([]),
      this.sumIncrease("endpoint_id, spec", E.totalErrored, window),
      this.sumIncrease("endpoint_id, spec", E.totalRelaysServiced, window),
      // Insight inputs, not verdict inputs — a failed read costs the
      // rate-limit ceiling / slower-than-history rows, never the report.
      this.prom.query(qPeakServedRateByUpstream(window)),
      classifiedPresent ? this.prom.queryStrict(qClassifiedErrorsByChainAndName(window)) : Promise.resolve([]),
      this.sumIncreaseScalar(OPTIONAL_METRICS.requestsFailedTotal, window),
      this.prom.queryStrict(qTipMovement(window)),
      this.prom.queryStrict(qTipNow()),
      this.prom.queryStrict(qSelectionScores()),

      this.sumIncrease("spec", R.latencyCount, window),
      this.sumIncrease("spec", `${R.latencyBucket}{le="10000"}`, window),
      this.baselineQuery(`round(sum by (spec) (increase(${R.latencyCount}[${r}] offset 7d)))`),
      this.baselineQuery(qAnsweredWithin(10000, window, undefined, "7d")),
      this.sumIncrease("spec", R.requestsTotal, window),
      this.baselineQuery(`round(sum by (spec) (increase(${R.requestsTotal}[${r}] offset 7d)))`),

      this.prom.query(`sum by (endpoint_id, spec) (rate(${E.latencySum}[${r}])) / (sum by (endpoint_id, spec) (rate(${E.latencyCount}[${r}])) > 0)`),
      this.baselineQuery(`sum by (endpoint_id, spec) (rate(${E.latencySum}[${r}] offset 7d)) / (sum by (endpoint_id, spec) (rate(${E.latencyCount}[${r}] offset 7d)) > 0)`),
      this.baselineQuery(`sum by (endpoint_id, spec) (increase(${E.totalErrored}[${r}] offset 7d))`),
      nodePresent ? this.baselineQuery(qNodeErrorsByUpstream(window, undefined, "7d")) : Promise.resolve([]),
      this.baselineQuery(`sum by (endpoint_id, spec) (increase(${E.totalRelaysServiced}[${r}] offset 7d))`),
      this.baselineQuery(`sum by (endpoint_id, spec) (increase(${E.totalRelaysServiced}[1d]))`),
      // Minutes unviable: 5m samples where >=50% of received relays errored.
      // "At least" figures — the health gauge resets hourly and is never used.
      this.baselineQuery(`sum_over_time(((${upFail}) >= bool 0.5)[6h:5m]) * 5`),
      this.baselineQuery(`sum_over_time(((${upFail}) >= bool 0.5)[1h:5m]) * 5`),

      classifiedPresent
        ? this.prom.queryRangeStrict(
            `sum by (chain_id) (increase(${OPTIONAL_METRICS.errorsClassifiedTotal}{error_name=~"${FATAL_RE}"}[5m]))`,
            nowSec - 86400, nowSec, "300",
          )
        : Promise.resolve([]),
      this.prom.queryRangeStrict(`max by (endpoint_id, spec) (${E.latestBlock})`, nowSec - 86400, nowSec, "300"),
      // Timings for the attention kinds: when did this upstream START failing
      // to answer / answering with errors, and is it still. Measured from the
      // counters' own history over 24h, never capped at the selected window.
      this.prom.queryRangeStrict(`sum by (endpoint_id, spec) (increase(${E.totalErrored}[5m]))`, nowSec - 86400, nowSec, "300"),
      nodePresent
        ? this.prom.queryRangeStrict(`sum by (provider_address, spec) (increase(${OPTIONAL_METRICS.nodeErrorsTotal}[5m]))`, nowSec - 86400, nowSec, "300")
        : Promise.resolve([]),

      this.prom.queryStrict(chainNoAns15("")),
      this.prom.queryStrict(chainNoAns15(" offset 1d")),
      this.prom.queryStrict(`sum by (spec) (increase(${E.totalErrored}[15m]))`),

      this.baselineScalar(`sum(increase(${R.latencyCount}[${r}] offset 7d))`),
      this.baselineScalar(`sum(increase(${R.requestsTotal}[${r}] offset 7d))`),
      this.baselineScalar(`sum(increase(${OPTIONAL_METRICS.requestsFailedTotal}[${r}] offset 7d))`),
      consistencyPresent ? this.sumIncrease("spec", R.consistencyTotal, window) : Promise.resolve([]),
      this.sumIncrease("spec", OPTIONAL_METRICS.consistencyFailedTotal, window),
      xvalPresent ? this.prom.queryStrict(qCrossValidationRounds(window)) : Promise.resolve([]),
      xvalPresent ? this.prom.queryStrict(qCrossValidationFailedByReason(window)) : Promise.resolve([]),
      // Disagreement is a reliability TREND, read over the week regardless of
      // the page window — "your provider disagreed with its peers a lot this
      // week" is the sentence, and a 30-minute sample cannot say it.
      xvalPresent ? this.baselineQuery(qCrossValidationDisagreementsByUpstream("7d")) : Promise.resolve([]),
      xvalPresent ? this.baselineQuery(qCrossValidationAgreementsByUpstream("7d")) : Promise.resolve([]),
    ]);

    // Roles + addons from the config — no metric knows which upstream a
    // deployment considers its backup.
    const roleOf = new Map<string, "primary" | "backup">();
    const addonsOf = new Map<string, Set<string>>();
    const perChain: Record<string, number> = {};
    for (const router of this.configSvc?.getRouters() ?? []) {
      perChain[router.spec] = router.nodes.length;
      for (const node of router.nodes) {
        const key = `${node.name}|${router.spec}`;
        if (!roleOf.has(key)) roleOf.set(key, node.isBackup ? "backup" : "primary");
        const set = addonsOf.get(key) ?? new Set<string>();
        for (const ep of node.endpoints) for (const a of ep.addons ?? []) set.add(a.toLowerCase());
        addonsOf.set(key, set);
      }
    }

    // The account-wide totals are the per-spec rows summed — reading them as
    // separate whole-counter queries doubled the two heaviest reads.
    const sumRows = (rows: PromVectorSample[]) => rows.reduce((a, r2) => a + (Number(r2.value[1]) || 0), 0);
    const attempts = sumRows(attemptsBySpec);
    const clientReqs = sumRows(clientBySpec);

    const cells = new Map<string, StatusCell>();
    const cell = (upstream: string, spec: string) => {
      const key = `${upstream}|${spec}`;
      let c = cells.get(key);
      if (!c) {
        c = {
          upstream, spec, noAnswer: 0, badAnswer: 0, served: 0,
          role: roleOf.get(key) ?? null, peakRps: null,
          tipMoves: null, tip: null, scores: {},
          errorsWas: null, answersWas: null,
        };
        cells.set(key, c);
      }
      return c;
    };
    const put = (
      rows: Awaited<ReturnType<PrometheusClient["query"]>>,
      label: "provider_address" | "endpoint_id",
      apply: (c: StatusCell, v: number) => void,
    ) => {
      for (const s of rows) {
        const up = s.metric[label];
        const spec = s.metric.spec;
        if (!up || !spec) continue;
        const v = Number(s.value[1]);
        if (Number.isFinite(v)) apply(cell(up, spec)!, v);
      }
    };
    put(badRows, "provider_address", (c, v) => { c.badAnswer += v; });
    // Same window one week earlier — the row's "was" frame. One rule for any
    // page window; missing history stays null, never zero.
    put(failWasNum, "endpoint_id", (c, v) => { c.errorsWas = (c.errorsWas ?? 0) + v; c.answersWas = (c.answersWas ?? 0) + v; });
    put(badWasRows, "provider_address", (c, v) => { c.errorsWas = (c.errorsWas ?? 0) + v; });
    put(failWasDen, "endpoint_id", (c, v) => { c.answersWas = (c.answersWas ?? 0) + v; });
    put(noAnsRows, "endpoint_id", (c, v) => { c.noAnswer += v; });
    put(servedRows, "endpoint_id", (c, v) => { c.served += v; });
    put(peakRows, "endpoint_id", (c, v) => { c.peakRps = v; });
    put(tipMoveRows, "endpoint_id", (c, v) => { c.tipMoves = v; });
    put(tipRows, "endpoint_id", (c, v) => { c.tip = v; });
    for (const s2 of scoreRows) {
      const up = s2.metric.endpoint_id, spec = s2.metric.spec, type = s2.metric.score_type;
      if (!up || !spec || !type) continue;
      const v = Number(s2.value[1]);
      if (Number.isFinite(v)) cell(up, spec).scores[type] = v;
    }

    const kindsBySpec = new Map<string, Record<string, number>>();
    for (const s2 of kindRows) {
      const spec = s2.metric.chain_id, name = s2.metric.error_name;
      if (!spec || !name) continue;
      const rec = kindsBySpec.get(spec) ?? {};
      rec[name] = (rec[name] ?? 0) + (Number(s2.value[1]) || 0);
      kindsBySpec.set(spec, rec);
    }

    // ── chain window stats ────────────────────────────────────────────────
    const specVal = (rows: Awaited<ReturnType<PrometheusClient["query"]>>) => {
      const m = new Map<string, number>();
      for (const s2 of rows) if (s2.metric.spec) m.set(s2.metric.spec, Number(s2.value[1]) || 0);
      return m;
    };
    // Slow answers = all answers − answers within 10s, from the bucket read
    // alone; the count was already read for the request totals.
    const cliM = specVal(clientBySpec), withinM = specVal(withinBySpec);
    const cliWasM = specVal(clientBySpecWas), withinWasM = specVal(withinBySpecWas);
    const slowOf = (cli: Map<string, number>, within: Map<string, number>, spec: string) =>
      Math.max(0, (cli.get(spec) ?? 0) - (within.get(spec) ?? 0));
    const attM = specVal(attemptsBySpec), attWasM = specVal(attemptsBySpecWas);
    const chainStats = [...new Set([...cliM.keys(), ...attM.keys()])].map((spec) => {
      const cliWas = cliWasM.get(spec) ?? 0;
      return {
        spec,
        clientRequests: Math.round(cliM.get(spec) ?? 0),
        slowAnswers: Math.round(slowOf(cliM, withinM, spec)),
        slowShareWas: cliWas > 0 ? slowOf(cliWasM, withinWasM, spec) / cliWas : null,
        attempts: Math.round(attM.get(spec) ?? 0),
        // Same window a week earlier; under 100 requests the ratio is noise.
        attemptsPerReqWas: cliWas >= 100 ? Math.round(((attWasM.get(spec) ?? 0) / cliWas) * 1000) / 1000 : null,
      };
    });

    // ── upstream baselines ────────────────────────────────────────────────
    const upKey = (s2: { metric: Record<string, string | undefined> }) =>
      `${s2.metric.endpoint_id}|${s2.metric.spec}`;
    const numMap = (rows: Awaited<ReturnType<PrometheusClient["query"]>>) => {
      const m = new Map<string, number>();
      for (const s2 of rows) {
        const v = Number(s2.value[1]);
        if (s2.metric.endpoint_id && s2.metric.spec && Number.isFinite(v)) m.set(upKey(s2), v);
      }
      return m;
    };
    const avgM = numMap(avgRows), avgWasM = numMap(avgWasRows);
    const fwNum = numMap(failWasNum), fwDen = numMap(failWasDen);
    const sDayM = numMap(servedDayRows);
    const un6M = numMap(unviable6hRows), un1M = numMap(unviable1hRows);
    const totDayBySpec = new Map<string, number>();
    for (const [k, v] of sDayM) {
      const spec = k.split("|")[1]!;
      totDayBySpec.set(spec, (totDayBySpec.get(spec) ?? 0) + v);
    }
    const baselines = [...cells.values()].map((c) => {
      const k = `${c.upstream}|${c.spec}`;
      const den = fwDen.get(k) ?? 0, numV = fwNum.get(k) ?? 0;
      const totDay = totDayBySpec.get(c.spec) ?? 0;
      return {
        upstream: c.upstream, spec: c.spec,
        avgMs: avgM.get(k) ?? null,
        avgWasMs: avgWasM.get(k) ?? null,
        failRateWas: den + numV > 0 ? numV / (den + numV) : null,
        shareDay: totDay > 0 ? (sDayM.get(k) ?? 0) / totDay : null,
        unviableMin6h: un6M.get(k) ?? null,
        unviableMin1h: un1M.get(k) ?? null,
      };
    });

    // ── timings: measured from history, never capped at the window ────────
    const timings: { key: string; firstSeenUnix: number | null; lastSeenUnix: number | null; ongoing: boolean | null }[] = [];
    let lastCritical24h: { spec: string; atUnix: number } | null = null;
    for (const series of fatalRange) {
      const spec = series.metric.chain_id;
      if (!spec) continue;
      const hot = (series.values ?? []).filter(([, v]) => Number(v) > 0);
      if (!hot.length) continue;
      const first = Number(hot[0]![0]), last = Number(hot[hot.length - 1]![0]);
      timings.push({ key: `${spec}:dead`, firstSeenUnix: first, lastSeenUnix: last, ongoing: nowSec - last < 600 });
      if (!lastCritical24h || last > lastCritical24h.atUnix) lastCritical24h = { spec, atUnix: last };
    }
    for (const series of tipRange) {
      const up = series.metric.endpoint_id, spec = series.metric.spec;
      if (!up || !spec) continue;
      const vals = series.values ?? [];
      if (vals.length < 2) continue;
      const lastVal = Number(vals[vals.length - 1]![1]);
      let changeAt: number | null = null;
      for (let i = vals.length - 1; i > 0; i--) {
        if (Number(vals[i - 1]![1]) !== lastVal) { changeAt = Number(vals[i]![0]); break; }
      }
      // frozen since the last observed change; if it never changed in 24h,
      // the freeze started at least 24h ago — report the range start.
      timings.push({
        key: `${spec}:${up}:stale`,
        firstSeenUnix: changeAt ?? Number(vals[0]![0]),
        lastSeenUnix: nowSec,
        ongoing: true,
      });
    }

    // Attention-kind timings: contiguous run of non-zero 5m buckets ending
    // at (or near) now, else the most recent run.
    const runOf = (values: [number, string][] | undefined) => {
      const hot = (values ?? []).filter(([, v]) => Number(v) > 0);
      if (!hot.length) return null;
      const last = Number(hot[hot.length - 1]![0]);
      // walk back while consecutive samples are hot
      let first = last;
      for (let i = hot.length - 2; i >= 0; i--) {
        const t = Number(hot[i]![0]);
        if (first - t <= 600) first = t; else break;
      }
      return { first, last, ongoing: nowSec - last < 600 };
    };
    for (const series of erroredRange) {
      const up = series.metric.endpoint_id, spec = series.metric.spec;
      if (!up || !spec) continue;
      const r0 = runOf(series.values);
      if (r0) timings.push({ key: `${spec}:${up}:no-answer`, firstSeenUnix: r0.first, lastSeenUnix: r0.last, ongoing: r0.ongoing });
    }
    for (const series of nodeErrRange) {
      const up = series.metric.provider_address, spec = series.metric.spec;
      if (!up || !spec) continue;
      const r0 = runOf(series.values);
      if (r0) timings.push({ key: `${spec}:${up}:answered-error`, firstSeenUnix: r0.first, lastSeenUnix: r0.last, ongoing: r0.ongoing });
    }

    // ── verification: what checked the answers, and who failed ───────────
    const consM = specVal(consChecks), caughtM = specVal(consCaught), roundsM = specVal(xvalRounds);
    const reasonsBySpec = new Map<string, Record<string, number>>();
    for (const s2 of xvalFailed) {
      const sp = s2.metric.spec, rs = s2.metric.reason;
      if (!sp || !rs) continue;
      const rec = reasonsBySpec.get(sp) ?? {};
      rec[rs] = (rec[rs] ?? 0) + Math.round(Number(s2.value[1]) || 0);
      reasonsBySpec.set(sp, rec);
    }
    const provBySpec = new Map<string, Map<string, { disagreed: number; agreed: number }>>();
    const bump = (rows: Awaited<ReturnType<PrometheusClient["query"]>>, k: "disagreed" | "agreed") => {
      for (const s2 of rows) {
        const sp = s2.metric.spec, up = s2.metric.provider_address;
        if (!sp || !up) continue;
        const m = provBySpec.get(sp) ?? new Map();
        const e = m.get(up) ?? { disagreed: 0, agreed: 0 };
        e[k] += Math.round(Number(s2.value[1]) || 0);
        m.set(up, e); provBySpec.set(sp, m);
      }
    };
    bump(xvalDis, "disagreed"); bump(xvalAgr, "agreed");
    const allSpecsForVer = new Set([...cells.values()].map((c) => c.spec));
    const verification = [...allSpecsForVer].map((sp) => ({
      spec: sp,
      consistencyChecks: consistencyPresent ? Math.round(consM.get(sp) ?? 0) : null,
      consistencyCaught: Math.round(caughtM.get(sp) ?? 0),
      xvalRounds: xvalPresent ? Math.round(roundsM.get(sp) ?? 0) : null,
      xvalFailedByReason: reasonsBySpec.get(sp) ?? {},
      byProvider: [...(provBySpec.get(sp)?.entries() ?? [])].map(([upstream, v]) => ({ upstream, ...v })),
    }));

    // ── worst mover: last 15 min vs the same 15 min yesterday ────────────
    const nowM = specVal(mover15Now), wasM = specVal(mover15Was), evM = specVal(moverEvents);
    let worstMover: { spec: string; metric: string; now: string; was: string } | null = null;
    let worstDelta = 0;
    for (const [spec, rate] of nowM) {
      const was = wasM.get(spec) ?? 0;
      const events = evM.get(spec) ?? 0;
      if (events < 5 || rate < 0.01) continue;
      const delta = rate - was;
      if (delta > worstDelta && (was === 0 || rate >= 3 * was)) {
        worstDelta = delta;
        worstMover = {
          spec, metric: "no-answer rate (last 15 min)",
          now: `${(rate * 100).toFixed(1)}%`, was: `${(was * 100).toFixed(2)}%`,
        };
      }
    }

    return buildStatusReport({
      cells: [...cells.values()],
      kinds: [...kindsBySpec.entries()].map(([spec, counts]) => ({ spec, counts })),
      declaredAddons: [...addonsOf.entries()].map(([key, set]) => {
        const [upstream = "", spec = ""] = key.split("|");
        return { upstream, spec, addons: [...set] };
      }),
      configuredPerChain: perChain,
      chainStats,
      baselines,
      timings,
      verification,
      lastCritical24h,
      worstMover,
      priorTotals: {
        requestsServed: priorClient == null ? null : Math.round(priorClient),
        attemptsPerRequest:
          priorAttempts != null && priorClient && priorClient > 0
            ? Math.round((priorAttempts / priorClient) * 1000) / 1000
            : null,
        upstreamFailureRate:
          priorFailed != null && priorAttempts && priorAttempts > 0
            ? priorFailed / priorAttempts
            : null,
      },
      totals: {
        requestsServed: Math.round(clientReqs ?? 0),
        attempts,
        customerRequests: clientReqs,
        failedAttempts: failedAtt,
      },
      windowSeconds: WINDOWS[window].rangeSeconds,
      emitted: classifiedPresent,
    });
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
