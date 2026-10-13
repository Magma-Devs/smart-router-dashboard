import { ENDPOINT_METRICS, selector, type HealthState } from "@sr/shared";
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
  healthReason: string;
  routerIds: string[];
}

const rank: Record<HealthState, number> = { operational: 0, unknown: 1, unhealthy: 2 };
const missing =
  "No current health measurement or successful block polls reported; check the router and Prometheus scrape.";

/** Four reads, independent of fleet size; shared by the roster and overview counts. */
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
    prom.query(`${ENDPOINT_METRICS.overallHealth}${sel}`),
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
      row = { endpointId, spec: chain, health: "unknown", healthReason: missing, routerIds: [] };
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
  type Signal = { rowKey: string; iface: string; gauge?: HealthState; ok: number; failed: number };
  const signals = new Map<string, Signal>();
  const add = (sample: PromVectorSample, kind: "gauge" | "ok" | "failed") => {
    const id = sample.metric.endpoint_id;
    const chain = sample.metric.spec ?? "";
    if (!id || (spec && chain !== spec)) return;
    ensure(id, chain);
    const rowKey = upstreamKey(id, chain);
    const iface = sample.metric.apiInterface ?? "";
    const key = `${rowKey}\u0000${iface}\u0000${sample.metric.instance ?? ""}`;
    const signal = signals.get(key) ?? { rowKey, iface, ok: 0, failed: 0 };
    const value = Number(sample.value[1]);
    if (kind === "gauge") {
      const measured = !Number.isFinite(value)
        ? "unknown"
        : value >= 1
          ? "operational"
          : "unhealthy";
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
  const merge = (key: string, health: HealthState, reason: string) => {
    const row = rows.get(key)!;
    if (!resolved.has(key) || rank[health] > rank[row.health]) {
      row.health = health;
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
      merge(
        signal.rowKey,
        "unhealthy",
        "The router's live health check reports this upstream unhealthy.",
      );
    } else if (signal.failed > 0 && signal.ok === 0) {
      merge(
        signal.rowKey,
        "unhealthy",
        `All reported block polls failed in the last ${minutes} minutes.`,
      );
    } else if (signal.ok > 0) {
      merge(
        signal.rowKey,
        "operational",
        signal.gauge === "operational"
          ? "The router's live health check reports this upstream operational."
          : `Successful block polls reported in the last ${minutes} minutes.`,
      );
    } else if (signal.gauge === "operational") {
      // The router resets this gauge to 1 during epoch updates. Once poll
      // evidence expires, it must not turn a dead endpoint back to green.
      merge(
        signal.rowKey,
        "unknown",
        `No block-poll outcome reported in the last ${minutes} minutes; the live health gauge alone cannot confirm recovery. Check the router and Prometheus scrape.`,
      );
    } else {
      merge(signal.rowKey, "unknown", missing);
    }
  }
  for (const [key, interfaces] of expected) {
    const seen = observed.get(key);
    for (const iface of interfaces) {
      if (!seen?.has(iface))
        merge(
          key,
          "unknown",
          `No current health data reported for the configured ${iface} interface; check the router and Prometheus scrape.`,
        );
    }
  }
  return routerId ? new Map([...rows].filter(([, row]) => row.routerIds.includes(routerId))) : rows;
}
