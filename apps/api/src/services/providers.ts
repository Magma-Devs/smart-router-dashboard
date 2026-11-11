/**
 * Providers tab: upstreams grouped by the COMPANY that runs them.
 *
 * Every number is read per node name (`provider_address` / `endpoint_id`) and
 * per chain (`spec`), then rolled up to the company in TypeScript with
 * `providerOf` — company logic never goes into PromQL. Optional families are
 * probed first; a family the router doesn't emit comes back as `null` and a
 * false flag in `families`, never as zero.
 *
 * Every read here has to answer. The shared client turns a refused call into
 * an empty result, which on this page would read as "no traffic", "0 hits",
 * "not emitted" or - when only the success counts are missing - a 100% error
 * rate. So a read the store doesn't answer is tried again and then fails the
 * whole response (`StoreReadError`), and the web keeps what it last showed.
 */
import {
  ENDPOINT_METRICS,
  OPTIONAL_METRICS,
  ROUTER_METRICS,
  WINDOWS,
  looksLikeNodeName,
  providerOf,
  qPresence,
  type MetricWindow,
  type ProviderChainStats,
  type ProviderDetailReport,
  type ProviderFamilies,
  type ProviderIdentity,
  type ProviderMethodStats,
  type ProviderSummary,
  type ProvidersReport,
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

interface Loaded {
  fam: ProviderFamilies;
  cfg: ReturnType<ProvidersService["configIndex"]>;
  counts: Map<string, NodeCounts & { node: string; spec: string }>;
  unattributed: { requests: number; labels: string[] } | null;
  lat: { groups: Map<string, Map<number, number>>; sawMethod: boolean };
  health: Map<string, number>;
  holdoffs: PromVectorSample[] | null;
  blocked: Map<string, boolean> | null;
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
    const [nodeErrors, protocolErrors, rateLimit, blocked, endpointErrored] = await Promise.all([
      this.present(OPTIONAL_METRICS.nodeErrorsTotal),
      this.present(OPTIONAL_METRICS.protocolErrorsTotal),
      this.present(OPTIONAL_METRICS.rateLimitHoldoffsTotal),
      this.present(OPTIONAL_METRICS.csmProviderBlocked),
      this.present(OPTIONAL_METRICS.endpointErroredTotal),
    ]);
    return { nodeErrors, protocolErrors, rateLimit, blocked, endpointErrored };
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
    fam: ProviderFamilies,
  ): Promise<{
    counts: Map<string, NodeCounts & { node: string; spec: string }>;
    unattributed: { requests: number; labels: string[] } | null;
  }> {
    const r = countsRange(WINDOWS[window].rangeSeconds);
    const by = "sum by (provider_address, spec)";
    const [tot, ok, nodeErr, protoErr] = await Promise.all([
      this.read(`${by} (increase(${ROUTER_METRICS.requestsTotal}[${r}]))`),
      this.read(`${by} (increase(${ROUTER_METRICS.requestsSuccessTotal}[${r}]))`),
      fam.nodeErrors
        ? this.read(`${by} (increase(${OPTIONAL_METRICS.nodeErrorsTotal}[${r}]))`)
        : Promise.resolve(null),
      fam.protocolErrors
        ? this.read(`${by} (increase(${OPTIONAL_METRICS.protocolErrorsTotal}[${r}]))`)
        : Promise.resolve(null),
    ]);

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
    if (!latencyReadFor(window)) return { groups: new Map(), sawMethod: false };
    const sel = names?.length ? `{endpoint_id=~"${nameAlternation(names)}"}` : "";
    const by = withMethod ? "endpoint_id, spec, function, le" : "endpoint_id, spec, le";
    const rows = await this.read(
      `sum by (${by}) (increase(${ENDPOINT_METRICS.latencyBucket}${sel}[${bucketsRange(WINDOWS[window].rangeSeconds)}]))`,
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

  /** Rate-limit hold-offs. The family has no spec label; a `chain` target label maps by upper-case. */
  private async holdoffs(window: MetricWindow, fam: ProviderFamilies): Promise<PromVectorSample[] | null> {
    if (!fam.rateLimit) return null;
    return this.read(
      `sum by (provider, spec, chain) (increase(${OPTIONAL_METRICS.rateLimitHoldoffsTotal}{event="recorded"}[${countsRange(WINDOWS[window].rangeSeconds)}]))`,
    );
  }

  private async blocked(fam: ProviderFamilies): Promise<Map<string, boolean> | null> {
    if (!fam.blocked) return null;
    const rows = await this.read(
      `max by (provider_address, spec) (${OPTIONAL_METRICS.csmProviderBlocked})`,
    );
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
    const matrix = await this.readRange(
      `sum by (provider_address) (rate(${ROUTER_METRICS.requestsTotal}[${peakWindowSec(window)}s]))`,
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
    const [rateLimit, nodeErrors] = await Promise.all([
      this.present(OPTIONAL_METRICS.rateLimitHoldoffsTotal),
      this.present(OPTIONAL_METRICS.nodeErrorsTotal),
    ]);
    const [tot, ok, replies, hold] = await Promise.all([
      at(`sum by (method) (increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]))`),
      at(`sum by (method) (increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]))`),
      nodeErrors
        ? at(`sum by (method) (increase(${OPTIONAL_METRICS.nodeErrorsTotal}${sel}[${r}]))`)
        : Promise.resolve(null),
      rateLimit
        ? at(`sum by (provider, chain) (increase(${OPTIONAL_METRICS.rateLimitHoldoffsTotal}{provider=~"${alt}",event="recorded"}[${r}]))`)
        : Promise.resolve(null),
    ]);
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
    const fam = await this.families();
    const [{ counts, unattributed }, lat, health, holdoffs, blocked] = await Promise.all([
      this.nodeCounts(window, fam),
      this.buckets(window, false),
      this.health(window),
      this.holdoffs(window, fam),
      this.blocked(fam),
    ]);
    return { fam, cfg: this.configIndex(), counts, unattributed, lat, health, holdoffs, blocked };
  }

  /** One row per company, blocked first, then by error rate. */
  private summaries(l: Loaded, rates: Map<string, Map<number, number>>): ProviderSummary[] {
    const { fam, cfg, counts, lat, health, holdoffs, blocked } = l;
    interface Acc {
      summary: ProviderSummary;
      ok: number;
      nodeErrors: number | null;
      protocolErrors: number | null;
      buckets: Map<number, number>;
      health: number[];
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
            blockedNow: fam.blocked ? false : null,
          },
          ok: 0,
          nodeErrors: fam.nodeErrors ? 0 : null,
          protocolErrors: fam.protocolErrors ? 0 : null,
          buckets: new Map(),
          health: [],
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
    const { fam, cfg, counts, lat, health, holdoffs, blocked } = l;
    // Chain totals for the share column: every provider's tries on the chain.
    const chainTotals = new Map<string, number>();
    for (const c of counts.values()) chainTotals.set(c.spec, (chainTotals.get(c.spec) ?? 0) + c.tries);
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
        blockedNow: blocked ? (blocked.get(k) ?? false) : null,
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
        blockedNow: blocked ? (blocked.get(k) ?? false) : null,
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
      latencyRead: latencyReadFor(window),
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

  /** GET /api/metrics/provider-detail */
  async detail(providerId: string, window: MetricWindow): Promise<ProviderDetailReport> {
    const [l, rates, upstreams] = await Promise.all([
      this.load(window),
      this.rateSeries(window),
      this.metrics.upstreams(undefined, LAG_WINDOW),
    ]);
    const fam = l.fam;
    const provider = this.summaries(l, rates).find((p) => p.id === providerId) ?? null;
    if (!provider || provider.nodes.length === 0) {
      return { window, provider, chains: [], methods: [], methodLatency: false, latencyRead: latencyReadFor(window), families: fam };
    }
    const names = provider.nodes;
    const alt = nameAlternation(names);
    const r = countsRange(WINDOWS[window].rangeSeconds);
    const byM = "sum by (provider_address, spec, method)";
    const [mTot, mOk, mNodeErr, mLat] = await Promise.all([
      this.read(`${byM} (increase(${ROUTER_METRICS.requestsTotal}{provider_address=~"${alt}"}[${r}]))`),
      this.read(`${byM} (increase(${ROUTER_METRICS.requestsSuccessTotal}{provider_address=~"${alt}"}[${r}]))`),
      fam.nodeErrors
        ? this.read(`${byM} (increase(${OPTIONAL_METRICS.nodeErrorsTotal}{provider_address=~"${alt}"}[${r}]))`)
        : Promise.resolve(null),
      this.buckets(window, true, names),
    ]);
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

    return { window, provider, chains, methods, methodLatency: mLat.sawMethod, latencyRead: latencyReadFor(window), families: fam };
  }
}
