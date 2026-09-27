/**
 * The issue log: every problem the Status page has found, kept as ONE issue
 * for as long as it lasts.
 *
 * ## One issue per problem, for its whole life
 *
 * A background cycle (every 5 minutes) runs the detection on the live window.
 * A problem it finds opens an issue, with an id that stays the same while the
 * problem keeps failing. Each cycle updates that issue in place — its numbers
 * always, its words when the facts move, and the model is shown the version
 * already on screen so an update reads as an update, not a second problem.
 * When a cycle no longer finds it, the issue is resolved; if it comes back
 * within an hour it is the same issue, reopened.
 *
 * ## Any time window, instantly
 *
 * The page's window selector is a filter over this log — "issues active at
 * any point in the last 6 hours" — not a new analysis. Changing it costs one
 * array filter and no model call. The model only ever runs in the background,
 * and only for an issue whose facts changed.
 *
 * ## Kept between restarts, when asked
 *
 * `ISSUES_STATE_FILE` persists the log after every cycle. Unset, it lives in
 * memory: a restart finds every open issue again on its first cycle, but
 * forgets what was already resolved.
 */
import {
  buildChainMetaByIndex,
  DEFAULT_WINDOW,
  OPTIONAL_METRICS,
  ROUTER_METRICS,
  WINDOWS,
  qClientRequestsBy,
  type MetricWindow,
  type StatusFinding,
  type StatusInsight,
} from "@sr/shared";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { PrometheusClient } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import type { MetricsDetailService } from "./metrics-detail.js";
import {
  FormulatedIssueService,
  severityOf,
  measuredFields,
  type AddonCalls,
  type ChainOutcome,
  type FailurePath,
  type FailurePaths,
  type WriteCalls,
  type FormulatedIssue,
  type IssueSeverity,
} from "./formulated-issues.js";
import { LokiService, flowOf, groupErrors, type FailedRequest, type RequestTrace } from "./loki.js";
import { BedrockService, bedrockGate, type BedrockLogger } from "./bedrock.js";
import { config } from "../config.js";

/** Where an issue is in its life. */
export type IssueStatus = "open" | "resolved";

/** An issue as the page receives it: what was written, plus its life so far. */
export interface ServedIssue extends FormulatedIssue {
  /** The same for as long as the problem keeps failing. */
  id: string;
  status: IssueStatus;
  openedAtUnix: number;
  /** The last cycle that still found it. */
  updatedAtUnix: number;
  /** The last failure seen, once no cycle finds it any more. */
  resolvedAtUnix: number | null;
  /** When the badge last changed; equal to `openedAtUnix` if it never has. */
  severitySinceUnix: number;
}

export interface IssuesSnapshot {
  window: MetricWindow;
  /** When the last detection cycle finished. */
  computedAtUnix: number;
  logsAvailable: boolean;
  configAvailable: boolean;
  issues: ServedIssue[];
}

/**
 * A count as the card's words would state it. Exact below 10 — "6 failed"
 * against a real 3 is wrong by half — and the leading digit above, so the
 * words stay within one step of the truth without being rewritten for every
 * tick of a busy counter.
 */
function scale(n: number | null): string {
  if (n == null) return "?";
  if (n < 10) return String(Math.max(0, Math.round(n)));
  const mag = Math.floor(Math.log10(n));
  return `${Math.floor(n / 10 ** mag)}e${mag}`;
}

/**
 * Bumped when what the numbers MEAN changes, so every saved issue is rewritten
 * once. 2: failures come from the final-result log, once per customer request —
 * words written from the old per-attempt counter overstated them.
 */
const PRINT_VERSION = 2;

/**
 * What makes an issue worth rewriting. Headlines carry the numbers, so a rate
 * moving from 4% to 38% changes this and a quiet chain does not.
 *
 * The outcome goes in by SCALE, not by count. The counts tick every cycle, and
 * keying on them would re-word an unchanged story each time; zero-to-some and
 * a tenfold jump are news.
 *
 * The badge goes in as itself. It is decided by a SHARE of the chain's
 * requests, which can cross the line while neither count changes scale — and
 * a card whose badge moved must be rewritten, or it keeps saying "the chain is
 * not usable" under an amber badge.
 */
export function fingerprint(
  findings: StatusFinding[],
  insights: StatusInsight[] = [],
  outcome?: ChainOutcome,
  severity?: IssueSeverity,
): string {
  return [
    `v${PRINT_VERSION}`,
    ...(outcome ? [`o:${scale(outcome.failures)}:${scale(outcome.recovered)}`] : []),
    // The MAIN way requests fail, without its count: the backup starting to
    // fail too is news, one more request down the same path is not. Only the
    // first path — the traced sample is the newest few, so the rare paths
    // behind it come and go each cycle and would re-word an unchanged story.
    ...(outcome?.paths?.groups[0] ? [`p:${outcome.paths.groups[0].flow}`] : []),
    ...(severity ? [`s:${severity}`] : []),
    ...findings.map((f) => `${f.id}|${f.tier}|${f.headline}`),
    // Drift is part of the story, so it is part of what makes the story
    // stale — otherwise a chain quietly getting slower keeps last week's
    // sentence forever.
    ...insights.map((x) => `i:${x.kind}:${x.spec}:${x.upstream ?? ""}|${x.value}`),
  ]
    .sort()
    .join("~");
}

/**
 * Each chain's outcome for the window, read once for every chain: what the
 * router saved, what still failed, and the requests both are a share of.
 *
 * Both counters register lazily, on the first failure or the first saved
 * retry. So no series ANYWHERE is "not measured" (null); a family that has
 * series for other chains but none for this one is a real zero — the counter
 * exists and was never moved for this chain. A failed read is [] from the
 * client, which lands on null: unknown, never an invented zero.
 */
/**
 * Debug and trace calls per chain, grouped by the add-on they need. The
 * method name says which: the router routes `debug_*` only to providers
 * declaring DEBUG, and `trace_*` to TRACE.
 */
const addonQuery = (metric: string, label: string, range: string): string =>
  `round(sum by (spec, addon) (label_replace(increase(${metric}{${label}=~"(debug|trace)_.*"}[${range}]), "addon", "$1", "${label}", "(debug|trace)_.*")))`;

/**
 * Failed requests per chain, through the values file's router ids. A chain
 * gets a number only when at least one of its routers has logs in the
 * window — "0 failed" is a claim, and a router whose logs never reach the
 * store cannot back it. A router the config does not know is left out.
 */
export function failedBySpec(
  countsByRouter: Map<string, number>,
  routers: { id: string; spec: string }[],
  withLogs: Set<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of routers) {
    const id = r.id.toLowerCase();
    if (!withLogs.has(id)) continue;
    out.set(r.spec, (out.get(r.spec) ?? 0) + (countsByRouter.get(id) ?? 0));
  }
  return out;
}

/**
 * A burst: the most failed customer requests on one chain inside any five
 * minutes of the window. The team's alert fires on MORE THAN FIVE distinct
 * failed requests in five minutes on a chain; the page uses the same test, so
 * whenever the alert fires there is an issue for it on the page.
 */
export const BURST_WINDOW_SEC = 300;
export const BURST_MIN = 6;

export interface Burst {
  count: number;
  fromUnix: number;
  toUnix: number;
  /** The newest failure in the window, burst or not — "still happening?" */
  lastUnix: number;
}

/** The densest five minutes in a list of failure times. */
export function peakBurst(times: number[], windowSec = BURST_WINDOW_SEC): Burst | null {
  if (times.length === 0) return null;
  const t = [...times].sort((a, b) => a - b);
  let best = { count: 0, from: t[0]!, to: t[0]! };
  let i = 0;
  for (let j = 0; j < t.length; j++) {
    while (t[j]! - t[i]! > windowSec) i++;
    if (j - i + 1 > best.count) best = { count: j - i + 1, from: t[i]!, to: t[j]! };
  }
  return { count: best.count, fromUnix: best.from, toUnix: best.to, lastUnix: t[t.length - 1]! };
}

/**
 * A burst as a finding, so it takes the same road as every other problem:
 * it opens the chain's issue or joins the one already open. Severity is not
 * set here — six failed requests out of thousands is a working chain, and
 * `severityOf` decides that from the outcome like it does for everything.
 */
export function burstFinding(spec: string, chainName: string, b: Burst, now: number): StatusFinding {
  return {
    kind: "dead",
    tier: "critical",
    id: `${spec}:burst`,
    spec,
    chainName,
    upstream: null,
    role: null,
    headline: `${b.count} customer requests failed within five minutes`,
    metric: { value: String(b.count), label: "failed in 5 min" },
    codes: [],
    evidence: [
      { k: "failed", v: `${b.count} requests` },
      { k: "within", v: "5 min" },
    ],
    remedy: "",
    sinceSec: null,
    firstSeenUnix: b.fromUnix,
    lastSeenUnix: b.lastUnix,
    ongoing: now - b.lastUnix < BURST_WINDOW_SEC,
    // No per-provider selection behind a chain-wide count.
    decision: [],
  };
}

/**
 * What the router's own logs say, once per customer request: how many failed
 * per chain, which methods the failed requests had called, and the bursts.
 */
export interface LogOutcome {
  /** Failed customer requests per chain; a chain is absent when its logs are. */
  failed: Map<string, number>;
  /** Failed requests by method, per chain — scaled up from a sample in a bad hour. */
  failedMethods: Map<string, Map<string, number>>;
  /** Chains whose failures crossed the alert's test, with the densest five minutes. */
  bursts: Map<string, Burst>;
  /** The failed requests' paths through the router, grouped, per chain. */
  paths: Map<string, FailurePaths>;
}

/**
 * Read the logs for one window, cheaply. The label index says which routers
 * have logs; one filtered read returns the failed requests (rare); each
 * one's method is looked up on its own pod in the minutes around it. The
 * fleet-wide count of every request is NOT read here — Prometheus has it —
 * because scanning ~600k lines three times per cycle is what the store's
 * gateway answered with a 504.
 */
export async function readLogs(
  loki: Pick<LokiService, "routersWithLogs" | "failedRequests" | "countFailed" | "methodsOf" | "traceRequests">,
  rangeSec: number,
  routers: { id: string; spec: string }[],
  now = Math.floor(Date.now() / 1000),
): Promise<LogOutcome | null> {
  const withLogs = await loki.routersWithLogs(rangeSec, now);
  if (!withLogs) return null;
  const { byRouter, capped } = await loki.failedRequests(rangeSec, 5000, now);

  const counts = new Map([...byRouter].map(([router, list]) => [router, list.length]));
  if (capped) {
    // A bad hour overflowed the read: count the routers that had failures,
    // on their own pods, and keep the ids as a sample for the method split.
    for (const [router, n] of await loki.countFailed([...byRouter.keys()], rangeSec, now)) {
      counts.set(router, Math.max(n, counts.get(router) ?? 0));
    }
  }
  const failures: FailedRequest[] = [...byRouter.values()].flat();
  const methods = await loki.methodsOf(failures);
  // Each failed request's path — up to 20 per pod, newest first. Failures are
  // rare, so on a normal day this is every one of them.
  const traces = await loki.traceRequests(failures, 20);

  const specOf = new Map(routers.map((r) => [r.id.toLowerCase(), r.spec]));
  const sampled = new Map<string, Map<string, number>>();
  const sampledCount = new Map<string, number>();
  for (const [router, list] of byRouter) {
    const spec = specOf.get(router);
    if (!spec) continue;
    const m = sampled.get(spec) ?? new Map<string, number>();
    for (const f of list) {
      const method = methods.get(f.id) ?? "unknown";
      m.set(method, (m.get(method) ?? 0) + 1);
    }
    sampled.set(spec, m);
    sampledCount.set(spec, (sampledCount.get(spec) ?? 0) + list.length);
  }
  const failed = failedBySpec(counts, routers, withLogs);

  // Bursts per chain, routers on one chain together — the alert counts by chain.
  const timesBySpec = new Map<string, number[]>();
  for (const [router, list] of byRouter) {
    const spec = specOf.get(router);
    if (!spec) continue;
    timesBySpec.set(spec, [...(timesBySpec.get(spec) ?? []), ...list.map((f) => f.atUnix)]);
  }
  const bursts = new Map<string, Burst>();
  for (const [spec, times] of timesBySpec) {
    const b = peakBurst(times);
    if (b && b.count >= BURST_MIN) bursts.set(spec, b);
  }
  const failedMethods = new Map<string, Map<string, number>>();
  for (const [spec, m] of sampled) {
    const seen = sampledCount.get(spec) ?? 0;
    const real = failed.get(spec) ?? seen;
    const k = seen > 0 && real > seen ? real / seen : 1;
    failedMethods.set(spec, new Map([...m].map(([method, n]) => [method, Math.round(n * k)])));
  }
  const tracesBySpec = new Map<string, RequestTrace[]>();
  for (const [router, list] of byRouter) {
    const spec = specOf.get(router);
    if (!spec) continue;
    const found = list.map((f) => traces.get(f.id)).filter((t): t is RequestTrace => t != null);
    tracesBySpec.set(spec, [...(tracesBySpec.get(spec) ?? []), ...found]);
  }
  const paths = new Map<string, FailurePaths>();
  for (const [spec, list] of tracesBySpec) {
    const p = groupTraces(list);
    if (p) paths.set(spec, p);
  }
  return { failed, failedMethods, bursts, paths };
}

/**
 * Traced requests grouped by the way they went, most common first. Six that
 * each went "alchemy ✕ timed out → quicknode (backup) ✕ timed out → failed"
 * are one path of six — not "3 on one provider and 2 on another", which
 * reads as different requests.
 *
 * A trace with no provider on it is left out: its lines were not all read,
 * and a path with a gap in it would state something false.
 */
export function groupTraces(traces: RequestTrace[]): FailurePaths | null {
  const byFlow = new Map<string, { path: FailurePath; methods: Map<string, number> }>();
  let traced = 0;
  for (const t of traces) {
    if (t.attempts.length === 0) continue;
    traced++;
    const flow = flowOf(t);
    const g = byFlow.get(flow) ?? { path: { count: 0, flow, methods: [], seconds: [t.seconds, t.seconds] }, methods: new Map() };
    g.path.count++;
    g.path.seconds = [Math.min(g.path.seconds[0], t.seconds), Math.max(g.path.seconds[1], t.seconds)];
    g.methods.set(t.method, (g.methods.get(t.method) ?? 0) + 1);
    byFlow.set(flow, g);
  }
  if (traced === 0) return null;
  const groups = [...byFlow.values()].map(({ path, methods }) => ({
    ...path,
    methods: [...methods].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m),
  }));
  return { traced, groups: sortPaths(groups) };
}

/** Most requests first; the flow breaks a tie, so the order — and the fingerprint — is stable. */
function sortPaths(groups: FailurePath[]): FailurePath[] {
  return groups.sort((a, b) => b.count - a.count || a.flow.localeCompare(b.flow));
}

/** Several chains' paths as one — for an issue that covers more than one chain. */
export function mergePaths(list: (FailurePaths | null)[]): FailurePaths | null {
  const all = list.filter((p): p is FailurePaths => p != null);
  if (all.length === 0) return null;
  const byFlow = new Map<string, FailurePath>();
  for (const g of all.flatMap((p) => p.groups)) {
    const same = byFlow.get(g.flow);
    byFlow.set(
      g.flow,
      same
        ? {
            flow: g.flow,
            count: same.count + g.count,
            methods: [...new Set([...same.methods, ...g.methods])],
            seconds: [Math.min(same.seconds[0], g.seconds[0]), Math.max(same.seconds[1], g.seconds[1])],
          }
        : { ...g, methods: [...g.methods] },
    );
  }
  return { traced: all.reduce((a, p) => a + p.traced, 0), groups: sortPaths([...byFlow.values()]) };
}

export async function outcomesBySpec(
  prom: Pick<PrometheusClient, "query">,
  window: MetricWindow,
  /**
   * The router's own per-request logs. Without them, failures are unmeasured
   * — never taken from the requests_failed counter, which counts relay
   * ATTEMPTS.
   */
  logs: LogOutcome | null = null,
): Promise<(spec: string) => ChainOutcome> {
  const range = `${WINDOWS[window].rangeSeconds}s`;
  const [failed, saved, requested, addonSent, addonFailed, addonErrors, addonSaved, writeMethodRows] = await Promise.all([
    prom.query(`sum by (spec) (increase(${OPTIONAL_METRICS.requestsFailedTotal}[${range}]))`),
    prom.query(`sum by (spec) (increase(${OPTIONAL_METRICS.retriesSuccessTotal}[${range}]))`),
    // The client-side count the rest of the dashboard uses: one per customer
    // request, never the router's own probes.
    prom.query(qClientRequestsBy("spec", window)),
    // Sent from the client-side count; failed from the final-failure counter,
    // whose `method` label names the same call the histogram calls `function`.
    prom.query(addonQuery(ROUTER_METRICS.latencyCount, "function", range)),
    prom.query(addonQuery(OPTIONAL_METRICS.requestsFailedTotal, "method", range)),
    // Error replies ("the method does not exist") — answers, so the final
    // result calls them a success — and what a retry saved, per add-on.
    prom.query(addonQuery(OPTIONAL_METRICS.nodeErrorsTotal, "method", range)),
    prom.query(addonQuery(OPTIONAL_METRICS.retriesSuccessTotal, "method", range)),
    // Which methods are transactions is the router's call (stateful ≠ none),
    // not a list of names kept here: its write counter labels every one.
    prom.query(`count by (spec, method) (${OPTIONAL_METRICS.requestsWriteTotal})`),
  ]);

  const writeMethods = new Map<string, Set<string>>();
  for (const r of writeMethodRows) {
    const spec = r.metric.spec ?? "";
    const method = r.metric.method ?? "";
    if (!spec || !method) continue;
    const set = writeMethods.get(spec) ?? new Set<string>();
    set.add(method);
    writeMethods.set(spec, set);
  }
  const allWriteMethods = [...new Set([...writeMethods.values()].flatMap((m) => [...m]))];
  // Sent is the client-side count, one per request — the write counter itself
  // is per relay, and a transaction is broadcast to every primary.
  const writesSentRows = allWriteMethods.length
    ? await prom.query(
        `round(sum by (spec, function) (increase(${ROUTER_METRICS.latencyCount}{function=~"${allWriteMethods
          // Regex specials doubled-escaped: once for the regex, once for the
          // PromQL string it sits in. "/" is not special and must NOT be
          // escaped — PromQL rejects "\/", and one bad method would fail the
          // whole query for every chain.
          .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\\\$&"))
          .join("|")}"}[${range}])))`,
      )
    : [];
  const writesSent = new Map<string, number>();
  for (const r of writesSentRows) {
    const spec = r.metric.spec ?? "";
    if (!writeMethods.get(spec)?.has(r.metric.function ?? "")) continue;
    writesSent.set(spec, (writesSent.get(spec) ?? 0) + Math.round(Number(r.value[1]) || 0));
  }
  const writesOf = (spec: string): WriteCalls | null => {
    const sent = writesSent.get(spec) ?? 0;
    if (sent === 0) return null;
    if (!logs) return { sent, failed: null };
    const methodsHere = writeMethods.get(spec) ?? new Set<string>();
    let failedWrites = 0;
    for (const [method, n] of logs.failedMethods.get(spec) ?? []) if (methodsHere.has(method)) failedWrites += n;
    return { sent, failed: failedWrites };
  };
  const read = (rows: typeof failed) => {
    if (rows.length === 0) return (): number | null => null;
    const by = new Map(rows.map((r) => [r.metric.spec ?? "", Math.round(Number(r.value[1]) || 0)]));
    return (spec: string): number | null => by.get(spec) ?? 0;
  };
  const failures = read(failed);
  const recovered = read(saved);
  const requests = read(requested);

  const key = (r: (typeof failed)[number]) => `${r.metric.spec ?? ""}|${r.metric.addon ?? ""}`;
  const byKey = (rows: typeof failed) => new Map(rows.map((r) => [key(r), Math.round(Number(r.value[1]) || 0)]));
  const noAnswer = byKey(addonFailed);
  const errorReplies = byKey(addonErrors);
  const rescued = byKey(addonSaved);
  // With no error family firing anywhere there is no verdict on these calls —
  // absent is not the same as nothing failing.
  const measured = failed.length > 0 || addonErrors.length > 0;
  const addonCalls = (spec: string): AddonCalls[] =>
    addonSent
      .filter((r) => r.metric.spec === spec && (r.metric.addon === "debug" || r.metric.addon === "trace"))
      .map((r) => {
        const k = key(r);
        const sent = Math.round(Number(r.value[1]) || 0);
        const errs = errorReplies.get(k) ?? 0;
        // Both failure counters are per ATTEMPT; subtracting what a retry
        // saved turns them into calls the caller was left without. An error
        // reply is not retried, so for "no provider can serve this" — the
        // case this exists for — the two are the same number.
        const unserved = Math.max(0, errs + (noAnswer.get(k) ?? 0) - (rescued.get(k) ?? 0));
        return {
          addon: r.metric.addon as AddonCalls["addon"],
          sent,
          failed: measured ? Math.min(sent, unserved) : null,
          errorReplies: measured ? errs : null,
        };
      })
      .filter((a) => a.sent > 0);

  return (spec) => {
    return {
      recovered: recovered(spec),
      // Once per customer request, after every retry, from the router's own
      // log. `failures(spec)` above is the per-ATTEMPT counter and stays out
      // of this: a request that failed on one provider and was saved on
      // another is not a failure.
      failures: logs?.failed.get(spec) ?? null,
      // Client requests, one per request — the count the share is taken of.
      requests: requests(spec),
      addonCalls: addonCalls(spec),
      writes: writesOf(spec),
      paths: logs?.paths.get(spec) ?? null,
    };
  };
}

/** Several chains folded into one issue: the sum, or unknown if any is. */
function sumOutcomes(list: ChainOutcome[]): ChainOutcome {
  const add = (k: "recovered" | "failures" | "requests"): number | null =>
    list.some((o) => o[k] == null) ? null : list.reduce((s, o) => s + (o[k] ?? 0), 0);
  const byAddon = new Map<AddonCalls["addon"], AddonCalls>();
  for (const a of list.flatMap((o) => o.addonCalls)) {
    const cur = byAddon.get(a.addon);
    byAddon.set(
      a.addon,
      cur
        ? {
            addon: a.addon,
            sent: cur.sent + a.sent,
            failed: cur.failed == null || a.failed == null ? null : cur.failed + a.failed,
            errorReplies: cur.errorReplies == null || a.errorReplies == null ? null : cur.errorReplies + a.errorReplies,
          }
        : { ...a },
    );
  }
  const writes = list.map((o) => o.writes).filter((w): w is WriteCalls => w != null);
  return {
    recovered: add("recovered"),
    failures: add("failures"),
    requests: add("requests"),
    addonCalls: [...byAddon.values()],
    paths: mergePaths(list.map((o) => o.paths)),
    writes: writes.length
      ? {
          sent: writes.reduce((a, w) => a + w.sent, 0),
          failed: writes.some((w) => w.failed == null) ? null : writes.reduce((a, w) => a + (w.failed ?? 0), 0),
        }
      : null,
  };
}

/** One problem's record, kept across cycles. */
export interface IssueRecord {
  id: string;
  /** The chain's spec, or "callers" for the merged caller-side issue. */
  key: string;
  openedAtUnix: number;
  updatedAtUnix: number;
  resolvedAtUnix: number | null;
  severitySinceUnix: number;
  /** The fingerprint the words were written for. */
  print: string;
  issue: FormulatedIssue;
}

/** A resolved issue found again within this is the same issue, reopened. */
export const REOPEN_GRACE_SEC = 3600;
/** Resolved issues are kept as long as the widest window the page offers. */
export const KEEP_RESOLVED_SEC = WINDOWS["30d"].rangeSeconds;
/** Hard cap on history, oldest dropped first. */
export const MAX_HISTORY = 500;

/** What one detection cycle found for one problem. */
export interface Sighting {
  key: string;
  issue: FormulatedIssue;
  print: string;
  /** Earliest first-seen across its findings — when the problem began, as far as the window shows. */
  firstSeenUnix: number | null;
}

/**
 * The log's lifecycle, with no I/O in it. `current` holds open issues and
 * ones resolved within the reopen grace; past the grace they move to
 * `history` and are never reopened — a problem back after that is new.
 */
export class IssueLog {
  readonly current = new Map<string, IssueRecord>();
  history: IssueRecord[] = [];

  advance(seen: Sighting[], now: number): void {
    const found = new Set(seen.map((s) => s.key));
    for (const s of seen) {
      const rec = this.current.get(s.key);
      if (rec) {
        // Same problem, still failing (or back within the grace): update it.
        if (rec.issue.severity !== s.issue.severity) rec.severitySinceUnix = now;
        rec.issue = s.issue;
        rec.print = s.print;
        rec.updatedAtUnix = now;
        rec.resolvedAtUnix = null;
      } else {
        const opened = Math.min(now, s.firstSeenUnix ?? now);
        this.current.set(s.key, {
          id: `${s.key}:${opened}`,
          key: s.key,
          openedAtUnix: opened,
          updatedAtUnix: now,
          resolvedAtUnix: null,
          severitySinceUnix: opened,
          print: s.print,
          issue: s.issue,
        });
      }
    }
    for (const [key, rec] of this.current) {
      if (found.has(key)) continue;
      // Resolved at the last failure seen — not at "now", which is when a
      // cycle noticed, up to a whole window later.
      rec.resolvedAtUnix ??= Math.min(now, rec.issue.lastSeenUnix ?? rec.updatedAtUnix);
      rec.issue = { ...rec.issue, ongoing: false };
      if (now - rec.updatedAtUnix > REOPEN_GRACE_SEC) {
        this.history.push(rec);
        this.current.delete(key);
      }
    }
    this.history = this.history
      .filter((r) => now - (r.resolvedAtUnix ?? now) <= KEEP_RESOLVED_SEC)
      .slice(-MAX_HISTORY);
  }

  /** Issues active at any point in the last `rangeSeconds`: open ones, and ones resolved inside it. */
  view(rangeSeconds: number, now: number): ServedIssue[] {
    const from = now - rangeSeconds;
    return [...this.current.values(), ...this.history]
      .filter((r) => r.resolvedAtUnix == null || r.resolvedAtUnix >= from)
      .map((r) => ({
        ...r.issue,
        id: r.id,
        status: r.resolvedAtUnix == null ? ("open" as const) : ("resolved" as const),
        openedAtUnix: r.openedAtUnix,
        updatedAtUnix: r.updatedAtUnix,
        resolvedAtUnix: r.resolvedAtUnix,
        severitySinceUnix: r.severitySinceUnix,
      }));
  }

  toJSON(): { current: IssueRecord[]; history: IssueRecord[] } {
    return { current: [...this.current.values()], history: this.history };
  }

  static from(raw: unknown): IssueLog {
    const log = new IssueLog();
    const r = raw as { current?: IssueRecord[]; history?: IssueRecord[] } | null;
    for (const rec of Array.isArray(r?.current) ? r.current : []) {
      if (rec && typeof rec.key === "string" && rec.issue) log.current.set(rec.key, rec);
    }
    log.history = (Array.isArray(r?.history) ? r.history : []).filter((x) => x && x.issue);
    return log;
  }
}

export interface IssuesFeedOptions {
  /** Optional so a deployment without it still writes issues, minus outcomes. */
  prom?: Pick<PrometheusClient, "query">;
  loki?: LokiService;
  /** Where to keep the log between restarts; unset = memory only. */
  stateFile?: string;
}

export class IssuesFeedService {
  private readonly log: IssueLog;
  private lastCycle: Omit<IssuesSnapshot, "window" | "issues"> | null = null;
  private running = false;
  private readonly prom?: Pick<PrometheusClient, "query">;
  private readonly loki: LokiService;
  private readonly stateFile?: string;

  constructor(
    private readonly detail: MetricsDetailService,
    private readonly configSvc?: ConfigurationService,
    private readonly logger?: BedrockLogger,
    opts: IssuesFeedOptions = {},
  ) {
    this.prom = opts.prom;
    this.loki = opts.loki ?? new LokiService();
    this.stateFile = opts.stateFile;
    this.log = this.load();
  }

  /**
   * The issues active in `window`, from the log — instant, no model call.
   * Null until the first cycle has finished (or a saved log was loaded).
   */
  view(window: MetricWindow, now = Math.floor(Date.now() / 1000)): IssuesSnapshot | null {
    if (!this.lastCycle) return null;
    return { window, ...this.lastCycle, issues: this.log.view(WINDOWS[window].rangeSeconds, now) };
  }

  /** True while a cycle is running, so a route can say "working" not "off". */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * One detection cycle on the live window. Updates the log; never called
   * because someone changed the page's window.
   */
  // 20, not 8: eleven chains had findings and only eight were written, so
  // three were missing from the page with nothing saying so. A cap exists to
  // stop a pathological deployment, not to quietly truncate a normal one.
  async refresh(limit = 20): Promise<void> {
    if (this.running) return;
    // Checked here, not at the route: an unconfigured deployment must not run
    // a model loop it was never allowed to run.
    if (!bedrockGate(process.env.AUTH_MODE ?? config.auth.mode).ok) return;
    this.running = true;
    try {
      const window = DEFAULT_WINDOW;
      const report = await this.detail.status(window);
      const routers = this.configSvc?.getRouters() ?? [];
      // Customer failures per chain, once per request, from the router's own
      // final-result log. Without the log store they stay unmeasured.
      const logs = this.loki.available
        ? await readLogs(this.loki, WINDOWS[window].rangeSeconds, routers).catch((err) => {
            this.logger?.warn({ error: err instanceof Error ? err.message : String(err) }, "could not read the router's logs");
            return null;
          })
        : null;
      // Read once for every chain. A failure here costs the outcome sentence,
      // never the issues themselves.
      const unmeasured: ChainOutcome = { recovered: null, failures: null, requests: null, addonCalls: [], writes: null, paths: null };
      const outcomeOf = this.prom
        ? await outcomesBySpec(this.prom, window, logs).catch((err) => {
            this.logger?.warn(
              { window, error: err instanceof Error ? err.message : String(err) },
              "could not read the retry outcome",
            );
            return () => unmeasured;
          })
        : () => unmeasured;

      const bySpec = new Map<string, StatusFinding[]>();
      for (const f of report.findings) {
        const list = bySpec.get(f.spec) ?? [];
        list.push(f);
        bySpec.set(f.spec, list);
      }
      // A burst of failed customer requests is a problem whether or not a
      // 30-minute rule noticed it: a six-minute spike on eleven chains can
      // stay under every rate threshold. It opens the chain's issue, or joins
      // the one already there — this is what the Live incidents tab was for.
      const cycleNow = Math.floor(Date.now() / 1000);
      for (const [spec, b] of logs?.bursts ?? []) {
        const list = bySpec.get(spec) ?? [];
        list.push(burstFinding(spec, list[0]?.chainName ?? buildChainMetaByIndex(spec).name, b, cycleNow));
        bySpec.set(spec, list);
      }

      const rank = { critical: 0, degraded: 1, config: 2 } as const;
      // Severity reads the outcome everywhere it is decided — the ranking, the
      // caller-side fold and the card — or the three could disagree.
      const sev = (spec: string, f: StatusFinding[]) => severityOf(f, outcomeOf(spec));
      const ranked = [...bySpec.entries()].sort(
        (a, b) => rank[sev(a[0], a[1])] - rank[sev(b[0], b[1])] || b[1].length - a[1].length,
      );

      // Caller-side chains fold into ONE issue. Nonce and funds rejections are
      // the client's own doing, so they recur identically wherever that client
      // sends transactions — three cards saying "your nonces are stale" about
      // three chains is one problem rendered three times. Its key is fixed, so
      // it stays one issue as chains join and leave it.
      type Group = { key: string; spec: string; findings: StatusFinding[]; alsoOnChains: { spec: string; chain: string; findings: StatusFinding[] }[] };
      const callerSide = ranked.filter(([spec, f]) => sev(spec, f) === "config");
      const groups: Group[] = ranked
        .filter(([spec, f]) => sev(spec, f) !== "config")
        .slice(0, limit)
        .map(([spec, findings]) => ({ key: spec, spec, findings, alsoOnChains: [] }));
      if (callerSide.length > 0) {
        const [leadSpec, leadFindings] = callerSide[0]!;
        groups.push({
          key: "callers",
          spec: leadSpec,
          findings: leadFindings,
          alsoOnChains: callerSide.slice(1).map(([spec, findings]) => ({
            spec,
            chain: findings[0]?.chainName ?? spec,
            findings,
          })),
        });
      }

      const svc = new FormulatedIssueService(new BedrockService(config.bedrock.model, this.logger), this.logger);

      const seen: Sighting[] = [];
      for (const g of groups) {
        const all = [...g.findings, ...g.alsoOnChains.flatMap((c) => c.findings)];
        const chainInsights = report.insights.filter((x) => x.spec === g.spec);
        const outcome = g.alsoOnChains.length
          ? sumOutcomes([outcomeOf(g.spec), ...g.alsoOnChains.map((c) => outcomeOf(c.spec))])
          : outcomeOf(g.spec);
        const print = fingerprint(all, chainInsights, outcome, severityOf(g.findings, outcome));
        const configured = routers
          .filter((r) => r.spec === g.spec)
          .flatMap((r) =>
            r.nodes.map((n) => ({
              upstream: n.name,
              role: (n.isBackup ? "backup" : "primary") as "primary" | "backup",
              addons: [...new Set(n.endpoints.flatMap((e) => e.addons ?? []))],
            })),
          );
        const inputs = {
          spec: g.spec,
          chain: g.findings[0]?.chainName ?? g.spec,
          findings: g.findings,
          errorGroups: [] as ReturnType<typeof groupErrors>,
          configured,
          insights: chainInsights,
          alsoOnChains: g.alsoOnChains,
          ...outcome,
        };
        const firstSeenUnix = all.reduce<number | null>(
          (min, f) => (f.firstSeenUnix != null && (min == null || f.firstSeenUnix < min) ? f.firstSeenUnix : min),
          null,
        );
        const rec = this.log.current.get(g.key);

        if (rec && rec.print === print) {
          // Same facts: keep the words, refresh the numbers. Rewording an
          // unchanged story only makes a steady card look unsteady.
          seen.push({ key: g.key, print, firstSeenUnix, issue: { ...rec.issue, ...measuredFields(inputs) } });
          continue;
        }

        const lines = this.loki.available ? await this.loki.recentErrors(g.spec, undefined, 150).catch(() => []) : [];
        try {
          const issue = await svc.formulate({
            ...inputs,
            errorGroups: groupErrors(lines, 6),
            // The version on screen, so the rewrite is an update of it.
            ...(rec ? { previous: { title: rec.issue.title, points: rec.issue.points, bottomLine: rec.issue.bottomLine } } : {}),
          });
          seen.push({ key: g.key, print, firstSeenUnix, issue });
        } catch (err) {
          this.logger?.warn(
            { spec: g.spec, error: err instanceof Error ? err.message : String(err) },
            "could not formulate an issue",
          );
          // An open issue the model could not rewrite is still open: keep its
          // words, refresh its numbers, and try the words again next cycle.
          // Dropping it would mark a still-failing problem resolved.
          if (rec) seen.push({ key: g.key, print: rec.print, firstSeenUnix, issue: { ...rec.issue, ...measuredFields(inputs) } });
        }
      }

      const now = Math.floor(Date.now() / 1000);
      this.log.advance(seen, now);
      this.lastCycle = {
        computedAtUnix: report.computedAtUnix,
        logsAvailable: this.loki.available,
        configAvailable: routers.length > 0,
      };
      await this.save();
    } finally {
      this.running = false;
    }
  }

  private load(): IssueLog {
    if (!this.stateFile) return new IssueLog();
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, "utf8")) as {
        log?: unknown;
        lastCycle?: IssuesFeedService["lastCycle"];
      };
      this.lastCycle = saved.lastCycle ?? null;
      return IssueLog.from(saved.log);
    } catch (err) {
      // A missing file is the first boot; anything else is worth a line.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.logger?.warn({ file: this.stateFile, error: String(err) }, "could not read the issue log; starting empty");
      }
      return new IssueLog();
    }
  }

  private async save(): Promise<void> {
    if (!this.stateFile) return;
    // Write-then-rename, so a crash mid-write leaves the previous log intact
    // rather than half a JSON file the next boot cannot read.
    const tmp = `${this.stateFile}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ log: this.log, lastCycle: this.lastCycle }));
      await rename(tmp, this.stateFile);
    } catch (err) {
      this.logger?.warn({ file: this.stateFile, error: String(err) }, "could not save the issue log");
    }
  }
}
