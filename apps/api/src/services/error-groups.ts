/**
 * The Errors tab's grouped view over the whole page window, from the store's
 * recorded counts rather than the router's lines: at any window it costs one
 * range read with a point per bar (`bucketGrid`: 48 bars at a day, 28 at a
 * week, 30 at a month) and one instant read for the bar still filling, where
 * grouping the lines costs the window.
 *
 * The fleet's Loki ruler records `smartrouter_request_errors:count1m` in each
 * tenant's org, beside `smartrouter_final_{requests,failures}:count1m`: once a
 * minute, the finished requests (`relay_end`) that had a failed try or a
 * failed outcome, labelled `cluster`, `chain` (the spec, lowercased),
 * `service_name` (`<tenant>-<router id>`), `outcome`, `error_class`,
 * `failing_provider` and `reached_client` (`"true"` / `"false"`). Its window
 * is the siblings' `[1m] offset 30s`, so the sample at E counts the lines of
 * (E-90 s, E-30 s]: each bar's samples are read 30 s after it ends, and the
 * newest minutes are not in it yet (RECORDED_LAG_SEC).
 *
 * A group is the requests of one chain whose class, failing provider and
 * client verdict match. `error_class` is empty on every series until the
 * router writes its fixed class: an unclassified group is told apart by its
 * outcome instead, so "no answer at node-a" and "node error at node-a" stay
 * two lines.
 *
 * No series in the window is no failed request where the store has the
 * family; a store without it (the rule not deployed, a standalone install)
 * answers `no-series`, and the web groups the requests its list has loaded.
 * The family is looked for over a day at least: a tenant with no failed
 * request for a whole day reads as `no-series` too, and the list's own
 * grouping then shows the same nothing.
 */
import type { ErrorGroupsReport, MetricWindow, RecordedErrorGroup, RouterTopology } from "@sr/shared";
import { bucketGrid, WINDOWS } from "@sr/shared";
import type { PrometheusClient, PromMatrixSample, PromVectorSample } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import { LABEL_TOKEN } from "./router-log.js";
import { RECORDED_LAG_SEC } from "./transactions-over-time.js";

/** The store's per-minute counts of requests that hit an error. */
export const RECORDED_ERRORS = "smartrouter_request_errors:count1m";

/** Groups listed at most; the rest are counted in `omitted`. */
export const ERROR_GROUPS_LIMIT = 50;

/** How long a report is kept before the store is read again - a failed read too. */
export const ERROR_GROUPS_TTL_MS = 30_000;

/** How long the family check is kept: whether the store records the family changes with a deploy, not a poll. */
export const PRESENCE_TTL_MS = 300_000;

/** The family check looks back over the window, a day at least. */
const PRESENCE_MIN_SEC = 86_400;

/** A recorded sample at E counts the lines up to E - 30 s: read each bar's samples 30 s after its end. */
const SAMPLE_SHIFT_SEC = 30;

/** The lines one sample counts span a minute: a request can sit that long before its bar. */
const RULE_WINDOW_SEC = 60;

/** The labels a count is split by. */
const BY = ["chain", "error_class", "outcome", "failing_provider", "reached_client"] as const;

/** Reports kept at most: one per window, chain and router in use. */
const KEEP = 256;

interface Sample {
  metric: Record<string, string>;
  /** [unix s the lines end, count] */
  values: [number, number][];
}

type Reader = Pick<PrometheusClient, "queryRangeOrNull" | "queryAtOrNull">;

/** A group's identity: the class, or the outcome while the class is empty. */
function keyOf(m: Record<string, string>): string {
  const cls = m.error_class ?? "";
  return [m.chain ?? "", cls ? `class:${cls}` : `outcome:${m.outcome ?? ""}`, m.failing_provider ?? "", m.reached_client === "true" ? "1" : "0"].join("|");
}

export class ErrorGroupsService {
  private readonly kept = new Map<string, { at: number; result: ErrorGroupsReport }>();
  private readonly reading = new Map<string, Promise<ErrorGroupsReport>>();
  private readonly presence = new Map<number, { at: number; present: boolean }>();

  constructor(
    private readonly prom: Reader,
    private readonly configSvc?: ConfigurationService,
    private readonly limit: number = ERROR_GROUPS_LIMIT,
  ) {}

  private routers(): RouterTopology[] {
    return this.configSvc?.getRouters() ?? [];
  }

  /**
   * The window's groups for a chain, a config router, or everything. A router
   * alone on its chain is its chain; one sharing it is told apart by
   * `service_name` (`<tenant>-<router id lower-cased>`), and answers
   * `shared-chain` when no count names a router of the chain. Kept
   * ERROR_GROUPS_TTL_MS per window, chain and router, one read in flight per key.
   */
  async groups(window: MetricWindow, spec?: string, routerId?: string): Promise<ErrorGroupsReport> {
    const nowSec = Math.floor(Date.now() / 1000);
    const bars = bucketGrid(window, nowSec);
    const empty = (over: Partial<ErrorGroupsReport> = {}): ErrorGroupsReport => ({
      available: true, source: null, grid: bars.grid, asOf: nowSec, groups: [], limit: this.limit,
      omitted: { groups: 0, count: 0 }, total: 0, reached: { count: 0, buckets: [] }, partialFrom: null, ...over,
    });
    if (spec != null && !LABEL_TOKEN.test(spec)) return empty();
    let router: RouterTopology | undefined;
    if (routerId) {
      router = this.routers().find((r) => r.id === routerId);
      if (!router || (spec != null && spec !== router.spec)) return empty();
    }
    const chain = router?.spec ?? spec;
    if (chain != null && !LABEL_TOKEN.test(chain)) return empty();

    const key = `${window}|${chain ?? ""}|${router?.id ?? ""}`;
    const kept = this.kept.get(key);
    if (kept && Date.now() - kept.at < ERROR_GROUPS_TTL_MS) return kept.result;
    const pending = this.reading.get(key);
    if (pending) return pending;
    const read = this.read(window, nowSec, bars, empty, chain, router)
      .then((result) => {
        this.kept.delete(key);
        this.kept.set(key, { at: Date.now(), result });
        if (this.kept.size > KEEP) this.kept.delete(this.kept.keys().next().value!);
        return result;
      })
      .finally(() => this.reading.delete(key));
    this.reading.set(key, read);
    return read;
  }

  private async read(
    window: MetricWindow,
    nowSec: number,
    bars: ReturnType<typeof bucketGrid>,
    empty: (over?: Partial<ErrorGroupsReport>) => ErrorGroupsReport,
    chain: string | undefined,
    router: RouterTopology | undefined,
  ): Promise<ErrorGroupsReport> {
    const { grid } = bars;
    const step = grid.stepSec;
    const routers = this.routers();
    const shared = router ? routers.some((r) => r.id !== router.id && r.spec === router.spec) : false;
    const unavailable = (reason: NonNullable<ErrorGroupsReport["reason"]>) => empty({ available: false, reason });

    const got = await this.readRecorded(nowSec, bars, chain, shared);
    if (got === null) return unavailable("unreachable");
    let samples = got.samples;
    if (router && shared && samples.length) {
      // <tenant>-<router id lower-cased>: the tenant is the count's own cluster.
      const nameOf = (s: Sample, id: string) => `${s.metric.cluster ?? ""}-${id.toLowerCase()}`;
      const onChain = routers.filter((r) => r.spec === router.spec);
      if (!samples.some((s) => onChain.some((r) => s.metric.service_name === nameOf(s, r.id)))) return unavailable("shared-chain");
      samples = samples.filter((s) => s.metric.service_name === nameOf(s, router.id));
    }
    if (!got.samples.length) {
      // Nothing recorded for the scope: no failed request, where the store has the family at all.
      const present = await this.familyRecorded(window, nowSec);
      if (present === null) return unavailable("unreachable");
      if (!present) return unavailable("no-series");
    }

    const ends: number[] = [];
    for (let t = grid.start; t <= grid.end; t += step) ends.push(t);
    /** The bar holding the lines up to `t` (unix s): bars end on multiples of the step. */
    const barOf = (t: number) => ends.indexOf(Math.ceil(t / step) * step);
    const specOf = this.specLookup(chain, routers);

    const by = new Map<string, RecordedErrorGroup & { outcomes: Set<string> }>();
    for (const s of samples) {
      const m = s.metric;
      const k = keyOf(m);
      let g = by.get(k);
      if (!g) {
        g = {
          key: k, spec: specOf(m.chain ?? ""), errorClass: m.error_class || null, outcome: m.outcome || null,
          failingProvider: m.failing_provider || null, reachedClient: m.reached_client === "true",
          count: 0, from: 0, to: 0, buckets: new Array<number>(ends.length).fill(0), outcomes: new Set(),
        };
        by.set(k, g);
      }
      g.outcomes.add(m.outcome ?? "");
      for (const [t, n] of s.values) {
        const i = barOf(t);
        if (i >= 0 && n > 0) g.buckets[i]! += n;
      }
    }

    const windowStart = nowSec - WINDOWS[window].rangeSeconds;
    const reached = new Array<number>(ends.length).fill(0);
    const all: RecordedErrorGroup[] = [];
    for (const { outcomes, ...g } of by.values()) {
      g.buckets = g.buckets.map((n) => Math.round(n));
      g.count = g.buckets.reduce((a, b) => a + b, 0);
      if (!g.count) continue;
      const first = g.buckets.findIndex((n) => n > 0);
      const last = g.buckets.length - 1 - [...g.buckets].reverse().findIndex((n) => n > 0);
      g.from = Math.max(windowStart, ends[first]! - step - RULE_WINDOW_SEC);
      g.to = Math.min(ends[last]!, nowSec);
      // With a class, an outcome only when every request of the group ended the same way.
      if (g.errorClass) g.outcome = outcomes.size === 1 ? g.outcome : null;
      if (g.reachedClient) g.buckets.forEach((n, i) => (reached[i]! += n));
      all.push(g);
    }
    all.sort((a, b) => b.count - a.count || b.to - a.to || (a.key < b.key ? -1 : 1));
    const listed = all.slice(0, this.limit);
    const rest = all.slice(this.limit);
    return {
      available: true,
      source: "recorded",
      grid,
      asOf: nowSec,
      groups: listed,
      limit: this.limit,
      omitted: { groups: rest.length, count: rest.reduce((n, g) => n + g.count, 0) },
      total: all.reduce((n, g) => n + g.count, 0),
      reached: { count: reached.reduce((a, b) => a + b, 0), buckets: reached },
      partialFrom: got.coveredFrom,
    };
  }

  /** The spec a `chain` label (the spec lowercased) stands for: the one asked for, or the values file's, else upper-cased. */
  private specLookup(asked: string | undefined, routers: RouterTopology[]): (chain: string) => string | null {
    const known = new Map<string, string>();
    for (const r of routers) known.set(r.spec.toLowerCase(), r.spec);
    if (asked) known.set(asked.toLowerCase(), asked);
    return (chain) => (chain ? (known.get(chain) ?? chain.toUpperCase()) : null);
  }

  /**
   * The recorded counts, each sample at the end of the lines it counts: the
   * bars they cover whole (one range read, a point per bar, each bar's samples
   * read 30 s after it ends), then the part of the bar running at
   * RECORDED_LAG_SEC ago up to there (one instant read). `coveredFrom`: from
   * where the newest bar may be short - the ruler evaluates once a minute at
   * a second of its own, so its newest count read may end a minute before
   * that. Null when the store didn't answer.
   */
  private async readRecorded(
    nowSec: number,
    bars: ReturnType<typeof bucketGrid>,
    chain: string | undefined,
    shared: boolean,
  ): Promise<{ samples: Sample[]; coveredFrom: number } | null> {
    const { grid } = bars;
    const step = grid.stepSec;
    const sel = `${RECORDED_ERRORS}${chain ? `{chain="${chain.toLowerCase()}"}` : ""}`;
    // A router sharing its chain is told apart by its series' cluster and service_name.
    const by = shared ? [...BY, "cluster", "service_name"] : BY;
    const sum = (range: number) => `sum by (${by.join(", ")}) (sum_over_time(${sel}[${range}s]))`;
    const lagFrom = Math.floor((nowSec - RECORDED_LAG_SEC) / 60) * 60;
    const lastWhole = Math.floor(lagFrom / step) * step;
    // The running part starts where the whole bars end, or where the first bar starts.
    const partFrom = Math.max(lastWhole, grid.start - step);
    const [whole, part] = await Promise.all([
      lastWhole >= grid.start
        ? this.prom.queryRangeOrNull(sum(step), grid.start + SAMPLE_SHIFT_SEC, lastWhole + SAMPLE_SHIFT_SEC, `${step}s`)
        : Promise.resolve([] as PromMatrixSample[]),
      lagFrom > partFrom ? this.prom.queryAtOrNull(sum(lagFrom - partFrom), lagFrom + SAMPLE_SHIFT_SEC) : Promise.resolve([] as PromVectorSample[]),
    ]);
    if (whole === null || part === null) return null;
    const out: Sample[] = whole.map((m) => ({
      metric: m.metric,
      values: m.values.map(([t, v]): [number, number] => [Number(t) - SAMPLE_SHIFT_SEC, Number(v)]),
    }));
    // The running part lands in the bar its lines end in.
    for (const v of part) out.push({ metric: v.metric, values: [[lagFrom, Number(v.value[1])]] });
    return { samples: out.filter((s) => s.values.some(([, n]) => n > 0)), coveredFrom: lagFrom - RULE_WINDOW_SEC };
  }

  /**
   * Whether the store records the family at all: any sample of it in the
   * window, a day at least, whatever the chain. Null when the store didn't
   * answer. Kept PRESENCE_TTL_MS per lookback.
   */
  private async familyRecorded(window: MetricWindow, nowSec: number): Promise<boolean | null> {
    const lookback = Math.max(PRESENCE_MIN_SEC, WINDOWS[window].rangeSeconds);
    const kept = this.presence.get(lookback);
    if (kept && Date.now() - kept.at < PRESENCE_TTL_MS) return kept.present;
    const r = await this.prom.queryAtOrNull(`count(present_over_time(${RECORDED_ERRORS}[${lookback}s]))`, nowSec);
    if (r === null) return null;
    const present = Number(r[0]?.value[1]) > 0;
    this.presence.set(lookback, { at: Date.now(), present });
    return present;
  }
}
