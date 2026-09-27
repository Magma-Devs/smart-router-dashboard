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
import type { RouterNode, RouterTopology } from "@sr/shared";
import type { PrometheusClient } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import type { MetricsDetailService } from "./metrics-detail.js";
import {
  FormulatedIssueService,
  severityOf,
  measuredFields,
  plainIssue,
  type AddonCalls,
  type ChainOutcome,
  type FailurePath,
  type FailurePaths,
  type RefusedRequests,
  type WriteCalls,
  type FormulatedIssue,
  type IssueSeverity,
} from "./formulated-issues.js";
import { LokiService, flowOf, groupErrors, type FailedRequest, type Rejection, type RequestTrace } from "./loki.js";
import { BedrockService, bedrockGate, type BedrockLogger } from "./bedrock.js";
import { config } from "../config.js";
import { providerName } from "./provider-names.js";
import { criticalChanges, postAlerts } from "./issue-alerts.js";

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
  /** One point per cycle that found it, oldest first. */
  timeline: TimelinePoint[];
}

/** An issue's numbers at one cycle: its failures, saves and refusals in that cycle's window. */
export interface TimelinePoint {
  t: number;
  failed: number | null;
  saved: number | null;
  refused: number | null;
}

/** A day of five-minute cycles. */
const MAX_TIMELINE = 288;

/** A chain that works now and has nothing to fall back on — a card for before something fails. */
export interface Risk {
  spec: string;
  chain: string;
  /** One sentence, written by code. */
  text: string;
  /** Calls in the last window that depend on it, and what they are. */
  calls: number | null;
  unit: "requests" | "debug calls" | "trace calls";
}

export interface IssuesSnapshot {
  window: MetricWindow;
  /** When the last detection cycle finished. */
  computedAtUnix: number;
  logsAvailable: boolean;
  configAvailable: boolean;
  issues: ServedIssue[];
  risks: Risk[];
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
 * Bumped when the words must change, so every saved issue is rewritten once.
 * 2: failures come from the final-result log, once per customer request —
 * words written from the old per-attempt counter overstated them.
 * 3: the card prints the chain's numbers itself, with their time; words
 * written before repeat them, and carry time words ("this week", "last time")
 * that were never true of a 30-minute count.
 */
const PRINT_VERSION = 3;

/** The print of an issue written without the model: never a real fingerprint, so the next cycle writes it. */
const UNWRITTEN = "unwritten";

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
    // The MAIN way requests fail, without its count or its times: the backup
    // starting to fail too is news, one more request down the same path is
    // not. Only the first path — the traced sample is the newest few, so the
    // rare paths behind it come and go each cycle and would re-word an
    // unchanged story.
    ...(outcome?.paths?.groups[0] ? [`p:${outcome.paths.groups[0].route}`] : []),
    // Whether the refused transactions are mostly the same ones sent again:
    // the cause the caller card states, so a change of it is news.
    ...(outcome?.rejected?.resent
      ? [`r:${outcome.rejected.resent.resent * 2 >= outcome.rejected.resent.checked ? "resent" : "new"}`]
      : []),
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

const num = (n: number) => n.toLocaleString("en-US");

/** Several chains failing inside the same five minutes. */
export interface Together {
  specs: string[];
  fromUnix: number;
  toUnix: number;
  /** The provider the traced requests failed on, on every one of these chains. */
  provider: string | null;
  /** The chains share no configured provider, so one provider failing cannot explain it. */
  shareNone: boolean;
}

/** Fewer chains than this failing at once is ordinary bad luck, not a pattern. */
export const TOGETHER_MIN = 3;

/**
 * Chains whose worst five minutes overlap. One provider failing takes down
 * the chains it serves; chains that share NO provider failing at the same
 * moment points at what they do share — the router. So the attribution is
 * read, never assumed: the provider every chain's traced requests failed on,
 * when there is one; "share no provider" only when the config says so.
 */
export function failingTogether(
  bursts: Map<string, Burst>,
  paths: Map<string, FailurePaths>,
  configured: Map<string, Set<string>>,
  min = TOGETHER_MIN,
): Together | null {
  const spans = [...bursts].map(([spec, b]) => ({ spec, from: b.fromUnix, to: b.toUnix }));
  // The moment most bursts cover: every burst's start is a candidate.
  let most: typeof spans = [];
  for (const a of spans) {
    const at = spans.filter((b) => b.from <= a.from && a.from <= b.to);
    if (at.length > most.length) most = at;
  }
  if (most.length < min) return null;
  const specs = most.map((b) => b.spec).sort();
  const failedOn = specs.map((spec) => new Set((paths.get(spec)?.groups ?? []).flatMap((g) => g.failedOn)));
  const common = failedOn.every((set) => set.size > 0) ? [...failedOn[0]!].filter((p) => failedOn.every((set) => set.has(p))) : [];
  const sets = specs.map((spec) => configured.get(spec) ?? new Set<string>());
  const shareNone = sets.every((set) => set.size > 0) && ![...sets[0]!].some((p) => sets.every((set) => set.has(p)));
  return {
    specs,
    fromUnix: Math.min(...most.map((b) => b.from)),
    toUnix: Math.max(...most.map((b) => b.to)),
    provider: common.sort()[0] ?? null,
    shareNone,
  };
}

/** The several-chains card — written by code: a pattern this exact reads better as a fact than as prose. */
export function togetherIssue(
  t: Together,
  bursts: Map<string, Burst>,
  chainName: (spec: string) => string,
  critical: boolean,
  now: number,
): FormulatedIssue {
  const names = t.specs.map(chainName);
  const total = t.specs.reduce((a, spec) => a + (bursts.get(spec)?.count ?? 0), 0);
  const listed = names.length <= 4 ? names.join(", ") : `${names.slice(0, 4).join(", ")} and ${names.length - 4} more`;
  const lastUnix = Math.max(...t.specs.map((spec) => bursts.get(spec)?.lastUnix ?? 0));
  const cause = t.provider ? `all on ${providerName(t.provider)}` : t.shareNone ? "likely the Smart Router" : null;
  return {
    severity: critical ? "critical" : "degraded",
    spec: t.specs[0]!,
    chain: `${t.specs.length} chains`,
    specs: t.specs,
    title: `${t.specs.length} chains failed at the same time${cause ? ` — ${cause}` : ""}`,
    points: [
      t.provider
        ? `On every one of these chains, the failed requests failed on ${providerName(t.provider)}.`
        : t.shareNone
          ? "These chains share no provider, so one provider failing cannot explain it."
          : "They share a provider, but the failed requests did not all fail on it.",
      ...t.specs.slice(0, 3).map((spec) => `${chainName(spec)}: ${num(bursts.get(spec)?.count ?? 0)} failed in its worst five minutes.`),
    ],
    bottomLine: "",
    ongoing: now - lastUnix < BURST_WINDOW_SEC,
    findingIds: t.specs.map((spec) => `${spec}:burst`),
    lastSeenUnix: lastUnix,
    outcome: { recovered: null, failures: total, requests: null, addonCalls: [], writes: null, paths: null, rejected: null },
    impact: `${num(total)} requests failed on ${t.specs.length} chains within the same few minutes: ${listed}.`,
    measured: { fromUnix: t.fromUnix, toUnix: t.toUnix },
    handled: false,
    whoActs: t.provider
      ? `${providerName(t.provider)} (the provider) — requests failed on it on every one of these chains.`
      : "Magma — chains failing together point at the router first.",
    codes: [],
    together: true,
  };
}

/**
 * Where one provider stands between a chain and failure: the chain has one
 * provider at all, or only one serves the debug (or trace) calls it gets.
 * Nothing is failing — this says so before something does.
 *
 * Only what the config and the router's own code settle: the router filters
 * backups by add-on like everyone else, so a debug call can only go to a
 * provider that declares debug. A chain with an open issue is left out; the
 * issue says it.
 */
export function risksOf(
  routers: RouterTopology[],
  outcomeOf: (spec: string) => ChainOutcome,
  chainName: (spec: string) => string,
  skip: Set<string>,
): Risk[] {
  const nodesBySpec = new Map<string, Map<string, RouterNode>>();
  for (const r of routers) {
    const nodes = nodesBySpec.get(r.spec) ?? new Map<string, RouterNode>();
    for (const n of r.nodes) if (!nodes.has(n.name)) nodes.set(n.name, n);
    nodesBySpec.set(r.spec, nodes);
  }
  const out: Risk[] = [];
  for (const [spec, byName] of nodesBySpec) {
    if (skip.has(spec)) continue;
    const nodes = [...byName.values()];
    const o = outcomeOf(spec);
    const chain = chainName(spec);
    if (nodes.length === 1) {
      if ((o.requests ?? 0) > 0) {
        out.push({
          spec,
          chain,
          calls: o.requests,
          unit: "requests",
          text: `${chain} has one provider, ${providerName(nodes[0]!.name)}. If it stops answering, the chain stops.`,
        });
      }
      continue;
    }
    for (const addon of ["debug", "trace"] as const) {
      const serving = nodes.filter((n) => n.endpoints.some((e) => e.addons.includes(addon)));
      const sent = o.addonCalls.find((a) => a.addon === addon)?.sent ?? 0;
      if (serving.length === 1 && sent > 0) {
        out.push({
          spec,
          chain,
          calls: sent,
          unit: `${addon} calls`,
          text: `Only ${providerName(serving[0]!.name)} serves ${addon} calls on ${chain}. If it fails, those calls have nowhere to go.`,
        });
      }
    }
  }
  return out.sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0));
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
  /** What the chain refused, per request, per chain. */
  rejections: Map<string, RefusedRequests>;
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
  loki: Pick<
    LokiService,
    "routersWithLogs" | "failedRequests" | "countFailed" | "methodsOf" | "traceRequests" | "rejectedRequests" | "resentTransactions"
  > &
    Partial<Pick<LokiService, "knowRouters">>,
  rangeSec: number,
  routers: { id: string; spec: string }[],
  now = Math.floor(Date.now() / 1000),
): Promise<LogOutcome | null> {
  // So a stream's label value — a pod, or `<cluster>-<router id>` on a shared
  // store — is read as the router the config declares.
  loki.knowRouters?.(routers.map((r) => r.id));
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

  // What the chain refused, once per request — and whether the refused
  // transactions had been sent before. A failed read costs the caller card
  // its per-request count (it falls back to the counter's), never the card.
  const rejections = new Map<string, RefusedRequests>();
  const refused = await loki.rejectedRequests(rangeSec, 5000, now).catch(() => null);
  const refusedBySpec = new Map<string, Rejection[]>();
  for (const [router, list] of refused?.byRouter ?? []) {
    const spec = specOf.get(router);
    if (spec) refusedBySpec.set(spec, [...(refusedBySpec.get(spec) ?? []), ...list]);
  }
  await Promise.all(
    [...refusedBySpec].map(async ([spec, list]) => {
      const byCode: Record<string, number> = {};
      for (const r of list) byCode[r.code] = (byCode[r.code] ?? 0) + 1;
      const resent = await loki.resentTransactions(list, 3).catch(() => null);
      rejections.set(spec, {
        requests: list.length,
        byCode,
        resent: resent && resent.checked > 0 ? resent : null,
        latest: [...list]
          .sort((a, b) => b.atUnix - a.atUnix)
          .slice(0, 3)
          .map((r) => ({ id: r.id, atUnix: r.atUnix })),
      });
    }),
  );
  return { failed, failedMethods, bursts, paths, rejections };
}

/**
 * Traced requests grouped by the way they went, most common first. Six that
 * each went "alchemy ✕ timed out → quicknode (backup) ✕ timed out → failed"
 * are one path of six — not "3 on one provider and 2 on another", which
 * reads as different requests.
 *
 * Grouped on the route WITHOUT its times: the router adds backups on a fixed
 * step, but one request's "+7s" is another's "+8s", and those are the same
 * path. The line shown carries each step's median time across the group.
 *
 * A trace with no provider on it is left out: its lines were not all read,
 * and a path with a gap in it would state something false.
 */
export function groupTraces(traces: RequestTrace[]): FailurePaths | null {
  const byRoute = new Map<string, RequestTrace[]>();
  for (const t of traces) {
    if (t.attempts.length === 0) continue;
    const route = flowOf(t, { times: false });
    byRoute.set(route, [...(byRoute.get(route) ?? []), t]);
  }
  if (byRoute.size === 0) return null;
  const groups = [...byRoute].map(([route, list]): FailurePath => {
    // Same route means the same steps, so step i lines up across the list.
    const typical: RequestTrace = {
      ...list[0]!,
      attempts: list[0]!.attempts.map((a, i) => ({
        ...a,
        startSec: median(list.map((t) => t.attempts[i]?.startSec).filter((n): n is number => n != null)),
      })),
    };
    const methods = new Map<string, number>();
    for (const t of list) methods.set(t.method, (methods.get(t.method) ?? 0) + 1);
    const secs = list.map((t) => t.seconds);
    return {
      count: list.length,
      flow: flowOf(typical),
      route,
      methods: [...methods].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m),
      seconds: [Math.min(...secs), Math.max(...secs)],
      // In the order they were tried: the first is where the request started failing.
      failedOn: [...new Set(list.flatMap((t) => t.attempts.filter((a) => a.outcome !== "answered").map((a) => a.provider)))],
      ids: newestIds(list.map((t) => ({ id: t.id, atUnix: t.atUnix }))),
      errors: [...new Set(list.map((t) => t.error).filter((e): e is string => e != null))],
    };
  });
  return { traced: groups.reduce((a, g) => a + g.count, 0), groups: sortPaths(groups) };
}

/** The newest three — what a support engineer matches against a caller's own log. */
function newestIds(ids: { id: string; atUnix: number }[]): { id: string; atUnix: number }[] {
  return [...ids].sort((a, b) => b.atUnix - a.atUnix).slice(0, 3);
}

/** The middle value — the lower one of two — or null for none. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** Most requests first; the route breaks a tie, so the order — and the fingerprint — is stable. */
function sortPaths(groups: FailurePath[]): FailurePath[] {
  return groups.sort((a, b) => b.count - a.count || a.route.localeCompare(b.route));
}

/** Several chains' paths as one — for an issue that covers more than one chain. */
export function mergePaths(list: (FailurePaths | null)[]): FailurePaths | null {
  const all = list.filter((p): p is FailurePaths => p != null);
  if (all.length === 0) return null;
  const byRoute = new Map<string, FailurePath>();
  for (const g of all.flatMap((p) => p.groups)) {
    const same = byRoute.get(g.route);
    byRoute.set(
      g.route,
      same
        ? {
            ...same,
            count: same.count + g.count,
            methods: [...new Set([...same.methods, ...g.methods])],
            seconds: [Math.min(same.seconds[0], g.seconds[0]), Math.max(same.seconds[1], g.seconds[1])],
            failedOn: [...new Set([...same.failedOn, ...g.failedOn])],
            ids: newestIds([...same.ids, ...g.ids]),
            errors: [...new Set([...same.errors, ...g.errors])],
          }
        : { ...g, methods: [...g.methods] },
    );
  }
  return { traced: all.reduce((a, p) => a + p.traced, 0), groups: sortPaths([...byRoute.values()]) };
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
      rejected: logs?.rejections.get(spec) ?? null,
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
    rejected: mergeRefused(list.map((o) => o.rejected)),
    writes: writes.length
      ? {
          sent: writes.reduce((a, w) => a + w.sent, 0),
          failed: writes.some((w) => w.failed == null) ? null : writes.reduce((a, w) => a + (w.failed ?? 0), 0),
        }
      : null,
  };
}

/** Several chains' refusals as one — for the caller-side card that covers them. */
export function mergeRefused(list: (RefusedRequests | null)[]): RefusedRequests | null {
  const all = list.filter((r): r is RefusedRequests => r != null);
  if (all.length === 0) return null;
  const byCode: Record<string, number> = {};
  for (const r of all) for (const [code, n] of Object.entries(r.byCode)) byCode[code] = (byCode[code] ?? 0) + n;
  const checks = all.map((r) => r.resent).filter((x): x is NonNullable<RefusedRequests["resent"]> => x != null);
  return {
    requests: all.reduce((a, r) => a + r.requests, 0),
    byCode,
    resent: checks.length
      ? {
          checked: checks.reduce((a, c) => a + c.checked, 0),
          resent: checks.reduce((a, c) => a + c.resent, 0),
          mostSends: Math.max(...checks.map((c) => c.mostSends)),
        }
      : null,
    latest: newestIds(all.flatMap((r) => r.latest)),
  };
}

/** One problem's record, kept across cycles. */
export interface IssueRecord {
  id: string;
  /** The chain's spec, "callers" for the merged caller-side issue, "together" for several chains failing at once. */
  key: string;
  openedAtUnix: number;
  updatedAtUnix: number;
  resolvedAtUnix: number | null;
  severitySinceUnix: number;
  /** The fingerprint the words were written for. */
  print: string;
  issue: FormulatedIssue;
  timeline?: TimelinePoint[];
}

function pointOf(issue: FormulatedIssue, t: number): TimelinePoint {
  return { t, failed: issue.outcome.failures, saved: issue.outcome.recovered, refused: issue.outcome.rejected?.requests ?? null };
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
        rec.timeline = [...(rec.timeline ?? []), pointOf(s.issue, now)].slice(-MAX_TIMELINE);
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
          timeline: [pointOf(s.issue, now)],
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
        timeline: r.timeline ?? [],
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
  /**
   * Writes an issue's words. Unset = the model, and only where the model is
   * allowed to run; tests pass their own.
   */
  writer?: Pick<FormulatedIssueService, "formulate">;
  /** Where Critical issues are posted. Unset = `ISSUES_WEBHOOK_URL`, and no alerts without it. */
  alerts?: { url?: string; dashboardUrl?: string };
}

export class IssuesFeedService {
  private readonly log: IssueLog;
  private lastCycle: Omit<IssuesSnapshot, "window" | "issues"> | null = null;
  private running = false;
  private readonly prom?: Pick<PrometheusClient, "query">;
  private readonly loki: LokiService;
  private readonly stateFile?: string;
  private readonly writer?: Pick<FormulatedIssueService, "formulate">;
  private readonly alerts: { url?: string; dashboardUrl?: string };

  constructor(
    private readonly detail: MetricsDetailService,
    private readonly configSvc?: ConfigurationService,
    private readonly logger?: BedrockLogger,
    opts: IssuesFeedOptions = {},
  ) {
    this.prom = opts.prom;
    this.loki = opts.loki ?? new LokiService();
    this.stateFile = opts.stateFile;
    this.writer = opts.writer;
    this.alerts = opts.alerts ?? { url: config.issues.webhookUrl, dashboardUrl: config.issues.dashboardUrl };
    this.log = this.load();
  }

  /**
   * The issues active in `window`, from the log — instant, no model call.
   * Null until the first cycle has finished (or a saved log was loaded).
   */
  view(window: MetricWindow, now = Math.floor(Date.now() / 1000)): IssuesSnapshot | null {
    if (!this.lastCycle) return null;
    // A log saved before risks existed has none — an empty list, not a crash.
    return { window, ...this.lastCycle, risks: this.lastCycle.risks ?? [], issues: this.log.view(WINDOWS[window].rangeSeconds, now) };
  }

  /** True while a cycle is running, so a route can say "working" not "off". */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * One detection cycle on the live window. Updates the log; never called
   * because someone changed the page's window.
   *
   * `limit` caps the MODEL — how many issues it writes in one cycle — and
   * nothing else. Every chain with a problem is on the page: past the cap an
   * open issue keeps its words with fresh numbers, and a new one gets a card
   * written from its numbers until a later cycle writes it. The cap used to
   * cut detection itself at 20 chains, and an open issue that goes unseen is
   * RESOLVED — so in an outage past 20 failing chains, the page said
   * "resolved" about chains that were still down.
   */
  async refresh(limit = 20): Promise<void> {
    if (this.running) return;
    // Checked here, not at the route: an unconfigured deployment must not run
    // a model loop it was never allowed to run.
    if (!this.writer && !bedrockGate(process.env.AUTH_MODE ?? config.auth.mode).ok) return;
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
      const unmeasured: ChainOutcome = { recovered: null, failures: null, requests: null, addonCalls: [], writes: null, paths: null, rejected: null };
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

      const chainNameOf = (spec: string) => bySpec.get(spec)?.[0]?.chainName ?? buildChainMetaByIndex(spec).name;
      const svc = this.writer ?? new FormulatedIssueService(new BedrockService(config.bedrock.model, this.logger), this.logger);
      // The time every number below covers — printed on each card beside them.
      const measured = { fromUnix: report.computedAtUnix - WINDOWS[window].rangeSeconds, toUnix: report.computedAtUnix };

      const seen: Sighting[] = [];
      let written = 0;
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
          measured,
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
        // Not written this cycle — the budget ran out, or the model failed.
        // The chain is still failing, so it stays on the page: an open issue
        // keeps its words with fresh numbers, a new one is written from its
        // numbers. Either keeps a print that cannot match, so the next cycle
        // writes it properly.
        const unwritten = (): Sighting =>
          rec
            ? { key: g.key, print: rec.print, firstSeenUnix, issue: { ...rec.issue, ...measuredFields(inputs) } }
            : { key: g.key, print: UNWRITTEN, firstSeenUnix, issue: plainIssue(inputs) };
        if (written >= limit) {
          seen.push(unwritten());
          continue;
        }
        written++;

        const lines = this.loki.available ? await this.loki.recentErrors(g.spec, undefined, 150).catch(() => []) : [];
        // Words from before a rules change are not a version to update: the
        // model keeps an on-screen title for continuity, even one the new
        // rules forbid. Written under these rules → update; older → fresh.
        const sameRules = rec?.print.split("~").includes(`v${PRINT_VERSION}`) ?? false;
        try {
          const issue = await svc.formulate({
            ...inputs,
            errorGroups: groupErrors(lines, 6),
            // The version on screen, so the rewrite is an update of it.
            ...(rec && sameRules ? { previous: { title: rec.issue.title, points: rec.issue.points, bottomLine: rec.issue.bottomLine } } : {}),
          });
          seen.push({ key: g.key, print, firstSeenUnix, issue });
        } catch (err) {
          this.logger?.warn(
            { spec: g.spec, error: err instanceof Error ? err.message : String(err) },
            "could not formulate an issue",
          );
          // Dropping it would mark a still-failing problem resolved — or, for
          // a new one, leave a failing chain off the page.
          seen.push(unwritten());
        }
      }

      // Several chains failing in the same five minutes is its own card, on
      // top of each chain's own — written by code, whatever the budget.
      const configured = new Map<string, Set<string>>();
      for (const r of routers) configured.set(r.spec, new Set([...(configured.get(r.spec) ?? []), ...r.nodes.map((n) => n.name)]));
      const together = logs ? failingTogether(logs.bursts, logs.paths, configured) : null;
      if (together && logs) {
        seen.push({
          key: "together",
          print: `together~${together.specs.join(",")}~${together.provider ?? (together.shareNone ? "none" : "shared")}`,
          firstSeenUnix: together.fromUnix,
          issue: togetherIssue(
            together,
            logs.bursts,
            chainNameOf,
            together.specs.some((spec) => sev(spec, bySpec.get(spec) ?? []) === "critical"),
            cycleNow,
          ),
        });
      }

      const now = Math.floor(Date.now() / 1000);
      // Everything, resolved included — what an alert compares against.
      const everything = 400 * 86_400;
      const before = this.log.view(everything, now);
      this.log.advance(seen, now);
      const alerts = this.alerts.url ? criticalChanges(before, this.log.view(everything, now)) : [];
      this.lastCycle = {
        computedAtUnix: report.computedAtUnix,
        logsAvailable: this.loki.available,
        configAvailable: routers.length > 0,
        risks: risksOf(
          routers,
          outcomeOf,
          chainNameOf,
          new Set(groups.flatMap((g) => [g.spec, ...g.alsoOnChains.map((c) => c.spec)])),
        ),
      };
      await this.save();
      if (alerts.length > 0) {
        await postAlerts(this.alerts.url!, alerts, { dashboardUrl: this.alerts.dashboardUrl, logger: this.logger });
      }
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
