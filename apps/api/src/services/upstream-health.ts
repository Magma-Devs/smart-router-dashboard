import {
  ENDPOINT_METRICS, qBlockChecksPassedOver, qProviderBlockedByEndpoint, qProviderBlockedOver, selector,
  type HealthCause, type HealthState, type ProviderAttention,
} from "@sr/shared";
import type { ConfigurationService } from "./configuration.js";
import type { PrometheusClient, PromVectorSample } from "./prometheus-client.js";

/** Three expected blocks, rounded up to bounded buckets; never the UI history window. */
export const HEALTH_WINDOWS = [300, 900, 1800, 3600] as const;
export const FALLBACK_HEALTH_WINDOW = 1800;
export function healthWindowSeconds(blocksPerSec: number | undefined): number {
  if (blocksPerSec === undefined || !Number.isFinite(blocksPerSec) || blocksPerSec <= 0)
    return FALLBACK_HEALTH_WINDOW;
  const needed = 3 / blocksPerSec;
  return HEALTH_WINDOWS.find((seconds) => seconds >= needed) ?? 3600;
}
export const upstreamKey = (endpointId: string, spec: string) => `${endpointId}\u0000${spec}`;

export interface UpstreamHealth {
  endpointId: string;
  spec: string;
  health: HealthState;
  /** One plain sentence: what the reader is told. */
  healthReason: string;
  healthCause: HealthCause;
  /** Unix seconds an unhealthy provider's trouble began (`readHealthSince`); null when not known. */
  healthSince: number | null;
  healthSinceOrEarlier: boolean;
  /** The interfaces and scrape targets whose every block check fails: the series a checks-failing "since" is read from. */
  failingChecks: { apiInterface: string; instance: string }[];
  routerIds: string[];
}

const rank: Record<HealthState, number> = { operational: 0, unknown: 1, unhealthy: 2 };
/* The reasons, in words a client reads: a "block check" is the router asking
   a provider for its latest block, which it does whether or not it sends the
   provider requests. No store or scrape is named: the reader can check neither. */
export const NO_DATA_REASON = "No data yet: the router reports nothing about it.";
const missing = NO_DATA_REASON;

/** Four reads, independent of fleet size; shared by the roster and the pulse's counts. */
export async function readUpstreamHealth(
  prom: PrometheusClient,
  config?: ConfigurationService,
  spec?: string,
  routerId?: string,
): Promise<Map<string, UpstreamHealth>> {
  const sel = selector({ spec });
  // Preserve interfaces AND scrape targets until after deciding liveness: a
  // working interface/replica must not hide another one's failed polls.
  // One hour smooths sparse block arrivals; zero/missing rates use the
  // conservative fallback, rather than dividing by zero or assuming a fast chain.
  const [gauges, rates] = await Promise.all([
    prom.query(qProviderBlockedByEndpoint(spec)),
    prom.query(`max by (spec) (deriv(${ENDPOINT_METRICS.latestBlock}${sel}[1h]))`),
  ]);
  const windows = new Map<string, number>();
  for (const sample of rates)
    if (sample.metric.spec && (!spec || sample.metric.spec === spec))
      windows.set(sample.metric.spec, healthWindowSeconds(Number(sample.value[1])));
  const windowFor = (chain: string) => windows.get(chain) ?? FALLBACK_HEALTH_WINDOW;
  const polls = (metric: string) => {
    const sum = (labels: string, seconds: number) =>
      `sum by (endpoint_id, spec, apiInterface, instance) (increase(${metric}${labels}[${seconds}s]))`;
    if (spec) return sum(sel, windowFor(spec));
    // Group chains by window, not one request per chain/endpoint. The default
    // branch also includes configured and metric-only chains without a rate.
    const groups = new Map<number, string[]>();
    for (const [chain, seconds] of windows) {
      if (seconds === FALLBACK_HEALTH_WINDOW) continue;
      const chains = groups.get(seconds) ?? [];
      chains.push(chain);
      groups.set(seconds, chains);
    }
    const regex = (chains: string[]) =>
      JSON.stringify(
        chains
          .sort()
          .map((chain) => chain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|"),
      );
    const other = [...groups.values()].flat();
    const branches = [...groups].map(([seconds, chains]) =>
      sum(`{spec=~${regex(chains)}}`, seconds),
    );
    branches.push(sum(other.length ? `{spec!~${regex(other)}}` : "", FALLBACK_HEALTH_WINDOW));
    return branches.join(" or ");
  };
  const [successes, failures] = await Promise.all([
    prom.query(polls(ENDPOINT_METRICS.fetchLatestSuccess)),
    prom.query(polls(ENDPOINT_METRICS.fetchLatestFails)),
  ]);
  const rows = new Map<string, UpstreamHealth>();
  const expected = new Map<string, Set<string>>();
  const ensure = (endpointId: string, chain: string) => {
    const key = upstreamKey(endpointId, chain);
    let row = rows.get(key);
    if (!row) {
      row = { endpointId, spec: chain, health: "unknown", healthReason: missing, healthCause: "no-data", healthSince: null, healthSinceOrEarlier: false, failingChecks: [], routerIds: [] };
      rows.set(key, row);
    }
    return row;
  };
  for (const router of config?.getRouters() ?? []) {
    if (spec && router.spec !== spec) continue;
    for (const node of router.nodes) {
      const row = ensure(node.name, router.spec);
      if (!row.routerIds.includes(router.id)) row.routerIds.push(router.id);
      const key = upstreamKey(node.name, router.spec);
      const interfaces = expected.get(key) ?? new Set<string>();
      for (const endpoint of node.endpoints)
        if (endpoint.interface) interfaces.add(endpoint.interface);
      expected.set(key, interfaces);
    }
  }
  type Signal = { rowKey: string; iface: string; instance: string; gauge?: HealthState; ok: number; failed: number };
  const signals = new Map<string, Signal>();
  const add = (sample: PromVectorSample, kind: "gauge" | "ok" | "failed") => {
    const id = sample.metric.endpoint_id;
    const chain = sample.metric.spec ?? "";
    if (!id || (spec && chain !== spec)) return;
    ensure(id, chain);
    const rowKey = upstreamKey(id, chain);
    const iface = sample.metric.apiInterface ?? "";
    const instance = sample.metric.instance ?? "";
    const key = `${rowKey}\u0000${iface}\u0000${instance}`;
    const signal = signals.get(key) ?? { rowKey, iface, instance, ok: 0, failed: 0 };
    const value = Number(sample.value[1]);
    if (kind === "gauge") {
      // The blocked gauge is 1 while the router sends the provider no traffic.
      const measured = !Number.isFinite(value)
        ? "unknown"
        : value >= 1
          ? "unhealthy"
          : "operational";
      if (!signal.gauge || rank[measured] > rank[signal.gauge]) signal.gauge = measured;
    } else if (Number.isFinite(value) && value > 0) {
      // Do not round increase() before deciding whether a poll happened.
      signal[kind] += value;
    }
    signals.set(key, signal);
  };
  gauges.forEach((sample) => add(sample, "gauge"));
  successes.forEach((sample) => add(sample, "ok"));
  failures.forEach((sample) => add(sample, "failed"));
  const resolved = new Set<string>();
  const observed = new Map<string, Set<string>>();
  const merge = (key: string, health: HealthState, cause: HealthCause, reason: string) => {
    const row = rows.get(key)!;
    if (!resolved.has(key) || rank[health] > rank[row.health]) {
      row.health = health;
      row.healthCause = cause;
      row.healthReason = reason;
    }
    resolved.add(key);
  };
  for (const signal of signals.values()) {
    const minutes = windowFor(rows.get(signal.rowKey)!.spec) / 60;
    const interfaces = observed.get(signal.rowKey) ?? new Set<string>();
    interfaces.add(signal.iface);
    observed.set(signal.rowKey, interfaces);
    if (signal.gauge === "unhealthy") {
      merge(signal.rowKey, "unhealthy", "blocked", "The router stopped sending it requests: none of its URLs is answering.");
    } else if (signal.failed > 0 && signal.ok === 0) {
      merge(signal.rowKey, "unhealthy", "checks-failing", `Every block check failed in the last ${minutes} minutes.`);
      rows.get(signal.rowKey)!.failingChecks.push({ apiInterface: signal.iface, instance: signal.instance });
    } else if (signal.ok > 0) {
      merge(signal.rowKey, "operational", "ok", `Block checks passed in the last ${minutes} minutes.`);
    } else if (signal.gauge === "operational") {
      // "In rotation" is the router's default for a provider it has not taken
      // out; a url nobody polls or routes to reads so however broken it is.
      // Once poll evidence expires, it must not turn a dead endpoint green.
      merge(signal.rowKey, "unknown", "no-checks", `No block check came back in the last ${minutes} minutes, so nothing confirms it is working.`);
    } else {
      merge(signal.rowKey, "unknown", "no-data", missing);
    }
  }
  for (const [key, interfaces] of expected) {
    const seen = observed.get(key);
    for (const iface of interfaces) {
      if (!seen?.has(iface))
        merge(key, "unknown", "no-data", `No data yet for its ${iface} endpoint: the router reports nothing about it.`);
    }
  }
  return routerId ? new Map([...rows].filter(([, row]) => row.routerIds.includes(routerId))) : rows;
}

/** How far back the start of an unhealthy provider's trouble is looked for, and at what step. */
export const SINCE_LOOKBACK_SEC = 86_400;
export const SINCE_STEP_SEC = 60;
/** Steps with no point after which a blocked run is read as two stretches. */
export const SINCE_GAP_STEPS = 5;

/**
 * Since when each UNHEALTHY provider has been so, written onto its row. Two
 * range reads over the last day, narrowed to the unhealthy providers' names,
 * and none at all when every provider is fine - the usual case. A blocked
 * provider: the start of the run of minutes its blocked gauge has been 1, a
 * run that ends at a hole of over `SINCE_GAP_STEPS` minutes in the series. One
 * whose every block check fails: the last minute a check passed on the
 * interface and scrape target that fail (`failingChecks`), the earliest of
 * them when several do - the grain the verdict is decided at, so a passing
 * interface says nothing about a failing one. A run that reaches the start of
 * the day read is at least that old (`healthSinceOrEarlier`).
 * A refused read, or a store client that can't read a range, leaves `healthSince`
 * null: the roster says why a provider is unhealthy either way.
 */
export async function readHealthSince(prom: PrometheusClient, rows: Map<string, UpstreamHealth>, nowSec: number = Date.now() / 1000): Promise<void> {
  const bad = [...rows.values()].filter((r) => r.health === "unhealthy");
  if (!bad.length) return;
  const names = bad.map((r) => r.endpointId);
  const end = Math.floor(nowSec / SINCE_STEP_SEC) * SINCE_STEP_SEC;
  const start = end - SINCE_LOOKBACK_SEC;
  const step = `${SINCE_STEP_SEC}s`;
  try {
    const [blocked, passed] = await Promise.all([
      bad.some((r) => r.healthCause === "blocked") ? prom.queryRangeOrNull(qProviderBlockedOver(names), start, end, step) : null,
      bad.some((r) => r.healthCause === "checks-failing") ? prom.queryRangeOrNull(qBlockChecksPassedOver(names, step), start, end, step) : null,
    ]);
    const points = (rowsOf: typeof blocked, label: "provider_address" | "endpoint_id", r: UpstreamHealth, also?: { apiInterface: string; instance: string }): [number, number][] | null => {
      const series = (rowsOf ?? []).find((s) => (s.metric[label] ?? "").toLowerCase() === r.endpointId.toLowerCase() && (s.metric.spec ?? "") === r.spec
        && (!also || ((s.metric.apiInterface ?? "") === also.apiInterface && (s.metric.instance ?? "") === also.instance)));
      return series ? series.values.map(([t, v]) => [Number(t), Number(v)] as [number, number]).sort((a, b) => a[0] - b[0]) : null;
    };
    const reachesStart = (t: number) => t <= start + SINCE_STEP_SEC;
    for (const r of bad) {
      if (r.healthCause === "blocked") {
        const pts = points(blocked, "provider_address", r);
        if (!pts?.length) continue;
        let since: number | null = null;
        // A hole in the series (the router down, or not scraped) ends the run: what was before it is another stretch.
        for (let i = pts.length - 1; i >= 0 && pts[i]![1] >= 1; i--) {
          if (since !== null && since - pts[i]![0] > SINCE_GAP_STEPS * SINCE_STEP_SEC) break;
          since = pts[i]![0];
        }
        if (since === null) continue;
        r.healthSince = since;
        r.healthSinceOrEarlier = reachesStart(since);
      } else if (r.healthCause === "checks-failing" && passed) {
        for (const failing of r.failingChecks) {
          const pts = points(passed, "endpoint_id", r, failing) ?? [];
          let last: number | null = null;
          for (let i = pts.length - 1; i >= 0; i--) if (pts[i]![1] > 0) { last = pts[i]![0]; break; }
          const since = last ?? start;
          if (r.healthSince !== null && r.healthSince <= since) continue;
          r.healthSince = since;
          r.healthSinceOrEarlier = last === null;
        }
      }
    }
  } catch {
    // "Since when" is extra: without it the row still says what is wrong.
  }
}

/** The providers that are not operational, unhealthy first then the oldest trouble, for the top bar's list. */
export function providersNeedingAttention(rows: Map<string, UpstreamHealth>, limit = 30): ProviderAttention[] {
  return [...rows.values()]
    .filter((r) => r.health !== "operational")
    .sort((a, b) => rank[b.health] - rank[a.health] || (a.healthSince ?? Infinity) - (b.healthSince ?? Infinity) || a.spec.localeCompare(b.spec) || a.endpointId.localeCompare(b.endpointId))
    .slice(0, limit)
    .map((r) => ({ endpointId: r.endpointId, spec: r.spec, health: r.health, cause: r.healthCause, reason: r.healthReason, since: r.healthSince, sinceOrEarlier: r.healthSinceOrEarlier }));
}
