import { RECORDED_OUTCOMES } from "../error-requests.js";

/** The router's log lines, counted once a minute by the fleet's Loki ruler. Any
 * hour with a sample shows the recording ran for this customer then. */
export const RECORDED_ROUTER_LINES = 'smartrouter_log_lines:count1m{component="router"}';

const HOUR = 3600;
const HOURS = 24;

/**
 * The counts read before the first model turn: per chain, the recorded requests
 * and failures of each of the last 24 hours, and the router's recorded log lines
 * per hour. One range read with a one-hour step keeps every selector at one
 * hour, inside the read policy's 24-hour total lookback.
 */
export function prefetchRead(end: number) {
  const hourly = (expression: string, name: string) =>
    `label_replace(${expression}, "count", ${JSON.stringify(name)}, "", "")`;
  return {
    operationId: "metrics.query_range" as const,
    parameters: {
      query: [
        hourly(`sum by (chain) (sum_over_time(${RECORDED_OUTCOMES.requests}[1h]))`, "requests"),
        hourly(`sum by (chain) (sum_over_time(${RECORDED_OUTCOMES.failures}[1h]))`, "failures"),
        hourly(`sum(sum_over_time(${RECORDED_ROUTER_LINES}[1h]))`, "router_lines"),
      ].join(" or "),
      start: end - (HOURS - 1) * HOUR,
      end,
      step: HOUR,
    },
    window: { start: end - HOURS * HOUR, end, partial: true },
  };
}

export interface PrefetchedCounts {
  recordingLive: boolean;
  hoursWithRouterLines: number;
  chains: {
    chain: string;
    requestsLastHour: number;
    failuresLastHour: number;
    requestsLast24Hours: number;
    failuresLast24Hours: number;
  }[];
}

/** The range result as per-chain totals, or null when it is not a matrix. A
 * chain or hour with no sample counted nothing: the ruler writes no sample for
 * a minute with nothing to count. */
export function summarizePrefetch(data: unknown, end: number): PrefetchedCounts | null {
  const payload = object(object(data)?.data);
  if (payload?.resultType !== "matrix" || !Array.isArray(payload.result)) return null;
  const chains = new Map<string, PrefetchedCounts["chains"][number]>();
  const routerHours = new Set<number>();
  for (const entry of payload.result) {
    const metric = object(object(entry)?.metric);
    const values = object(entry)?.values;
    if (!metric || !Array.isArray(values)) return null;
    for (const point of values) {
      if (!Array.isArray(point) || point.length !== 2) return null;
      const at = Math.round(Number(point[0]));
      const value = Math.round(Number(point[1]));
      if (!Number.isFinite(at) || !Number.isFinite(value)) return null;
      if (metric.count === "router_lines") {
        if (value > 0) routerHours.add(at);
        continue;
      }
      if (typeof metric.chain !== "string") continue;
      const row = chains.get(metric.chain) ?? {
        chain: metric.chain,
        requestsLastHour: 0,
        failuresLastHour: 0,
        requestsLast24Hours: 0,
        failuresLast24Hours: 0,
      };
      if (metric.count === "requests") {
        row.requestsLast24Hours += value;
        if (at === end) row.requestsLastHour += value;
      } else if (metric.count === "failures") {
        row.failuresLast24Hours += value;
        if (at === end) row.failuresLastHour += value;
      } else continue;
      chains.set(metric.chain, row);
    }
  }
  return {
    recordingLive: routerHours.size > 0,
    hoursWithRouterLines: routerHours.size,
    chains: [...chains.values()].sort(
      (a, b) =>
        b.failuresLast24Hours - a.failuresLast24Hours ||
        b.requestsLast24Hours - a.requestsLast24Hours ||
        a.chain.localeCompare(b.chain),
    ),
  };
}

/** What the model reads beside the counts. */
export const PREFETCH_NOTE =
  "Read by the server before your first turn, from the recorded one-minute counts: per chain, requests and router failures in the last hour and the last 24 hours. Answer a count question for those windows from these figures without another read; read again only for another window, one chain's detail, transactions, errors or the request events themselves. A chain listed with 0 counted none in that window. recordingLive true means the recording ran in the window, so a chain or count absent here had no requests: when the requests are absent too, no requests reached the routers, so nothing failed; say so plainly and never call it a coverage gap. recordingLive false means nothing was recorded in the window: a coverage gap, so read the requests from the logs before answering. The newest two minutes may not be recorded yet.";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
