/**
 * Incidents — bursts of FINAL customer failures, explained.
 *
 * The shape follows the way a real incident was actually written up for a
 * customer: the primary was down for ~6 minutes,
 * the router recovered 114 requests by failing over, and the 63 that still
 * failed were all debug_* calls — because only the primary declares DEBUG.
 * Every line of that story is derivable: episodes from
 * `smartrouter_requests_failed_total`, recoveries from
 * `smartrouter_retries_success_total`, blame from the relay counters plus the
 * config's roles, the method split from the log lines, and the capability gap
 * from the addons the values file declares. This module derives it; nothing
 * here is invented, and every part degrades to absence when its source is
 * missing (no Loki → no method split; no values file → no roles, no gap).
 */
import { buildChainMetaByIndex, errorMeaning, ENDPOINT_METRICS, OPTIONAL_METRICS, type Incident, type IncidentsReport } from "@sr/shared";
import type { PrometheusClient, PromMatrixSample } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import { LokiService, groupErrors } from "./loki.js";

/** A 5m bucket must carry at least this many final failures to count. */
const BUCKET_FLOOR = 5;
/** Buckets this close (seconds) belong to one episode. */
const MERGE_GAP_SEC = 900;
const BUCKET_SEC = 300;
/** Most incidents shown; the rest of the day is noise by construction. */
const MAX_INCIDENTS = 6;
/** A provider is "failing during the episode" past this relay-failure rate. */
const BLAME_RATE = 0.5;

export interface Episode {
  spec: string;
  startUnix: number;
  endUnix: number;
  failures: number;
}

/** Contiguous over-floor buckets → episodes, biggest first. Pure. */
export function detectEpisodes(rows: PromMatrixSample[], nowUnix: number): Episode[] {
  const out: Episode[] = [];
  for (const row of rows) {
    const spec = row.metric.spec;
    if (!spec) continue;
    let cur: Episode | null = null;
    for (const [ts, v] of row.values) {
      const t = Number(ts);
      const n = Number(v);
      if (!Number.isFinite(n) || n < BUCKET_FLOOR) continue;
      if (cur && t - cur.endUnix <= MERGE_GAP_SEC) {
        cur.endUnix = t;
        cur.failures += n;
      } else {
        if (cur) out.push(cur);
        // The bucket value covers the 5 minutes BEFORE its timestamp.
        cur = { spec, startUnix: t - BUCKET_SEC, endUnix: t, failures: n };
      }
    }
    if (cur) out.push(cur);
  }
  return out
    .map((e) => ({ ...e, failures: Math.round(e.failures) }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, MAX_INCIDENTS)
    .map((e) => ({ ...e, startUnix: Math.round(e.startUnix), endUnix: Math.round(e.endUnix) }))
    .map((e) => ({ ...e }));
}

/** The customer-ready bullets. Pure; B2 words; nothing beyond its inputs. */
export function composeStory(i: Omit<Incident, "story" | "id" | "chainName">, chainName: string): string[] {
  const mins = Math.max(1, Math.round((i.endUnix - i.startUnix) / 60));
  const story: string[] = [];
  for (const b of i.blamed) {
    story.push(
      `${b.upstream}${b.role ? `, the ${b.role} provider on ${chainName},` : ""} was failing for ~${mins} minutes (${Math.round(b.failRate * 100)}% of its relays).`,
    );
  }
  if (i.blamed.length === 0) story.push(`${chainName} had a burst of failures for ~${mins} minutes.`);
  if (i.retriesRecovered != null && i.retriesRecovered > 0) {
    story.push(`The router retried and recovered ${i.retriesRecovered.toLocaleString("en-US")} requests automatically.`);
  }
  const topMethods = i.failedMethods.filter((m) => m.method).slice(0, 3);
  story.push(
    `${i.failures.toLocaleString("en-US")} requests still failed${
      topMethods.length ? ` — mostly ${topMethods.map((m) => m.method).join(", ")}` : ""
    }.`,
  );
  // The cause, from the dominant error in the logs — the code plus what it
  // means in plain words, so the reader does not have to know the registry.
  const dominant = i.failedMethods[0];
  if (dominant?.errorName) {
    const total = i.failedMethods.reduce((a, m) => a + m.count, 0);
    const share = total > 0 ? Math.round((dominant.count / total) * 100) : 0;
    story.push(`Cause: ${share}% of the logged errors were ${dominant.errorName} — ${errorMeaning(dominant.errorName)}.`);
  }
  if (i.capabilityGap) story.push(i.capabilityGap);
  return story;
}

export class IncidentsService {
  constructor(
    private readonly prom: PrometheusClient,
    private readonly configSvc?: ConfigurationService,
    private readonly loki: LokiService = new LokiService(),
  ) {}

  async incidents(lookbackHours = 24): Promise<IncidentsReport> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.prom.queryRange(
      `sum by (spec) (increase(${OPTIONAL_METRICS.requestsFailedTotal}[5m]))`,
      now - lookbackHours * 3600,
      now,
      String(BUCKET_SEC),
    );
    const episodes = detectEpisodes(rows, now);

    const incidents = await Promise.all(episodes.map((e) => this.explain(e, now)));
    return { incidents, lookbackHours, computedAtUnix: now };
  }

  private async explain(e: Episode, now: number): Promise<Incident> {
    const meta = buildChainMetaByIndex(e.spec);
    const dur = Math.max(BUCKET_SEC, e.endUnix - e.startUnix);
    const at = ` @ ${e.endUnix}`;
    const E = ENDPOINT_METRICS;
    const sel = `{spec="${e.spec}"}`;

    const [retries, errRows, servedRows] = await Promise.all([
      this.prom.scalar(`round(sum(increase(${OPTIONAL_METRICS.retriesSuccessTotal}${sel}[${dur}s]${at})))`),
      this.prom.query(`sum by (endpoint_id) (increase(${E.totalErrored}${sel}[${dur}s]${at}))`),
      this.prom.query(`sum by (endpoint_id) (increase(${E.totalRelaysServiced}${sel}[${dur}s]${at}))`),
    ]);

    const served = new Map(servedRows.map((r) => [r.metric.endpoint_id ?? "", Number(r.value[1]) || 0]));
    const roleOf = new Map<string, "primary" | "backup">();
    const addonsOf = new Map<string, Set<string>>();
    for (const router of this.configSvc?.getRouters() ?? []) {
      if (router.spec !== e.spec) continue;
      for (const node of router.nodes) {
        roleOf.set(node.name, node.isBackup ? "backup" : "primary");
        const set = addonsOf.get(node.name) ?? new Set<string>();
        for (const ep of node.endpoints) for (const a of ep.addons ?? []) set.add(a.toLowerCase());
        addonsOf.set(node.name, set);
      }
    }
    const blamed = errRows
      .map((r) => {
        const up = r.metric.endpoint_id ?? "";
        const failed = Number(r.value[1]) || 0;
        const attempts = failed + (served.get(up) ?? 0);
        return { upstream: up, role: roleOf.get(up) ?? null, failed: Math.round(failed), failRate: attempts > 0 ? failed / attempts : 0 };
      })
      .filter((b) => b.upstream && b.failed >= BUCKET_FLOOR && b.failRate >= BLAME_RATE)
      .sort((a, b) => b.failRate - a.failRate);

    // Method split from the logs, scoped to the episode (±1 min of slack for
    // clock skew between the counter scrape and the log line).
    let failedMethods: Incident["failedMethods"] = [];
    if (this.loki.available) {
      try {
        const lines = await this.loki.recentErrors(e.spec, undefined, 200, e.startUnix - 60, e.endUnix + 60);
        failedMethods = groupErrors(lines, 5).map((g) => ({
          method: g.method, count: g.count, errorName: g.errorName, example: g.example,
        }));
      } catch {
        // The story stands without the split.
      }
    }

    // The addon gap, only when the config PROVES it: the dominant failed
    // methods map to an addon that some providers on the chain declare and
    // others do not.
    let capabilityGap: string | null = null;
    const prefixes = [["debug_", "debug"], ["trace_", "trace"]] as const;
    for (const [prefix, addon] of prefixes) {
      const hits = failedMethods.filter((m) => m.method?.startsWith(prefix));
      if (!hits.length || addonsOf.size === 0) continue;
      const haves = [...addonsOf.entries()].filter(([, a]) => a.has(addon)).map(([n]) => n);
      const lacks = [...addonsOf.entries()].filter(([, a]) => !a.has(addon)).map(([n]) => n);
      if (haves.length && lacks.length) {
        capabilityGap = `On this chain only ${haves.join(", ")} serves ${addon.toUpperCase()} calls — ${lacks.join(", ")} rejects them as an unsupported method, so ${prefix}* traffic has no fallback.`;
        break;
      }
    }

    // Setup analysis: what the topology allowed. A single-upstream chain has
    // nowhere to fail over to; every-upstream-failing is a different incident
    // from one provider down.
    const upstreamsSeen = new Set([...served.keys(), ...blamed.map((b) => b.upstream)].filter(Boolean));
    let setupNote: string | null = null;
    if ((this.configSvc?.getRouters().length ? roleOf.size : upstreamsSeen.size) === 1) {
      setupNote = "This chain runs on a single upstream — there was nowhere to fail over to.";
    } else if (blamed.length >= 2 && upstreamsSeen.size > 0 && blamed.length >= upstreamsSeen.size) {
      setupNote = "Every upstream on the chain was failing at the same time — failover had nowhere better to go.";
    }

    const base = {
      spec: e.spec,
      startUnix: e.startUnix,
      endUnix: e.endUnix,
      ongoing: now - e.endUnix < 2 * BUCKET_SEC,
      failures: e.failures,
      retriesRecovered: retries == null ? null : Math.round(retries),
      blamed,
      failedMethods,
      capabilityGap,
    };
    const story = composeStory(base, meta.name);
    if (setupNote) story.push(setupNote);
    return { ...base, id: `${e.spec}:${e.startUnix}`, chainName: meta.name, story };
  }
}
