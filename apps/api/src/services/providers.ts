/**
 * Providers tab: upstreams grouped by the COMPANY that runs them.
 *
 * Every number is read per node name (`provider_address` / `endpoint_id`) and
 * per chain (`spec`), then rolled up to the company in TypeScript with
 * `providerOf` — company logic never goes into PromQL. Optional families are
 * probed alongside the reads, in one round: a read of a family the router
 * doesn't emit matches nothing, and the probe then turns it into `null` and a
 * false flag in `families`, never into zero.
 *
 * Every read here has to answer. The shared client turns a refused call into
 * an empty result, which on this page would read as "no traffic", "0 hits",
 * "not emitted" or - when only the success counts are missing - a 100% error
 * rate. So a read the store doesn't answer is tried again and then fails the
 * whole response (`StoreReadError`), and the web keeps what it last showed.
 */
import {
  bucketGrid,
  errorBuckets,
  ENDPOINT_METRICS,
  OPTIONAL_METRICS,
  RECORDED,
  RECORDED_INTERVAL_SECONDS,
  ROUTER_METRICS,
  WINDOWS,
  looksLikeNodeName,
  providerOf,
  qPresence,
  recordedReadsFor,
  type ChainOthers,
  type MetricWindow,
  type ProviderChainStats,
  type ProviderDetailReport,
  type ProviderFamilies,
  type ProviderIdentity,
  type ProviderMethodStats,
  type ProviderSeries,
  type ProviderSummary,
  type ProvidersReport,
  type TimePoint,
  type UpstreamMetrics,
} from "@sr/shared";
import { StoreReadError, type PrometheusClient, type PromMatrixSample, type PromVectorSample } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import type { MetricsService } from "./metrics.js";

/** `provider_address` of cache-served relays — not a provider. */
const CACHED = "cached";

const key = (a: string, b: string): string => `${a}\u0000${b}`;
const num = (s: PromVectorSample): number => {
  const v = Number(s.value[1]);
  return Number.isFinite(v) ? v : 0;
};
const ratio = (part: number | null, whole: number): number | null =>
  part === null || whole <= 0 ? null : Math.max(0, Math.min(1, part / whole));

/** Waits before trying a refused read again: a busy store's queue clears in moments. */
const RETRY_WAITS_MS = [300, 900];
/** A read that took this long to fail ran out of time; asking again would only do the same. */
const SLOW_FAILURE_MS = 3000;
/** Reads in flight at once. A shared store queues each tenant's queries and refuses the ones past its limit. */
const MAX_IN_FLIGHT = 4;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The `[range]` of a read over `sec` seconds. A long one samples the series
 * (`[604800s:900s]`, a value every 15 minutes) instead of loading every
 * scrape: a week of raw samples for every series is more than a shared store
 * answers in time. `increase` still sees counter resets between two samples;
 * what a router restart loses is the traffic between the sample before it and
 * the restart, and the two ends of the range can each fall one sample short.
 */
function sampledRange(sec: number, rawMaxSec: number, samples: number): string {
  const whole = Math.max(60, Math.round(sec));
  if (whole <= rawMaxSec) return `${whole}s`;
  return `${whole}s:${Math.max(60, Math.round(whole / samples / 60) * 60)}s`;
}
/** Counters and gauges (hundreds of series): every scrape up to a day, then ~670 samples. */
export const countsRange = (sec: number): string => sampledRange(sec, 86_400, 672);
/** Histogram buckets (thousands of series): every scrape up to three hours, then ~100 samples. */
export const bucketsRange = (sec: number): string => sampledRange(sec, 10_800, 96);

/**
 * The longest window latency is read for. The endpoint histogram is one
 * series per upstream × chain × method × bucket - thousands on a real
 * deployment - and its read over a week, even sampled, ran a shared store out
 * of time and into refusing every tenant's queries. Past this the p95s are
 * null and `latencyRead` is false: a gap that says why, not a read that can
 * take the store down.
 */
export const LATENCY_MAX_SEC = 86_400;
export const latencyReadFor = (window: MetricWindow): boolean => WINDOWS[window].rangeSeconds <= LATENCY_MAX_SEC;

/** The seconds each recorded sample stands for: a recorded count is its samples summed, times this. */
const K = RECORDED_INTERVAL_SECONDS;

/**
 * Provider and chain p95 are read on any window the raw histogram can be read
 * on (a day at most) and on any window the store's recorded per-upstream
 * buckets cover (3h and up, while fresh - `recordedReadsFor`): those are one
 * series per upstream × chain × bucket, cheap at a month. Latency per METHOD
 * has no recorded series, so it stays a day at most (`latencyReadFor`).
 */
export const providerLatencyReadFor = (window: MetricWindow): boolean =>
  latencyReadFor(window) || recordedReadsFor(window);

/**
 * Uptime, the PRD's way: a minute is down when half or more of a provider's
 * tries on a chain failed. Read per minute, so only up to a day - a week of
 * minutes for every upstream is the read that is too heavy for a shared store.
 */
export const UPTIME_MAX_SEC = 86_400;
export const uptimeReadFor = (window: MetricWindow): boolean => WINDOWS[window].rangeSeconds <= UPTIME_MAX_SEC;
/**
 * The hold-offs the minute rules read: the ones the scrape target put on a
 * chain. Read whether or not any exist - with none, the rules' "or ... * 0"
 * leaves every minute's rate-limited tries at zero.
 */
const HOLDS_ON_CHAIN = `{event="recorded",chain!=""}`;
/**
 * Calls the router makes for itself, not for a client: gRPC server
 * reflection, which it then refuses to send as a unary call (MAG-4224). They
 * fail at the router before reaching the provider - on one production
 * deployment about 125,000 a day on two Cosmos chains, none answered - so the
 * down rule leaves them out: a down minute is one the provider could be held
 * to.
 */
// `[.]`, not `\.`: a backslash inside a PromQL string is an escape of its own.
export const ROUTER_OWN_METHODS = "grpc[.]reflection[.].*";
/** `sel` (empty, or a `{…}` selector) with the router's own calls left out. */
const withoutRouterOwn = (sel: string): string => {
  const own = `method!~"${ROUTER_OWN_METHODS}"`;
  return sel ? `${sel.slice(0, -1)},${own}}` : `{${own}}`;
};
/** A minute is down (or rate-limited) when at least this share of the tries in it failed (or got "too many requests"). */
const DOWN_SHARE = 0.5;

/**
 * The per-minute rules, as PromQL over one set of nodes (`nodeSel` on the
 * request counters, `holdSel` on the hold-offs; null when the hold-offs can't
 * be put on a chain).
 *
 * A rate-limited try is taken out of the down rule and counted on its own: a
 * "too many requests" is often the plan's limit, not the provider failing. A
 * minute is down when half or more of the tries that weren't rate-limited
 * failed - a minute of nothing but rate limits is 0/0, not down - and
 * rate-limited when half or more of all its tries were.
 *
 * The hold-off counter names the node `provider` and knows the chain only by
 * the scrape target's `chain` label. The request counter carries that label
 * too, so the two meet on (node, chain) and the hold-offs take the request
 * counter's `spec`. A node that never succeeded has no success series: zero
 * successes, not no data. The router's own calls (`ROUTER_OWN_METHODS`) are
 * no try at the provider and are left out of every count here.
 */
export function minuteRules(nodeSel: string, holdSel: string | null): { tries: string; down: string; limited: string | null } {
  const by = "sum by (provider_address, spec)";
  const sel = withoutRouterOwn(nodeSel);
  const tries = `${by} (increase(${ROUTER_METRICS.requestsTotal}${sel}[1m]))`;
  const ok = `${by} (increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[1m]))`;
  const failed = `(${tries} - (${ok} or ${tries} * 0))`;
  if (holdSel === null) return { tries, down: `${failed} / ${tries} >= bool ${DOWN_SHARE}`, limited: null };
  const present = `group by (provider_address, spec, chain) (${ROUTER_METRICS.requestsTotal}${nodeSel})`;
  const holds =
    `sum by (provider_address, chain) (label_replace(increase(${OPTIONAL_METRICS.rateLimitHoldoffsTotal}${holdSel}[1m]), ` +
    `"provider_address", "$1", "provider", "(.+)"))`;
  const limitedTries = `(${by} (${present} * on (provider_address, chain) group_left ${holds}) or ${by} (${present}) * 0)`;
  return {
    tries,
    down: `clamp_min(${failed} - ${limitedTries}, 0) / clamp_min(${tries} - ${limitedTries}, 0) >= bool ${DOWN_SHARE}`,
    limited: `${limitedTries} / ${tries} >= bool ${DOWN_SHARE}`,
  };
}

/** Block lag is a "now" figure whatever the page's window, so the roster behind it is read over a short one. */
const LAG_WINDOW: MetricWindow = "5m";

/** The highest request rate is the highest average over this long: 5 minutes, or the read's step when that is longer. */
export function peakWindowSec(window: MetricWindow): number {
  return Math.max(300, Math.ceil(WINDOWS[window].rangeSeconds / 2000));
}

/** A regex alternation of node names for `=~` matchers (names are validated, but dots still need escaping). */
function nameAlternation(names: string[]): string {
  return names.map((n) => n.replace(/[.\\+*?^$()[\]{}|]/g, "\\\\$&")).join("|");
}

/**
 * Prometheus' `histogram_quantile`, on bucket counts summed in TypeScript.
 * `buckets` maps the upper bound (`le`, Infinity for "+Inf") to the
 * cumulative count. Same linear interpolation as Prometheus; null with no
 * observations.
 */
export function histogramQuantile(q: number, buckets: Map<number, number>): number | null {
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const total = sorted.at(-1)?.[1] ?? 0;
  if (!sorted.length || total <= 0) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const [le, count] of sorted) {
    if (count >= rank) {
      if (le === Infinity) return prevLe;
      if (count === prevCount) return le;
      return prevLe + (le - prevLe) * ((rank - prevCount) / (count - prevCount));
    }
    prevLe = le;
    prevCount = count;
  }
  return prevLe;
}

interface NodeCounts {
  tries: number;
  ok: number;
  nodeErrors: number | null;
  protocolErrors: number | null;
}

interface Minutes {
  down: number;
  traffic: number;
  /** Null when the hold-offs can't be put on a chain. */
  limited: number | null;
}

interface Loaded {
  fam: ProviderFamilies;
  cfg: ReturnType<ProvidersService["configIndex"]>;
  counts: Map<string, NodeCounts & { node: string; spec: string }>;
  unattributed: { requests: number; labels: string[] } | null;
  lat: { groups: Map<string, Map<number, number>>; sawMethod: boolean };
  health: Map<string, number>;
  holdoffs: PromVectorSample[] | null;
  blocked: Map<string, boolean> | null;
  /** Per (node × chain); null past a day. */
  minutes: Map<string, Minutes> | null;
}

export class ProvidersService {
  constructor(
    private readonly prom: PrometheusClient,
    private readonly configSvc: ConfigurationService | null,
    private readonly metrics: MetricsService,
    private readonly retryWaitsMs: number[] = RETRY_WAITS_MS,
  ) {}

  private inFlight = 0;
  private readonly queued: (() => void)[] = [];

  /** Runs `ask` with at most MAX_IN_FLIGHT reads out at once. */
  private async gated<T>(ask: () => Promise<T>): Promise<T> {
    if (this.inFlight >= MAX_IN_FLIGHT) await new Promise<void>((go) => this.queued.push(go));
    else this.inFlight += 1;
    try {
      return await ask();
    } finally {
      const next = this.queued.shift();
      if (next) next();
      else this.inFlight -= 1;
    }
  }

  private async answered<T>(ask: () => Promise<T | null>): Promise<T> {
    for (const wait of [0, ...this.retryWaitsMs]) {
      if (wait) await sleep(wait);
      const started = Date.now();
      const rows = await this.gated(ask);
      if (rows !== null) return rows;
      // A refusal comes back at once; a read that ran out of time is not asked again.
      if (Date.now() - started > SLOW_FAILURE_MS) break;
    }
    throw new StoreReadError();
  }

  /** An instant read that has to answer - see the note at the top of the file. */
  private read(expr: string): Promise<PromVectorSample[]> {
    return this.answered(() => this.prom.queryOrNull(expr));
  }

  private readRange(expr: string, start: number, end: number, step: string): Promise<PromMatrixSample[]> {
    return this.answered(() => this.prom.queryRangeOrNull(expr, start, end, step));
  }

  private async present(metricName: string): Promise<boolean> {
    const v = Number((await this.read(qPresence(metricName)))[0]?.value[1]);
    return Number.isFinite(v) && v > 0;
  }

  private async families(): Promise<ProviderFamilies> {
    const [nodeErrors, protocolErrors, rateLimit, blocked, endpointErrored, holdsWithChain] = await Promise.all([
      this.present(OPTIONAL_METRICS.nodeErrorsTotal),
      this.present(OPTIONAL_METRICS.protocolErrorsTotal),
      this.present(OPTIONAL_METRICS.rateLimitHoldoffsTotal),
      this.present(OPTIONAL_METRICS.csmProviderBlocked),
      this.present(OPTIONAL_METRICS.endpointErroredTotal),
      // A hold-off can be put on its chain only through the scrape target's `chain` label.
      this.read(`count(${OPTIONAL_METRICS.rateLimitHoldoffsTotal}{chain!=""})`),
    ]);
    const rateLimitByChain = rateLimit && Number(holdsWithChain[0]?.value[1]) > 0;
    return { nodeErrors, protocolErrors, rateLimit, rateLimitByChain, blocked, endpointErrored };
  }

  /** The hold-off selector for the minute rules, or null when they can't be put on a chain. */
  private static holdSel(fam: ProviderFamilies, providerMatcher = ""): string | null {
    return fam.rateLimitByChain ? `{${providerMatcher}event="recorded",chain!=""}` : null;
  }

  /** Config identity per node name: URL hosts, group label, role per chain. */
  configIndex(): {
    identity: (name: string) => ProviderIdentity;
    role: (name: string, spec: string) => "primary" | "backup" | null;
  } {
    const hosts = new Map<string, Set<string>>();
    const groups = new Map<string, string>();
    const roles = new Map<string, "primary" | "backup">();
    const routers = this.configSvc?.getRouters() ?? [];
    // Only the helm format marks backups; SR_CONFIG leaves role unknown.
    const isHelm = routers.some((rt) => rt.localPort === null && rt.nodes.length > 0);
    for (const router of routers) {
      for (const node of router.nodes) {
        const set = hosts.get(node.name) ?? new Set<string>();
        for (const ep of node.endpoints) {
          try {
            set.add(new URL(ep.urlHost).host);
          } catch {
            // A masked "—" or a non-URL host: nothing to match on.
          }
        }
        hosts.set(node.name, set);
        if (node.groupLabel && !groups.has(node.name)) groups.set(node.name, node.groupLabel);
        if (isHelm && !roles.has(key(node.name, router.spec))) {
          roles.set(key(node.name, router.spec), node.isBackup ? "backup" : "primary");
        }
      }
    }
    const cache = new Map<string, ProviderIdentity>();
    return {
      identity: (name) => {
        let id = cache.get(name);
        if (!id) {
          id = providerOf({ name, urlHosts: [...(hosts.get(name) ?? [])], groupLabel: groups.get(name) ?? null });
          cache.set(name, id);
        }
        return id;
      },
      role: (name, spec) => roles.get(key(name, spec)) ?? null,
    };
  }

  /** Per (node × chain) counts the list and the detail both read. */
  private async nodeCounts(
    window: MetricWindow,
    famP: Promise<ProviderFamilies>,
  ): Promise<{
    counts: Map<string, NodeCounts & { node: string; spec: string }>;
    unattributed: { requests: number; labels: string[] } | null;
  }> {
    const sec = WINDOWS[window].rangeSeconds;
    const r = countsRange(sec);
    const by = "sum by (provider_address, spec)";
    // Tries and successes from the recorded per-provider rates where the store
    // has them (3h and up), else from the raw counters - 25,000 series on a
    // real deployment. The error families have no recorded series; they are
    // a few hundred.
    const recorded = recordedReadsFor(window);
    const tries = recorded
      ? `${by} (sum_over_time(${RECORDED.requestsByProvider}[${sec}s])) * ${K}`
      : `${by} (increase(${ROUTER_METRICS.requestsTotal}[${r}]))`;
    const successes = recorded
      ? `${by} (sum_over_time(${RECORDED.successByProvider}[${sec}s])) * ${K}`
      : `${by} (increase(${ROUTER_METRICS.requestsSuccessTotal}[${r}]))`;
    const [tot, ok, nodeErrRows, protoErrRows, fam] = await Promise.all([
      this.read(tries),
      this.read(successes),
      this.read(`${by} (increase(${OPTIONAL_METRICS.nodeErrorsTotal}[${r}]))`),
      this.read(`${by} (increase(${OPTIONAL_METRICS.protocolErrorsTotal}[${r}]))`),
      famP,
    ]);
    const nodeErr = fam.nodeErrors ? nodeErrRows : null;
    const protoErr = fam.protocolErrors ? protoErrRows : null;

    const counts = new Map<string, NodeCounts & { node: string; spec: string }>();
    let unattributedRequests = 0;
    const junk = new Set<string>();
    for (const s of tot) {
      const node = s.metric.provider_address ?? "";
      const spec = s.metric.spec ?? "";
      if (node.toLowerCase() === CACHED) continue;
      const tries = Math.round(num(s));
      if (!looksLikeNodeName(node)) {
        unattributedRequests += tries;
        if (node) junk.add(node);
        continue;
      }
      counts.set(key(node, spec), {
        node,
        spec,
        tries,
        ok: 0,
        nodeErrors: nodeErr ? 0 : null,
        protocolErrors: protoErr ? 0 : null,
      });
    }
    const add = (rows: PromVectorSample[] | null, field: "ok" | "nodeErrors" | "protocolErrors"): void => {
      for (const s of rows ?? []) {
        const row = counts.get(key(s.metric.provider_address ?? "", s.metric.spec ?? ""));
        if (row) row[field] = (row[field] ?? 0) + Math.round(num(s));
      }
    };
    add(ok, "ok");
    add(nodeErr, "nodeErrors");
    add(protoErr, "protocolErrors");

    return {
      counts,
      unattributed:
        unattributedRequests > 0 || junk.size > 0
          ? { requests: unattributedRequests, labels: [...junk].sort() }
          : null,
    };
  }

  /** Latency buckets per (node × chain[ × method]) — summed per group in TS. */
  private async buckets(
    window: MetricWindow,
    withMethod: boolean,
    names?: string[],
  ): Promise<{ groups: Map<string, Map<number, number>>; sawMethod: boolean }> {
    // The recorded buckets carry no method: per method stays on the raw histogram.
    const recorded = !withMethod && recordedReadsFor(window);
    if (!recorded && !latencyReadFor(window)) return { groups: new Map(), sawMethod: false };
    const sel = names?.length ? `{endpoint_id=~"${nameAlternation(names)}"}` : "";
    const by = withMethod ? "endpoint_id, spec, function, le" : "endpoint_id, spec, le";
    const sec = WINDOWS[window].rangeSeconds;
    const rows = await this.read(
      recorded
        ? `sum by (${by}) (sum_over_time(${RECORDED.endpointLatencyBucket}${sel}[${sec}s])) * ${K}`
        : `sum by (${by}) (increase(${ENDPOINT_METRICS.latencyBucket}${sel}[${bucketsRange(sec)}]))`,
    );
    const groups = new Map<string, Map<number, number>>();
    let sawMethod = false;
    for (const s of rows) {
      const le = s.metric.le === "+Inf" ? Infinity : Number(s.metric.le);
      if (!Number.isFinite(le) && le !== Infinity) continue;
      const fn = s.metric.function ?? "";
      if (fn) sawMethod = true;
      const k = withMethod
        ? `${key(s.metric.endpoint_id ?? "", s.metric.spec ?? "")}\u0000${fn}`
        : key(s.metric.endpoint_id ?? "", s.metric.spec ?? "");
      const g = groups.get(k) ?? new Map<number, number>();
      g.set(le, (g.get(le) ?? 0) + num(s));
      groups.set(k, g);
    }
    return { groups, sawMethod };
  }

  private static mergeBuckets(into: Map<number, number>, from: Map<number, number> | undefined): void {
    for (const [le, c] of from ?? []) into.set(le, (into.get(le) ?? 0) + c);
  }

  /** Mean of the health gauge over the window, per (node × chain). */
  private async health(window: MetricWindow): Promise<Map<string, number>> {
    const rows = await this.read(
      `avg by (endpoint_id, spec) (avg_over_time(${ENDPOINT_METRICS.overallHealth}[${countsRange(WINDOWS[window].rangeSeconds)}]))`,
    );
    return new Map(rows.map((s) => [key(s.metric.endpoint_id ?? "", s.metric.spec ?? ""), num(s)]));
  }

  /**
   * Down, rate-limited and traffic minutes per (node × chain), counted by the
   * store at a one-minute step (`minuteRules`).
   */
  private async minutes(window: MetricWindow, famP: Promise<ProviderFamilies>): Promise<Map<string, Minutes> | null> {
    if (!uptimeReadFor(window)) return null;
    const r = `${WINDOWS[window].rangeSeconds}s`;
    const by = "sum by (provider_address, spec)";
    // Hold-offs with no chain label match nothing here, so the down rule is
    // then the plain one - what `holdSel` would pick - and the probe nulls
    // the rate-limited minutes after.
    const rules = minuteRules("", HOLDS_ON_CHAIN);
    const [down, traffic, limitedRows, fam] = await Promise.all([
      this.read(`${by} (sum_over_time((${rules.down})[${r}:1m]))`),
      this.read(`${by} (count_over_time((${rules.tries} > 0)[${r}:1m]))`),
      this.read(`${by} (sum_over_time((${rules.limited})[${r}:1m]))`),
      famP,
    ]);
    const limited = fam.rateLimitByChain ? limitedRows : null;
    const out = new Map<string, Minutes>();
    for (const s of traffic) {
      out.set(key(s.metric.provider_address ?? "", s.metric.spec ?? ""), {
        down: 0,
        traffic: Math.round(num(s)),
        limited: limited ? 0 : null,
      });
    }
    for (const s of down) {
      const row = out.get(key(s.metric.provider_address ?? "", s.metric.spec ?? ""));
      if (row) row.down = Math.min(row.traffic, Math.round(num(s)));
    }
    for (const s of limited ?? []) {
      const k = key(s.metric.provider_address ?? "", s.metric.spec ?? "");
      // A minute can be all hold-offs and no try sent at all.
      const row = out.get(k) ?? { down: 0, traffic: 0, limited: 0 };
      row.limited = Math.round(num(s));
      out.set(k, row);
    }
    return out;
  }

  /** Rate-limit hold-offs. The family has no spec label; a `chain` target label maps by upper-case. */
  private async holdoffs(window: MetricWindow, famP: Promise<ProviderFamilies>): Promise<PromVectorSample[] | null> {
    const [rows, fam] = await Promise.all([
      this.read(
        `sum by (provider, spec, chain) (increase(${OPTIONAL_METRICS.rateLimitHoldoffsTotal}{event="recorded"}[${countsRange(WINDOWS[window].rangeSeconds)}]))`,
      ),
      famP,
    ]);
    return fam.rateLimit ? rows : null;
  }

  private async blocked(famP: Promise<ProviderFamilies>): Promise<Map<string, boolean> | null> {
    const [rows, fam] = await Promise.all([
      this.read(`max by (provider_address, spec) (${OPTIONAL_METRICS.csmProviderBlocked})`),
      famP,
    ]);
    if (!fam.blocked) return null;
    return new Map(rows.map((s) => [key(s.metric.provider_address ?? "", s.metric.spec ?? ""), num(s) > 0]));
  }

  /**
   * The request rate per node over the window, as a time series to sum per
   * company. Each point averages `peakWindowSec`: 5 minutes, or the step when
   * a long window's step is longer - so no stretch of the window goes unread.
   */
  private async rateSeries(window: MetricWindow): Promise<Map<string, Map<number, number>>> {
    const range = WINDOWS[window].rangeSeconds;
    const end = Math.floor(Date.now() / 1000);
    const step = Math.max(60, Math.ceil(range / 2000));
    const peak = peakWindowSec(window);
    const matrix = await this.readRange(
      recordedReadsFor(window)
        ? `sum by (provider_address) (avg_over_time(${RECORDED.requestsByProvider}[${peak}s]))`
        : `sum by (provider_address) (rate(${ROUTER_METRICS.requestsTotal}[${peak}s]))`,
      end - range,
      end,
      `${step}s`,
    );
    const out = new Map<string, Map<number, number>>();
    for (const s of matrix) {
      const name = s.metric.provider_address ?? "";
      const series = new Map<number, number>();
      for (const [t, v] of s.values) {
        const n = Number(v);
        if (Number.isFinite(n)) series.set(t, n);
      }
      out.set(name, series);
    }
    return out;
  }

  /** The node names (label values) a company runs on one chain, from live series. */
  async nodesOn(providerId: string, spec: string): Promise<string[]> {
    const cfg = this.configIndex();
    const rows = await this.read(
      `count by (provider_address) (${ROUTER_METRICS.requestsTotal}{spec="${spec.replace(/[^A-Za-z0-9_-]/g, "")}"})`,
    );
    return rows
      .map((s) => s.metric.provider_address ?? "")
      .filter((n) => looksLikeNodeName(n) && cfg.identity(n).id === providerId)
      .sort();
  }

  /**
   * Counts for the provider report over an exact range: per method, tries,
   * tries that failed and tries the node answered with an error; and
   * rate-limit hold-offs. Evaluated AT the range's end (a one-point range
   * query), so the window is the report's, not "now".
   */
  async rangeCounts(
    names: string[],
    spec: string,
    endSec: number,
    rangeSec: number,
  ): Promise<{
    tries: number;
    failed: number;
    errorReplies: number | null;
    methods: { method: string; tries: number; failed: number; errorReplies: number | null }[];
    rateLimitHits: number | null;
  }> {
    const alt = nameAlternation(names);
    const sel = `{provider_address=~"${alt}",spec="${spec.replace(/[^A-Za-z0-9_-]/g, "")}"}`;
    const r = countsRange(rangeSec);
    const at = async (expr: string): Promise<PromVectorSample[]> => {
      const m = await this.readRange(expr, endSec, endSec, "60s");
      return m.map((x) => ({ metric: x.metric, value: (x.values.at(-1) ?? [endSec, "0"]) as [number, string] }));
    };
    // One round: the optional families are read whether or not they exist.
    const [rateLimit, nodeErrors, tot, ok, replyRows, holdRows] = await Promise.all([
      this.present(OPTIONAL_METRICS.rateLimitHoldoffsTotal),
      this.present(OPTIONAL_METRICS.nodeErrorsTotal),
      at(`sum by (method) (increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]))`),
      at(`sum by (method) (increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]))`),
      at(`sum by (method) (increase(${OPTIONAL_METRICS.nodeErrorsTotal}${sel}[${r}]))`),
      at(`sum by (provider, chain) (increase(${OPTIONAL_METRICS.rateLimitHoldoffsTotal}{provider=~"${alt}",event="recorded"}[${r}]))`),
    ]);
    const replies = nodeErrors ? replyRows : null;
    const hold = rateLimit ? holdRows : null;
    const okBy = new Map(ok.map((s) => [s.metric.method ?? "", Math.round(num(s))]));
    const repliesBy = replies ? new Map(replies.map((s) => [s.metric.method ?? "", Math.round(num(s))])) : null;
    const methods = tot
      .map((s) => {
        const method = s.metric.method ?? "";
        const tries = Math.round(num(s));
        return {
          method,
          tries,
          failed: Math.max(0, tries - (okBy.get(method) ?? 0)),
          errorReplies: repliesBy ? Math.min(tries, repliesBy.get(method) ?? 0) : null,
        };
      })
      .filter((m) => m.method && m.tries > 0)
      .sort((a, b) => b.failed + (b.errorReplies ?? 0) - (a.failed + (a.errorReplies ?? 0)) || b.tries - a.tries);
    // Hold-offs: the chain's own when a chain label exists, else the account's (it is one limit).
    let rateLimitHits: number | null = null;
    if (hold) {
      const withChain = hold.filter((s) => s.metric.chain);
      const rows = withChain.length ? withChain.filter((s) => s.metric.chain!.toUpperCase() === spec.toUpperCase()) : hold;
      rateLimitHits = rows.reduce((a, s) => a + Math.round(num(s)), 0);
    }
    return {
      tries: methods.reduce((a, m) => a + m.tries, 0),
      failed: methods.reduce((a, m) => a + m.failed, 0),
      errorReplies: repliesBy ? methods.reduce((a, m) => a + (m.errorReplies ?? 0), 0) : null,
      methods,
      rateLimitHits,
    };
  }

  /** The reads the list, the detail and the export share - one set per response. */
  private async load(window: MetricWindow): Promise<Loaded> {
    // One round, as the HeroPanel's reads (#249): every read goes out with the
    // family probes, and the probes only decide which answers count.
    const famP = this.families();
    const [fam, { counts, unattributed }, lat, health, holdoffs, blocked, minutes] = await Promise.all([
      famP,
      this.nodeCounts(window, famP),
      this.buckets(window, false),
      this.health(window),
      this.holdoffs(window, famP),
      this.blocked(famP),
      this.minutes(window, famP),
    ]);
    return { fam, cfg: this.configIndex(), counts, unattributed, lat, health, holdoffs, blocked, minutes };
  }

  /** One row per company, blocked first, then by error rate. */
  private summaries(l: Loaded, rates: Map<string, Map<number, number>>): ProviderSummary[] {
    const { fam, cfg, counts, lat, health, holdoffs, blocked, minutes } = l;
    interface Acc {
      summary: ProviderSummary;
      ok: number;
      nodeErrors: number | null;
      protocolErrors: number | null;
      buckets: Map<number, number>;
      health: number[];
      down: number;
      traffic: number;
      limited: number;
      nodes: Set<string>;
      accounts: Set<string>;
    }
    const accs = new Map<string, Acc>();
    const accFor = (node: string): Acc => {
      const id = cfg.identity(node);
      let acc = accs.get(id.id);
      if (!acc) {
        acc = {
          summary: {
            id: id.id,
            name: id.name,
            accounts: [],
            nodes: [],
            chains: [],
            requests: 0,
            peakRps: null,
            errorRate: null,
            protocolErrorRate: null,
            nodeErrorRate: null,
            p95Ms: null,
            rateLimitHits: fam.rateLimit ? 0 : null,
            healthUptime: null,
            uptime: null,
            downMinutes: null,
            rateLimitedMinutes: null,
            blockedNow: fam.blocked ? false : null,
          },
          ok: 0,
          nodeErrors: fam.nodeErrors ? 0 : null,
          protocolErrors: fam.protocolErrors ? 0 : null,
          buckets: new Map(),
          health: [],
          down: 0,
          traffic: 0,
          limited: 0,
          nodes: new Set(),
          accounts: new Set(),
        };
        accs.set(id.id, acc);
      }
      acc.nodes.add(node);
      if (id.account) acc.accounts.add(id.account);
      return acc;
    };

    for (const c of counts.values()) {
      const acc = accFor(c.node);
      acc.summary.requests += c.tries;
      acc.ok += c.ok;
      if (acc.nodeErrors !== null && c.nodeErrors !== null) acc.nodeErrors += c.nodeErrors;
      if (acc.protocolErrors !== null && c.protocolErrors !== null) acc.protocolErrors += c.protocolErrors;
      if (!acc.summary.chains.some((ch) => ch.spec === c.spec)) {
        acc.summary.chains.push({ spec: c.spec, role: cfg.role(c.node, c.spec) });
      }
      ProvidersService.mergeBuckets(acc.buckets, lat.groups.get(key(c.node, c.spec)));
      const h = health.get(key(c.node, c.spec));
      if (h !== undefined) acc.health.push(h);
      const m = minutes?.get(key(c.node, c.spec));
      if (m) {
        acc.down += m.down;
        acc.traffic += m.traffic;
        acc.limited += m.limited ?? 0;
      }
      if (blocked?.get(key(c.node, c.spec))) acc.summary.blockedNow = true;
    }
    // A provider with health or latency but no tries in the window (an idle
    // backup) still belongs in the list — it is configured and polled.
    for (const k of health.keys()) {
      const [node, spec] = k.split("\u0000") as [string, string];
      if (!looksLikeNodeName(node) || counts.has(k)) continue;
      const acc = accFor(node);
      if (!acc.summary.chains.some((ch) => ch.spec === spec)) {
        acc.summary.chains.push({ spec, role: cfg.role(node, spec) });
      }
      acc.health.push(health.get(k)!);
    }

    for (const s of holdoffs ?? []) {
      const node = s.metric.provider ?? "";
      if (!looksLikeNodeName(node)) continue;
      const acc = accs.get(cfg.identity(node).id);
      if (acc && acc.summary.rateLimitHits !== null) acc.summary.rateLimitHits += Math.round(num(s));
    }

    // Peak: sum the companies' node series per timestamp, then take the max.
    const peakSeries = new Map<string, Map<number, number>>();
    for (const [node, series] of rates) {
      if (node.toLowerCase() === CACHED || !looksLikeNodeName(node)) continue;
      const id = cfg.identity(node).id;
      const agg = peakSeries.get(id) ?? new Map<number, number>();
      for (const [t, v] of series) agg.set(t, (agg.get(t) ?? 0) + v);
      peakSeries.set(id, agg);
    }

    const providers = [...accs.values()].map((acc) => {
      const s = acc.summary;
      const failed = Math.max(0, s.requests - acc.ok);
      s.errorRate = ratio(failed, s.requests);
      s.nodeErrorRate = ratio(acc.nodeErrors, s.requests);
      s.protocolErrorRate = ratio(acc.protocolErrors, s.requests);
      s.p95Ms = histogramQuantile(0.95, acc.buckets);
      s.healthUptime = acc.health.length ? acc.health.reduce((a, b) => a + b, 0) / acc.health.length : null;
      // Every chain's minute counts once, so a provider down on one chain of
      // ten is down for a tenth of its chain-minutes, not for none of them.
      s.uptime = minutes && acc.traffic > 0 ? 1 - acc.down / acc.traffic : null;
      s.downMinutes = minutes ? acc.down : null;
      s.rateLimitedMinutes = minutes && fam.rateLimitByChain ? acc.limited : null;
      const peak = peakSeries.get(s.id);
      s.peakRps = peak && peak.size ? Math.max(...peak.values()) : null;
      s.nodes = [...acc.nodes].sort();
      // "blockdaemon" beside "blockdaemon-2" is the first account, not no account.
      const plain = s.nodes.some((n) => cfg.identity(n).account === null);
      s.accounts = acc.accounts.size ? [...(plain ? ["1"] : []), ...acc.accounts].sort() : [];
      s.chains.sort((a, b) => a.spec.localeCompare(b.spec));
      return s;
    });

    return providers.sort(
      (a, b) =>
        Number(b.blockedNow === true) - Number(a.blockedNow === true) ||
        (b.errorRate ?? -1) - (a.errorRate ?? -1) ||
        b.requests - a.requests,
    );
  }

  /** One row per (node × chain), every provider's - the detail keeps one company's, the export all. */
  private chainRows(l: Loaded, upstreams: UpstreamMetrics[]): ProviderChainStats[] {
    const { fam, cfg, counts, lat, health, holdoffs, blocked, minutes } = l;
    const minuteFields = (k: string) => {
      const m = minutes?.get(k);
      return {
        uptime: m && m.traffic > 0 ? 1 - m.down / m.traffic : null,
        downMinutes: minutes ? (m?.down ?? 0) : null,
        rateLimitedMinutes: minutes && fam.rateLimitByChain ? (m?.limited ?? 0) : null,
        trafficMinutes: minutes ? (m?.traffic ?? 0) : null,
      };
    };
    // Chain totals for the share column: every provider's tries on the chain.
    const chainTotals = new Map<string, number>();
    for (const c of counts.values()) chainTotals.set(c.spec, (chainTotals.get(c.spec) ?? 0) + c.tries);

    // Each company's tries on each chain, for the chain's other providers: is it this provider, or the chain?
    const byChain = new Map<string, Map<string, { tries: number; failed: number; nodeErrors: number }>>();
    for (const c of counts.values()) {
      const id = cfg.identity(c.node).id;
      const chain = byChain.get(c.spec) ?? new Map<string, { tries: number; failed: number; nodeErrors: number }>();
      const t = chain.get(id) ?? { tries: 0, failed: 0, nodeErrors: 0 };
      t.tries += c.tries;
      t.failed += Math.max(0, c.tries - c.ok);
      t.nodeErrors += c.nodeErrors ?? 0;
      chain.set(id, t);
      byChain.set(c.spec, chain);
    }
    const othersOn = (spec: string, node: string): ChainOthers => {
      const self = cfg.identity(node).id;
      let providers = 0;
      let tries = 0;
      let failed = 0;
      let nodeErrors = 0;
      for (const [id, t] of byChain.get(spec) ?? []) {
        if (id === self || t.tries === 0) continue;
        providers += 1;
        tries += t.tries;
        failed += t.failed;
        nodeErrors += t.nodeErrors;
      }
      return {
        providers,
        requests: tries,
        errorRate: ratio(failed, tries),
        nodeErrorRate: ratio(fam.nodeErrors ? nodeErrors : null, tries),
      };
    };
    const upstreamByKey = new Map(upstreams.map((u) => [key(u.endpointId, u.spec), u]));

    // Hold-offs per (node × chain) when a chain label exists; otherwise per node only.
    const holdByKey = new Map<string, number>();
    const holdChainKnown = new Set<string>();
    for (const s of holdoffs ?? []) {
      const node = s.metric.provider ?? "";
      const spec = s.metric.spec ?? (s.metric.chain ? s.metric.chain.toUpperCase() : "");
      if (!node || !spec) continue;
      holdChainKnown.add(node);
      holdByKey.set(key(node, spec), (holdByKey.get(key(node, spec)) ?? 0) + Math.round(num(s)));
    }
    const hits = (node: string, spec: string): number | null =>
      fam.rateLimit && holdChainKnown.has(node) ? (holdByKey.get(key(node, spec)) ?? 0) : null;

    const rows: ProviderChainStats[] = [];
    for (const c of counts.values()) {
      const k = key(c.node, c.spec);
      const up = upstreamByKey.get(k);
      const failed = Math.max(0, c.tries - c.ok);
      rows.push({
        spec: c.spec,
        node: c.node,
        account: cfg.identity(c.node).account,
        role: cfg.role(c.node, c.spec) ?? up?.role ?? null,
        requests: c.tries,
        share: ratio(c.tries, chainTotals.get(c.spec) ?? 0),
        errorRate: ratio(failed, c.tries),
        protocolErrorRate: ratio(c.protocolErrors, c.tries),
        nodeErrorRate: ratio(c.nodeErrors, c.tries),
        p95Ms: histogramQuantile(0.95, lat.groups.get(k) ?? new Map()),
        blockLag: up?.blockLag ?? null,
        behindSec: up?.behindSec ?? null,
        rateLimitHits: hits(c.node, c.spec),
        healthUptime: health.get(k) ?? null,
        ...minuteFields(k),
        blockedNow: blocked ? (blocked.get(k) ?? false) : null,
        others: othersOn(c.spec, c.node),
      });
    }
    // Configured but idle on a chain: show it with zero tries, never drop it.
    for (const k of health.keys()) {
      const [node, spec] = k.split("\u0000") as [string, string];
      if (!looksLikeNodeName(node) || counts.has(k)) continue;
      const up = upstreamByKey.get(k);
      rows.push({
        spec,
        node,
        account: cfg.identity(node).account,
        role: cfg.role(node, spec) ?? up?.role ?? null,
        requests: 0,
        share: ratio(0, chainTotals.get(spec) ?? 0),
        errorRate: null,
        protocolErrorRate: null,
        nodeErrorRate: null,
        p95Ms: null,
        blockLag: up?.blockLag ?? null,
        behindSec: up?.behindSec ?? null,
        rateLimitHits: hits(node, spec),
        healthUptime: health.get(k) ?? null,
        ...minuteFields(k),
        blockedNow: blocked ? (blocked.get(k) ?? false) : null,
        others: othersOn(spec, node),
      });
    }
    return rows.sort((a, b) => (b.errorRate ?? -1) - (a.errorRate ?? -1) || b.requests - a.requests);
  }

  /** GET /api/metrics/providers */
  async list(window: MetricWindow): Promise<ProvidersReport> {
    const [l, rates] = await Promise.all([this.load(window), this.rateSeries(window)]);
    return {
      window,
      providers: this.summaries(l, rates),
      unattributed: l.unattributed,
      families: l.fam,
      peakWindowSec: peakWindowSec(window),
      latencyRead: providerLatencyReadFor(window),
      uptimeRead: uptimeReadFor(window),
    };
  }

  /** Every provider with its chain rows, from one set of reads - GET /api/providers/export.csv. */
  async withChains(window: MetricWindow): Promise<{ provider: ProviderSummary; chains: ProviderChainStats[] }[]> {
    const [l, rates, upstreams] = await Promise.all([
      this.load(window),
      this.rateSeries(window),
      this.metrics.upstreams(undefined, LAG_WINDOW),
    ]);
    const rows = this.chainRows(l, upstreams);
    return this.summaries(l, rates).map((provider) => ({
      provider,
      chains: rows.filter((c) => provider.nodes.includes(c.node)),
    }));
  }

  /** The node names a company runs, from the request counter's series - one light read. */
  private async nodesOf(providerId: string): Promise<{ names: string[]; name: string | null }> {
    const cfg = this.configIndex();
    const rows = await this.read(`count by (provider_address) (${ROUTER_METRICS.requestsTotal})`);
    const names = rows
      .map((r) => r.metric.provider_address ?? "")
      .filter((n) => n.toLowerCase() !== CACHED && looksLikeNodeName(n) && cfg.identity(n).id === providerId)
      .sort();
    return { names, name: names.length ? cfg.identity(names[0]!).name : null };
  }

  /**
   * One expression read as bars on the clock: the whole bars in one range
   * read at the bar's step, then the bar still filling as one instant read
   * over the seconds it has run (a range read would end in the future).
   */
  private async barsOf(exprFor: (range: string) => string, bars: ReturnType<typeof bucketGrid>, step: string): Promise<TimePoint[]> {
    const { grid, lastFull, partialSec } = bars;
    const [whole, filling] = await Promise.all([
      lastFull >= grid.start ? this.readRange(exprFor(step), grid.start, lastFull, step) : Promise.resolve([]),
      partialSec > 0 ? this.read(exprFor(`${partialSec}s`)) : Promise.resolve([]),
    ]);
    const points: TimePoint[] = (whole[0]?.values ?? []).map(([t, v]) => {
      const n = Number(v);
      return { t: Number(t), v: Number.isFinite(n) ? n : null };
    });
    const last = filling[0];
    if (partialSec > 0) {
      const n = last ? Number(last.value[1]) : NaN;
      points.push({ t: grid.end, v: Number.isFinite(n) ? n : 0 });
    }
    return points;
  }

  /** `barsOf` with one series per value of `label` - every chain's bars in the same two reads. */
  private async barsByLabel(
    exprFor: (range: string) => string,
    bars: ReturnType<typeof bucketGrid>,
    step: string,
    label: string,
  ): Promise<Map<string, Map<number, number>>> {
    const { grid, lastFull, partialSec } = bars;
    const [whole, filling] = await Promise.all([
      lastFull >= grid.start ? this.readRange(exprFor(step), grid.start, lastFull, step) : Promise.resolve([]),
      partialSec > 0 ? this.read(exprFor(`${partialSec}s`)) : Promise.resolve([]),
    ]);
    const out = new Map<string, Map<number, number>>();
    const put = (k: string, t: number, v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      const series = out.get(k) ?? new Map<number, number>();
      series.set(t, n);
      out.set(k, series);
    };
    for (const s of whole) for (const [t, v] of s.values) put(s.metric[label] ?? "", Number(t), v);
    for (const s of filling) put(s.metric[label] ?? "", grid.end, s.value[1]);
    return out;
  }

  /** GET /api/metrics/provider-series */
  async series(providerId: string, window: MetricWindow): Promise<ProviderSeries> {
    const asOf = Math.floor(Date.now() / 1000);
    const bars = bucketGrid(window, asOf);
    const step = errorBuckets(window).step;
    const [fam, { names, name }] = await Promise.all([this.families(), this.nodesOf(providerId)]);
    const empty: ProviderSeries = {
      window,
      provider: name ? { id: providerId, name } : null,
      grid: bars.grid,
      asOf,
      tries: [],
      failed: [],
      errorReplies: fam.nodeErrors ? [] : null,
      rateLimitHits: fam.rateLimit ? [] : null,
      downMinutes: uptimeReadFor(window) ? [] : null,
      rateLimitedMinutes: uptimeReadFor(window) && fam.rateLimitByChain ? [] : null,
      failuresByChain: [],
      avgLatencyMs: latencyReadFor(window) ? [] : null,
      families: fam,
    };
    if (!names.length) return empty;
    const alt = nameAlternation(names);
    const sel = `{provider_address=~"${alt}"}`;
    const sum = (metric: string, matcher: string) => (range: string) => `sum(increase(${metric}${matcher}[${range}]))`;
    const perChain = (metric: string) => (range: string) => `sum by (spec) (increase(${metric}${sel}[${range}]))`;
    const rules = minuteRules(sel, ProvidersService.holdSel(fam, `provider=~"${alt}",`));
    const minutesOf = (rule: string) => (range: string) => `sum(sum_over_time((${rule})[${range}:1m]))`;
    const [triesBy, okBy, repliesBy, holds, down, limited, latSum, latCount] = await Promise.all([
      this.barsByLabel(perChain(ROUTER_METRICS.requestsTotal), bars, step, "spec"),
      this.barsByLabel(perChain(ROUTER_METRICS.requestsSuccessTotal), bars, step, "spec"),
      fam.nodeErrors ? this.barsByLabel(perChain(OPTIONAL_METRICS.nodeErrorsTotal), bars, step, "spec") : Promise.resolve(null),
      fam.rateLimit
        ? this.barsOf(sum(OPTIONAL_METRICS.rateLimitHoldoffsTotal, `{provider=~"${alt}",event="recorded"}`), bars, step)
        : Promise.resolve(null),
      uptimeReadFor(window) ? this.barsOf(minutesOf(rules.down), bars, step) : Promise.resolve(null),
      uptimeReadFor(window) && rules.limited ? this.barsOf(minutesOf(rules.limited), bars, step) : Promise.resolve(null),
      latencyReadFor(window)
        ? this.barsOf((range) => `sum(increase(${ENDPOINT_METRICS.latencySum}{endpoint_id=~"${alt}"}[${range}]))`, bars, step)
        : Promise.resolve(null),
      latencyReadFor(window)
        ? this.barsOf((range) => `sum(increase(${ENDPOINT_METRICS.latencyCount}{endpoint_id=~"${alt}"}[${range}]))`, bars, step)
        : Promise.resolve(null),
    ]);
    // Every bar any chain has, in order; a chain with no point in a bar had nothing there.
    const times = [...new Set([...triesBy.values()].flatMap((series) => [...series.keys()]))].sort((a, b) => a - b);
    const total = (by: Map<string, Map<number, number>> | null, t: number): number => {
      let n = 0;
      for (const series of by?.values() ?? []) n += series.get(t) ?? 0;
      return n;
    };
    const tries = times.map((t) => ({ t, v: Math.round(total(triesBy, t)) }));
    const failed = times.map((t) => ({ t, v: Math.max(0, Math.round(total(triesBy, t) - total(okBy, t))) }));
    const errorReplies = repliesBy ? times.map((t) => ({ t, v: Math.round(total(repliesBy, t)) })) : null;
    // Failed tries plus error replies on each chain: the chain a clicked bar's report opens on.
    const failuresByChain = [...triesBy.entries()]
      .map(([spec, series]) => ({
        spec,
        points: times.map((t) => {
          const failedHere = Math.max(0, (series.get(t) ?? 0) - (okBy.get(spec)?.get(t) ?? 0));
          return { t, v: Math.round(failedHere + (repliesBy?.get(spec)?.get(t) ?? 0)) };
        }),
      }))
      .filter((c) => c.spec !== "" && c.points.some((p) => p.v > 0));
    const at = (points: TimePoint[]) => new Map(points.map((p) => [p.t, p.v]));
    const round = (points: TimePoint[] | null) => points?.map((p) => ({ t: p.t, v: p.v == null ? null : Math.round(p.v) })) ?? null;
    // Average answer time per bar; no answers in a bar is no latency there, never 0 ms.
    const countAt = latCount ? at(latCount) : null;
    const avgLatencyMs = latSum && countAt
      ? latSum.map((p) => {
          const n = countAt.get(p.t);
          return { t: p.t, v: p.v != null && n != null && n > 0 ? p.v / n : null };
        })
      : null;
    return {
      ...empty,
      tries,
      failed,
      errorReplies,
      rateLimitHits: round(holds),
      downMinutes: round(down),
      rateLimitedMinutes: round(limited),
      failuresByChain,
      avgLatencyMs,
    };
  }

  /** GET /api/metrics/provider-detail */
  async detail(providerId: string, window: MetricWindow): Promise<ProviderDetailReport> {
    const r = countsRange(WINDOWS[window].rangeSeconds);
    const byM = "sum by (provider_address, spec, method)";
    const methodReads = (names: string[]) => {
      const alt = nameAlternation(names);
      return Promise.all([
        this.read(`${byM} (increase(${ROUTER_METRICS.requestsTotal}{provider_address=~"${alt}"}[${r}]))`),
        this.read(`${byM} (increase(${ROUTER_METRICS.requestsSuccessTotal}{provider_address=~"${alt}"}[${r}]))`),
        this.read(`${byM} (increase(${OPTIONAL_METRICS.nodeErrorsTotal}{provider_address=~"${alt}"}[${r}]))`),
        this.buckets(window, true, names),
      ]);
    };
    // The per-method reads start with the rest, on the node names the counter
    // has now (one light read), instead of waiting for the list to name them.
    const early = this.nodesOf(providerId).then(async ({ names }) => (names.length ? { names, reads: await methodReads(names) } : null));
    const [l, rates, upstreams, pre] = await Promise.all([
      this.load(window),
      this.rateSeries(window),
      this.metrics.upstreams(undefined, LAG_WINDOW),
      early,
    ]);
    const fam = l.fam;
    const flags = { latencyRead: providerLatencyReadFor(window), methodLatencyRead: latencyReadFor(window), uptimeRead: uptimeReadFor(window) };
    const provider = this.summaries(l, rates).find((p) => p.id === providerId) ?? null;
    if (!provider || provider.nodes.length === 0) {
      return { window, provider, chains: [], methods: [], methodLatency: false, ...flags, families: fam };
    }
    const names = provider.nodes;
    // A node with traffic in the window but no live series now: read again with every name.
    const covered = pre && names.every((n) => pre.names.includes(n));
    const [mTot, mOk, mNodeErrRows, mLat] = covered ? pre.reads : await methodReads(names);
    const mNodeErr = fam.nodeErrors ? mNodeErrRows : null;
    const chains = this.chainRows(l, upstreams).filter((c) => names.includes(c.node));

    const mKey = (s: PromVectorSample): string =>
      `${key(s.metric.provider_address ?? "", s.metric.spec ?? "")}\u0000${s.metric.method ?? ""}`;
    const okByM = new Map(mOk.map((s) => [mKey(s), Math.round(num(s))]));
    const nodeErrByM = mNodeErr ? new Map(mNodeErr.map((s) => [mKey(s), Math.round(num(s))])) : null;
    const methods: ProviderMethodStats[] = [];
    for (const s of mTot) {
      const node = s.metric.provider_address ?? "";
      const method = s.metric.method ?? "";
      if (!names.includes(node) || !method) continue;
      const tries = Math.round(num(s));
      if (tries <= 0) continue;
      const k = mKey(s);
      const failed = Math.max(0, tries - (okByM.get(k) ?? 0));
      const b = mLat.groups.get(k) ?? new Map<number, number>();
      methods.push({
        spec: s.metric.spec ?? "",
        node,
        method,
        requests: tries,
        failed,
        errorRate: ratio(failed, tries),
        nodeErrors: nodeErrByM ? (nodeErrByM.get(k) ?? 0) : null,
        p50Ms: mLat.sawMethod ? histogramQuantile(0.5, b) : null,
        p95Ms: mLat.sawMethod ? histogramQuantile(0.95, b) : null,
        p99Ms: mLat.sawMethod ? histogramQuantile(0.99, b) : null,
      });
    }
    methods.sort((a, b) => b.failed - a.failed || b.requests - a.requests);

    return { window, provider, chains, methods, methodLatency: mLat.sawMethod, ...flags, families: fam };
  }
}
