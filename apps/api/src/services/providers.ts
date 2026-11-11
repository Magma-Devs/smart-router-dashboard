/**
 * Providers tab: upstreams grouped by the COMPANY that runs them.
 *
 * Every number is read per node name (`provider_address` / `endpoint_id`) and
 * per chain (`spec`), then rolled up to the company in TypeScript with
 * `providerOf` — company logic never goes into PromQL. Optional families are
 * probed first; a family the router doesn't emit comes back as `null` and a
 * false flag in `families`, never as zero.
 */
import {
  ENDPOINT_METRICS,
  OPTIONAL_METRICS,
  ROUTER_METRICS,
  WINDOWS,
  looksLikeNodeName,
  providerOf,
  qPresence,
  rangeFor,
  type MetricWindow,
  type ProviderChainStats,
  type ProviderDetailReport,
  type ProviderFamilies,
  type ProviderIdentity,
  type ProviderMethodStats,
  type ProviderSummary,
  type ProvidersReport,
} from "@sr/shared";
import type { PrometheusClient, PromVectorSample } from "./prometheus-client.js";
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

export class ProvidersService {
  constructor(
    private readonly prom: PrometheusClient,
    private readonly configSvc: ConfigurationService | null,
    private readonly metrics: MetricsService,
  ) {}

  private async present(metricName: string): Promise<boolean> {
    const v = await this.prom.scalar(qPresence(metricName));
    return v !== null && v > 0;
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
    const r = rangeFor(window);
    const by = "sum by (provider_address, spec)";
    const [tot, ok, nodeErr, protoErr] = await Promise.all([
      this.prom.query(`${by} (increase(${ROUTER_METRICS.requestsTotal}[${r}]))`),
      this.prom.query(`${by} (increase(${ROUTER_METRICS.requestsSuccessTotal}[${r}]))`),
      fam.nodeErrors
        ? this.prom.query(`${by} (increase(${OPTIONAL_METRICS.nodeErrorsTotal}[${r}]))`)
        : Promise.resolve(null),
      fam.protocolErrors
        ? this.prom.query(`${by} (increase(${OPTIONAL_METRICS.protocolErrorsTotal}[${r}]))`)
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
    const sel = names?.length ? `{endpoint_id=~"${nameAlternation(names)}"}` : "";
    const by = withMethod ? "endpoint_id, spec, function, le" : "endpoint_id, spec, le";
    const rows = await this.prom.query(
      `sum by (${by}) (increase(${ENDPOINT_METRICS.latencyBucket}${sel}[${rangeFor(window)}]))`,
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
    const rows = await this.prom.query(
      `avg by (endpoint_id, spec) (avg_over_time(${ENDPOINT_METRICS.overallHealth}[${rangeFor(window)}]))`,
    );
    return new Map(rows.map((s) => [key(s.metric.endpoint_id ?? "", s.metric.spec ?? ""), num(s)]));
  }

  /** Rate-limit hold-offs. The family has no spec label; a `chain` target label maps by upper-case. */
  private async holdoffs(window: MetricWindow, fam: ProviderFamilies): Promise<PromVectorSample[] | null> {
    if (!fam.rateLimit) return null;
    return this.prom.query(
      `sum by (provider, spec, chain) (increase(${OPTIONAL_METRICS.rateLimitHoldoffsTotal}{event="recorded"}[${rangeFor(window)}]))`,
    );
  }

  private async blocked(fam: ProviderFamilies): Promise<Map<string, boolean> | null> {
    if (!fam.blocked) return null;
    const rows = await this.prom.query(
      `max by (provider_address, spec) (${OPTIONAL_METRICS.csmProviderBlocked})`,
    );
    return new Map(rows.map((s) => [key(s.metric.provider_address ?? "", s.metric.spec ?? ""), num(s) > 0]));
  }

  /** Highest 5-minute request rate per node over the window, as a time series to sum per company. */
  private async rateSeries(window: MetricWindow): Promise<Map<string, Map<number, number>>> {
    const range = WINDOWS[window].rangeSeconds;
    const end = Math.floor(Date.now() / 1000);
    const step = Math.max(60, Math.ceil(range / 2000));
    const matrix = await this.prom.queryRange(
      `sum by (provider_address) (rate(${ROUTER_METRICS.requestsTotal}[5m]))`,
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
    const rows = await this.prom.query(
      `count by (provider_address) (${ROUTER_METRICS.requestsTotal}{spec="${spec.replace(/[^A-Za-z0-9_-]/g, "")}"})`,
    );
    return rows
      .map((s) => s.metric.provider_address ?? "")
      .filter((n) => looksLikeNodeName(n) && cfg.identity(n).id === providerId)
      .sort();
  }

  /**
   * Counts for the provider report over an exact range: tries and failed tries
   * per method, and rate-limit hold-offs. Evaluated AT the range's end (a
   * one-point range query), so the window is the report's, not "now".
   */
  async rangeCounts(
    names: string[],
    spec: string,
    endSec: number,
    rangeSec: number,
  ): Promise<{ tries: number; failed: number; methods: { method: string; tries: number; failed: number }[]; rateLimitHits: number | null }> {
    const alt = nameAlternation(names);
    const sel = `{provider_address=~"${alt}",spec="${spec.replace(/[^A-Za-z0-9_-]/g, "")}"}`;
    const r = `${Math.max(60, Math.round(rangeSec))}s`;
    const at = async (expr: string): Promise<PromVectorSample[]> => {
      const m = await this.prom.queryRange(expr, endSec, endSec, "60s");
      return m.map((x) => ({ metric: x.metric, value: (x.values.at(-1) ?? [endSec, "0"]) as [number, string] }));
    };
    const rateLimit = await this.present(OPTIONAL_METRICS.rateLimitHoldoffsTotal);
    const [tot, ok, hold] = await Promise.all([
      at(`sum by (method) (increase(${ROUTER_METRICS.requestsTotal}${sel}[${r}]))`),
      at(`sum by (method) (increase(${ROUTER_METRICS.requestsSuccessTotal}${sel}[${r}]))`),
      rateLimit
        ? at(`sum by (provider, chain) (increase(${OPTIONAL_METRICS.rateLimitHoldoffsTotal}{provider=~"${alt}",event="recorded"}[${r}]))`)
        : Promise.resolve(null),
    ]);
    const okBy = new Map(ok.map((s) => [s.metric.method ?? "", Math.round(num(s))]));
    const methods = tot
      .map((s) => {
        const method = s.metric.method ?? "";
        const tries = Math.round(num(s));
        return { method, tries, failed: Math.max(0, tries - (okBy.get(method) ?? 0)) };
      })
      .filter((m) => m.method && m.tries > 0)
      .sort((a, b) => b.failed - a.failed || b.tries - a.tries);
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
      methods,
      rateLimitHits,
    };
  }

  /** GET /api/metrics/providers */
  async list(window: MetricWindow): Promise<ProvidersReport> {
    const fam = await this.families();
    const cfg = this.configIndex();
    const [{ counts, unattributed }, lat, health, holdoffs, blocked, rates] = await Promise.all([
      this.nodeCounts(window, fam),
      this.buckets(window, false),
      this.health(window),
      this.holdoffs(window, fam),
      this.blocked(fam),
      this.rateSeries(window),
    ]);

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
      s.accounts = [...acc.accounts].sort();
      s.chains.sort((a, b) => a.spec.localeCompare(b.spec));
      return s;
    });

    providers.sort(
      (a, b) =>
        Number(b.blockedNow === true) - Number(a.blockedNow === true) ||
        (b.errorRate ?? -1) - (a.errorRate ?? -1) ||
        b.requests - a.requests,
    );

    return { window, providers, unattributed, families: fam };
  }

  /** GET /api/metrics/provider-detail */
  async detail(
    providerId: string,
    window: MetricWindow,
    opts: { list?: ProvidersReport; methods?: boolean } = {},
  ): Promise<ProviderDetailReport> {
    const fam = await this.families();
    const cfg = this.configIndex();
    const list = opts.list ?? (await this.list(window));
    const withMethods = opts.methods ?? true;
    const provider = list.providers.find((p) => p.id === providerId) ?? null;
    if (!provider || provider.nodes.length === 0) {
      return { window, provider, chains: [], methods: [], methodLatency: false, families: fam };
    }
    const names = provider.nodes;
    const alt = nameAlternation(names);
    const r = rangeFor(window);
    const byM = "sum by (provider_address, spec, method)";
    const [{ counts }, lat, health, holdoffs, blocked, upstreams, mTot, mOk, mNodeErr, mLat] = await Promise.all([
      this.nodeCounts(window, fam),
      this.buckets(window, false, names),
      this.health(window),
      this.holdoffs(window, fam),
      this.blocked(fam),
      this.metrics.upstreams(undefined, window),
      withMethods
        ? this.prom.query(`${byM} (increase(${ROUTER_METRICS.requestsTotal}{provider_address=~"${alt}"}[${r}]))`)
        : Promise.resolve([] as PromVectorSample[]),
      withMethods
        ? this.prom.query(`${byM} (increase(${ROUTER_METRICS.requestsSuccessTotal}{provider_address=~"${alt}"}[${r}]))`)
        : Promise.resolve([] as PromVectorSample[]),
      fam.nodeErrors && withMethods
        ? this.prom.query(`${byM} (increase(${OPTIONAL_METRICS.nodeErrorsTotal}{provider_address=~"${alt}"}[${r}]))`)
        : Promise.resolve(null),
      withMethods
        ? this.buckets(window, true, names)
        : Promise.resolve({ groups: new Map<string, Map<number, number>>(), sawMethod: false }),
    ]);

    // Chain totals for the share column: every provider's tries on the chain.
    const chainTotals = new Map<string, number>();
    for (const c of counts.values()) chainTotals.set(c.spec, (chainTotals.get(c.spec) ?? 0) + c.tries);
    const upstreamByKey = new Map(upstreams.map((u) => [key(u.endpointId, u.spec), u]));

    // Hold-offs per (node × chain) when a chain label exists; otherwise per node only.
    const holdByKey = new Map<string, number>();
    const holdChainKnown = new Set<string>();
    for (const s of holdoffs ?? []) {
      const node = s.metric.provider ?? "";
      if (!names.includes(node)) continue;
      const spec = s.metric.spec ?? (s.metric.chain ? s.metric.chain.toUpperCase() : "");
      if (!spec) continue;
      holdChainKnown.add(node);
      holdByKey.set(key(node, spec), (holdByKey.get(key(node, spec)) ?? 0) + Math.round(num(s)));
    }

    const chains: ProviderChainStats[] = [];
    const seen = new Set<string>();
    for (const c of counts.values()) {
      if (!names.includes(c.node)) continue;
      seen.add(key(c.node, c.spec));
      const up = upstreamByKey.get(key(c.node, c.spec));
      const failed = Math.max(0, c.tries - c.ok);
      chains.push({
        spec: c.spec,
        node: c.node,
        account: cfg.identity(c.node).account,
        role: cfg.role(c.node, c.spec) ?? up?.role ?? null,
        requests: c.tries,
        share: ratio(c.tries, chainTotals.get(c.spec) ?? 0),
        errorRate: ratio(failed, c.tries),
        protocolErrorRate: ratio(c.protocolErrors, c.tries),
        nodeErrorRate: ratio(c.nodeErrors, c.tries),
        p95Ms: histogramQuantile(0.95, lat.groups.get(key(c.node, c.spec)) ?? new Map()),
        blockLag: up?.blockLag ?? null,
        behindSec: up?.behindSec ?? null,
        rateLimitHits: !fam.rateLimit
          ? null
          : holdChainKnown.has(c.node)
            ? (holdByKey.get(key(c.node, c.spec)) ?? 0)
            : null,
        healthUptime: health.get(key(c.node, c.spec)) ?? null,
        blockedNow: blocked ? (blocked.get(key(c.node, c.spec)) ?? false) : null,
      });
    }
    // Configured but idle on a chain: show it with zero tries, never drop it.
    for (const k of health.keys()) {
      const [node, spec] = k.split("\u0000") as [string, string];
      if (!names.includes(node) || seen.has(k)) continue;
      const up = upstreamByKey.get(k);
      chains.push({
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
        rateLimitHits: fam.rateLimit && holdChainKnown.has(node) ? (holdByKey.get(k) ?? 0) : null,
        healthUptime: health.get(k) ?? null,
        blockedNow: blocked ? (blocked.get(k) ?? false) : null,
      });
    }
    chains.sort((a, b) => (b.errorRate ?? -1) - (a.errorRate ?? -1) || b.requests - a.requests);

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

    return { window, provider, chains, methods, methodLatency: mLat.sawMethod, families: fam };
  }
}
