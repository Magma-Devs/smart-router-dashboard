/**
 * The Transactions tab's chart - transactions over the page window, a bar per
 * stretch of the clock (`bucketGrid`, as the errors-over-time bars), each bar
 * split by result.
 *
 * Read from the store first: the fleet's Loki ruler records
 * `smartrouter_transactions:count1m` in each tenant's org, a per-minute count
 * of the `relay_end` lines `TX_EVENT_FILTER` finds, labelled `cluster`,
 * `chain` (the spec, lowercased), `service_name` (`<tenant>-<router id>`),
 * `api_interface`, `outcome`, `tx_status` and `tx_refused` - each absent when
 * empty. Its rule:
 *
 *   count_over_time({component="router"} <TX_EVENT_FILTER> | json … [1m] offset 30s)
 *
 * so the sample at E counts the lines of (E-90 s, E-30 s], and the newest
 * minutes are not in it yet: the 30 s offset and the ruler's own delay. The
 * bars read it up to RECORDED_LAG_SEC ago and count the rest from the logs,
 * from where the ruler's newest count read ends: it evaluates once a minute at
 * a second of its own, read off a sample's timestamp.
 *
 * No series for the scope is zero transactions on a store with the fleet's
 * ruler: it records RULER_FAMILY, from the same rules file, for every tenant
 * whose routers log at all. Only a store without it - a standalone install -
 * has the whole window counted from the logs, with the same filter. Counting
 * a tenant's whole window from Loki on every read is what the rules exist to
 * avoid, so a store that doesn't answer the check gets no such read either.
 *
 * A result is `txResultOf` (transactions.ts), the list's own mapping. What the
 * counts can't see: a subscription request the router failed after a node
 * refused it on a try is `rejected` in the list but stays under its failed
 * outcome here. A router before smart-router v1.6.1 writes no `relay_end`,
 * so its transactions are in the list and not in these bars.
 */
import type { MetricWindow, RouterTopology, TransactionsOverTime, TxResult } from "@sr/shared";
import { bucketGrid, WINDOWS } from "@sr/shared";
import type { PrometheusClient } from "./prometheus-client.js";
import type { LokiClient, LokiSeries } from "./loki-client.js";
import type { ConfigurationService } from "./configuration.js";
import { LABEL_TOKEN } from "./router-log.js";
import { TX_EVENT_FILTER, txResultOf } from "./transactions.js";

/** The store's per-minute transaction counts. */
export const RECORDED_TX = "smartrouter_transactions:count1m";

/**
 * The family the fleet's Loki ruler records beside RECORDED_TX, from the same
 * rules file, for every tenant whose routers log: a sample of it says the
 * store has the ruler, so a scope with no transactions recorded had none.
 */
export const RULER_FAMILY = "smartrouter_final_requests:count1m";

/** How long the ruler check is kept: whether a store has the ruler changes with a deploy, not a poll. */
export const RULER_TTL_MS = 300_000;

/** How far back the ruler check looks: the window, at least 15 minutes, at most its last day. */
const rulerLookbackSec = (window: MetricWindow) => Math.max(900, Math.min(WINDOWS[window].rangeSeconds, 86_400));

/** How far behind now the recorded counts are whole: the rule's 30 s offset, its minute, the ruler's delay. */
export const RECORDED_LAG_SEC = 120;

/** A recorded sample at E counts the lines up to E - 30 s: read each bar's samples 30 s after its end. */
const SAMPLE_SHIFT_SEC = 30;

/** How often the ruler evaluates the rule. */
const RULE_INTERVAL_SEC = 60;

/** The labels a count is split by. */
const BY = ["cluster", "service_name", "api_interface", "outcome", "tx_status", "tx_refused"] as const;

/** The same labels from the logs: `tx_refused` when the reply named a `tx_code` other than 0. */
const LOG_PIPELINE =
  `| json outcome="outcome", tx_status="tx_status", tx_code="tx_code", api_interface="api_interface" | __error__=""` +
  ' | label_format tx_refused=`{{ if and .tx_code (ne .tx_code "0") }}true{{ end }}`';

/** How long a chart is kept before it is read again - a failed read too. */
export const OVER_TIME_TTL_MS = 30_000;

/** Charts kept at most: one per window, chain and router in use. */
const KEEP = 256;

interface Sample {
  metric: Record<string, string>;
  /** [unix s, count] */
  values: [number, number][];
}

/** A series' result, by the list's own mapping. An empty label (Loki's label_format writes one) is an absent one. */
const resultOf = (m: Record<string, string>): TxResult =>
  txResultOf({ outcome: m.outcome ?? "", txRefused: m.tx_refused === "true", apiInterface: m.api_interface ?? "", txStatus: m.tx_status ?? "" });

/** A label value spliced into a selector: a plain token only. */
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The router's selector with one more label matcher; null when it isn't a plain `{…}` selector. */
function withMatcher(selector: string, label: string, value: string): string | null {
  if (!SAFE_VALUE.test(value) || !/\}\s*$/.test(selector)) return null;
  return selector.replace(/\}\s*$/, `, ${label}="${value}"}`);
}

export class TransactionsOverTimeService {
  private readonly kept = new Map<string, { at: number; result: TransactionsOverTime }>();
  private readonly reading = new Map<string, Promise<TransactionsOverTime>>();
  private readonly ruler = new Map<number, { at: number; present: boolean }>();

  constructor(
    private readonly prom: PrometheusClient | null,
    private readonly loki: LokiClient | null,
    private readonly selector: string,
    private readonly configSvc?: ConfigurationService,
  ) {}

  private routers(): RouterTopology[] {
    return this.configSvc?.getRouters() ?? [];
  }

  /**
   * The window's bars for a chain, a config router, or everything. A router
   * is read through its chain: the recorded counts tell its own apart by
   * `service_name` when another router serves that chain too, and the logs,
   * which can't, answer `shared-chain`. Kept OVER_TIME_TTL_MS per window,
   * chain and router, one read in flight per key.
   */
  async overTime(window: MetricWindow, spec?: string, routerId?: string): Promise<TransactionsOverTime> {
    const nowSec = Math.floor(Date.now() / 1000);
    const bars = bucketGrid(window, nowSec);
    const empty = (over: Partial<TransactionsOverTime> = {}): TransactionsOverTime => ({
      available: true, source: null, grid: bars.grid, asOf: nowSec, counts: {}, partialFrom: null, ...over,
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
    if (kept && Date.now() - kept.at < OVER_TIME_TTL_MS) return kept.result;
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
    empty: (over?: Partial<TransactionsOverTime>) => TransactionsOverTime,
    chain: string | undefined,
    router: RouterTopology | undefined,
  ): Promise<TransactionsOverTime> {
    const { grid } = bars;
    const step = grid.stepSec;
    const ends: number[] = [];
    for (let t = grid.start; t <= grid.end; t += step) ends.push(t);
    const counts: Partial<Record<TxResult, number[]>> = {};
    /** Adds a count to the bar holding the lines up to `t` (unix s): bars end on multiples of the step. */
    const add = (result: TxResult, t: number, n: number) => {
      const i = ends.indexOf(Math.ceil(t / step) * step);
      if (i < 0 || !(n > 0)) return;
      const row = (counts[result] ??= new Array<number>(ends.length).fill(0));
      row[i] = (row[i] ?? 0) + n;
    };
    const shared = router ? this.routers().some((r) => r.id !== router.id && r.spec === router.spec) : false;

    // The store's recorded counts. None for the scope is none sent where the
    // store has the fleet's ruler; only a store without it is read from the logs.
    const read = this.prom ? await this.readRecorded(nowSec, bars, chain) : null;
    const recorded = read?.samples ?? [];
    let fromStore = recorded.length > 0;
    if (this.prom && !fromStore) {
      const ruler = await this.rulerRecords(window, nowSec);
      // Unanswered, it can't say which: a whole-window log read is not a guess to make.
      if (ruler === null || (ruler && !read)) return empty({ available: false, reason: "unreachable" });
      fromStore = ruler;
    }
    if (read && fromStore) {
      // A router sharing its chain is told apart by `service_name`: <tenant>-<router id>.
      let own = recorded;
      let serviceName: string | null = null;
      if (router && shared && recorded.length) {
        const nameOf = (s: Sample, id: string) => `${s.metric.cluster ?? ""}-${id.toLowerCase()}`;
        const onChain = this.routers().filter((r) => r.spec === router.spec);
        if (!recorded.some((s) => onChain.some((r) => s.metric.service_name === nameOf(s, r.id)))) {
          return empty({ available: false, reason: "shared-chain" });
        }
        own = recorded.filter((s) => s.metric.service_name === nameOf(s, router.id));
        serviceName = own[0]?.metric.service_name ?? null;
      }
      for (const s of own) for (const [t, n] of s.values) add(resultOf(s.metric), t, n);

      // The newest minutes, from the logs: from where the recorded counts end to now.
      const selector = router && shared ? (serviceName ? withMatcher(this.selector, "service_name", serviceName) : null) : this.selector;
      const tail = this.loki && selector ? await this.readTail(selector, chain, read.coveredTo, nowSec) : null;
      if (tail) for (const s of tail) for (const [t, n] of s.values) add(resultOf(s.metric), t, n);
      return { available: true, source: "recorded", grid, asOf: nowSec, counts, partialFrom: tail ? null : read.coveredTo };
    }

    // No ruler on the store (a standalone install): count the window from the logs.
    if (!this.loki) return empty({ available: false, reason: "unconfigured" });
    if (router && shared) return empty({ available: false, reason: "shared-chain" });
    const logs = await this.readLogs(bars, chain);
    if (!logs) return empty({ available: false, reason: "unreachable" });
    for (const s of logs) for (const [t, n] of s.values) add(resultOf(s.metric), t, n);
    return { available: true, source: "logs", grid, asOf: nowSec, counts, partialFrom: null };
  }

  /**
   * The recorded counts, each sample at the end of the lines it counts: the
   * bars they cover whole (a range read, each bar's samples read 30 s after
   * it ends), then the part of the bar running at RECORDED_LAG_SEC ago up to
   * there (one instant read). `coveredTo`: where the lines the newest sample
   * read counts end - the ruler's evaluation at or before the read, on the
   * minute grid through a sample it wrote; with no sample in the five minutes
   * before, nothing recorded ends near there, and a minute back is safe. Null
   * when the store didn't answer.
   */
  private async readRecorded(nowSec: number, bars: ReturnType<typeof bucketGrid>, chain: string | undefined): Promise<{ samples: Sample[]; coveredTo: number } | null> {
    const prom = this.prom!;
    const { grid } = bars;
    const step = grid.stepSec;
    const sel = `${RECORDED_TX}${chain ? `{chain="${chain.toLowerCase()}"}` : ""}`;
    const sum = (range: number) => `sum by (${BY.join(", ")}) (sum_over_time(${sel}[${range}s]))`;
    const lagFrom = Math.floor((nowSec - RECORDED_LAG_SEC) / 60) * 60;
    const lastWhole = Math.floor(lagFrom / step) * step;
    // The running part starts where the whole bars end, or where the first bar starts.
    const partFrom = Math.max(lastWhole, grid.start - step);
    const readAt = lagFrom + SAMPLE_SHIFT_SEC;
    const [whole, part, stamp] = await Promise.all([
      lastWhole >= grid.start
        ? prom.queryRangeOrNull(sum(step), grid.start + SAMPLE_SHIFT_SEC, lastWhole + SAMPLE_SHIFT_SEC, `${step}s`)
        : Promise.resolve([]),
      lagFrom > partFrom ? prom.queryAtOrNull(sum(lagFrom - partFrom), readAt) : Promise.resolve([]),
      prom.queryAtOrNull(`max(timestamp(${sel}))`, readAt),
    ]);
    if (whole === null || part === null || stamp === null) return null;
    const written = Number(stamp[0]?.value[1]);
    const evaluated = written > 0 && written <= readAt
      ? written + Math.floor((readAt - written) / RULE_INTERVAL_SEC) * RULE_INTERVAL_SEC
      : lagFrom - RULE_INTERVAL_SEC + SAMPLE_SHIFT_SEC;
    const coveredTo = Math.floor(evaluated - SAMPLE_SHIFT_SEC);
    const out: Sample[] = whole.map((m) => ({
      metric: m.metric,
      values: m.values.map(([t, v]): [number, number] => [Number(t) - SAMPLE_SHIFT_SEC, Number(v)]),
    }));
    // The running part lands in the bar its lines end in.
    for (const v of part) out.push({ metric: v.metric, values: [[Math.max(coveredTo, partFrom + 1), Number(v.value[1])]] });
    return { samples: out.filter((s) => s.values.some(([, n]) => n > 0)), coveredTo };
  }

  /**
   * Whether the store has the fleet's ruler: any sample of RULER_FAMILY in the
   * window, at least its last 15 minutes and at most its last day, whatever
   * the chain. Null when the store didn't answer. Kept RULER_TTL_MS per lookback.
   */
  private async rulerRecords(window: MetricWindow, nowSec: number): Promise<boolean | null> {
    const lookback = rulerLookbackSec(window);
    const kept = this.ruler.get(lookback);
    if (kept && Date.now() - kept.at < RULER_TTL_MS) return kept.present;
    const r = await this.prom!.queryAtOrNull(`count(present_over_time(${RULER_FAMILY}[${lookback}s]))`, nowSec);
    if (r === null) return null;
    const present = Number(r[0]?.value[1]) > 0;
    this.ruler.set(lookback, { at: Date.now(), present });
    return present;
  }

  /** The log count's query over `range` seconds, split by the labels the recorded counts carry. */
  private logCount(selector: string, chain: string | undefined, range: number): string {
    const chainFilter = chain ? ` |= \`"chain":"${chain}"\`` : "";
    return `sum by (api_interface, outcome, tx_status, tx_refused) (count_over_time(${selector} ${TX_EVENT_FILTER}${chainFilter} ${LOG_PIPELINE} [${range}s]))`;
  }

  /** The lines from `fromSec` to now, from the logs: a minute at a time from a range read, the rest from an instant read. Null when Loki didn't answer. */
  private async readTail(selector: string, chain: string | undefined, fromSec: number, nowSec: number): Promise<LokiSeries[] | null> {
    const loki = this.loki!;
    const lastMinute = fromSec + Math.floor((nowSec - fromSec) / 60) * 60;
    const [minutes, running] = await Promise.all([
      lastMinute > fromSec ? loki.metricRange(this.logCount(selector, chain, 60), fromSec + 60, lastMinute, 60) : Promise.resolve([]),
      nowSec > lastMinute ? loki.metricAt(this.logCount(selector, chain, nowSec - lastMinute), nowSec) : Promise.resolve([]),
    ]);
    if (minutes === null || running === null) return null;
    return [...minutes, ...running.map((s) => ({ metric: s.metric, values: s.values.map(([, n]): [number, number] => [nowSec, n]) }))];
  }

  /** The whole window from the logs: the whole bars from a range read, the bar still filling from an instant read. Null when Loki didn't answer. */
  private async readLogs(bars: ReturnType<typeof bucketGrid>, chain: string | undefined): Promise<LokiSeries[] | null> {
    const loki = this.loki!;
    const { grid, lastFull, partialSec } = bars;
    const [whole, filling] = await Promise.all([
      lastFull >= grid.start ? loki.metricRange(this.logCount(this.selector, chain, grid.stepSec), grid.start, lastFull, grid.stepSec) : Promise.resolve([]),
      partialSec > 0 ? loki.metricAt(this.logCount(this.selector, chain, partialSec), lastFull + partialSec) : Promise.resolve([]),
    ]);
    if (whole === null || filling === null) return null;
    return [...whole, ...filling.map((s) => ({ metric: s.metric, values: s.values.map(([, n]): [number, number] => [grid.end, n]) }))];
  }
}
