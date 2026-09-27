/**
 * The written issues, computed in the background so the page opens on them.
 *
 * Formulating three chains takes ~68s against a live deployment, nearly all of
 * it the Prometheus read. Nobody waits that long, and asking them to press a
 * button first is asking them to start the wait themselves — the page already
 * knows which chains have issues the moment it loads, so there is nothing for
 * a button to decide.
 *
 * ## Memoised per chain, on the findings behind it
 *
 * The key is a fingerprint of that chain's finding set — ids, tiers, and the
 * headline each carries. Unchanged findings reuse the sentence already
 * written; a changed set rewrites it.
 *
 * That matters more than the saved call. The model is not deterministic, so
 * recomputing an unchanged chain produces the same facts in different words
 * every cycle. A card that re-words itself while nothing is happening reads as
 * instability, and someone watching it learns to distrust it. Freezing the
 * wording until the findings move is what makes a change mean something.
 *
 * ## Keyed by window, warmed for the default
 *
 * Issues describe a window, so the cache is per window. The loop warms the
 * default one — what the page opens on. Another window is computed on first
 * ask and served warm afterwards, the same serve-last shape `metrics-cache`
 * already uses for every metrics read.
 */
import {
  DEFAULT_WINDOW,
  OPTIONAL_METRICS,
  ROUTER_METRICS,
  WINDOWS,
  qClientRequestsBy,
  type MetricWindow,
  type StatusFinding,
  type StatusInsight,
} from "@sr/shared";
import type { PrometheusClient } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import type { MetricsDetailService } from "./metrics-detail.js";
import {
  FormulatedIssueService,
  severityOf,
  type AddonCalls,
  type ChainOutcome,
  type FormulatedIssue,
  type IssueSeverity,
} from "./formulated-issues.js";
import { LokiService, groupErrors } from "./loki.js";
import { BedrockService, bedrockGate, type BedrockLogger } from "./bedrock.js";
import { config } from "../config.js";

export interface IssuesSnapshot {
  window: MetricWindow;
  computedAtUnix: number;
  logsAvailable: boolean;
  configAvailable: boolean;
  issues: FormulatedIssue[];
}

/** Order of magnitude — "?" unmeasured, "0" none, then 1e0 for 1-9, 1e1 for 10-99… */
function scale(n: number | null): string {
  if (n == null) return "?";
  // Zero gets its own token. A bare magnitude would give 1-9 "0" as well, and
  // none-to-some — the change that flips the badge — would not rewrite.
  return n <= 0 ? "0" : `1e${Math.floor(Math.log10(n))}`;
}

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
    ...(outcome ? [`o:${scale(outcome.failures)}:${scale(outcome.recovered)}`] : []),
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

export async function outcomesBySpec(
  prom: Pick<PrometheusClient, "query">,
  window: MetricWindow,
): Promise<(spec: string) => ChainOutcome> {
  const range = `${WINDOWS[window].rangeSeconds}s`;
  const [failed, saved, requested, addonSent, addonFailed] = await Promise.all([
    prom.query(`sum by (spec) (increase(${OPTIONAL_METRICS.requestsFailedTotal}[${range}]))`),
    prom.query(`sum by (spec) (increase(${OPTIONAL_METRICS.retriesSuccessTotal}[${range}]))`),
    // The client-side count the rest of the dashboard uses: one per customer
    // request, never the router's own probes.
    prom.query(qClientRequestsBy("spec", window)),
    // Sent from the client-side count; failed from the final-failure counter,
    // whose `method` label names the same call the histogram calls `function`.
    prom.query(addonQuery(ROUTER_METRICS.latencyCount, "function", range)),
    prom.query(addonQuery(OPTIONAL_METRICS.requestsFailedTotal, "method", range)),
  ]);
  const read = (rows: typeof failed) => {
    if (rows.length === 0) return (): number | null => null;
    const by = new Map(rows.map((r) => [r.metric.spec ?? "", Math.round(Number(r.value[1]) || 0)]));
    return (spec: string): number | null => by.get(spec) ?? 0;
  };
  const failures = read(failed);
  const recovered = read(saved);
  const requests = read(requested);

  const key = (r: (typeof failed)[number]) => `${r.metric.spec ?? ""}|${r.metric.addon ?? ""}`;
  const failedBy = new Map(addonFailed.map((r) => [key(r), Math.round(Number(r.value[1]) || 0)]));
  // Without the failure counter there is no verdict on these calls — the
  // counter being absent is not the same as nothing failing.
  const failuresMeasured = failed.length > 0;
  const addonCalls = (spec: string): AddonCalls[] =>
    addonSent
      .filter((r) => r.metric.spec === spec && (r.metric.addon === "debug" || r.metric.addon === "trace"))
      .map((r) => ({
        addon: r.metric.addon as AddonCalls["addon"],
        sent: Math.round(Number(r.value[1]) || 0),
        failed: failuresMeasured ? (failedBy.get(key(r)) ?? 0) : null,
      }))
      .filter((a) => a.sent > 0);

  return (spec) => ({
    recovered: recovered(spec),
    failures: failures(spec),
    requests: requests(spec),
    addonCalls: addonCalls(spec),
  });
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
        ? { addon: a.addon, sent: cur.sent + a.sent, failed: cur.failed == null || a.failed == null ? null : cur.failed + a.failed }
        : { ...a },
    );
  }
  return {
    recovered: add("recovered"),
    failures: add("failures"),
    requests: add("requests"),
    addonCalls: [...byAddon.values()],
  };
}

export class IssuesFeedService {
  private readonly snapshots = new Map<string, IssuesSnapshot>();
  /** Written issues by chain, with the fingerprint they were written for. */
  private readonly memo = new Map<string, { print: string; issue: FormulatedIssue }>();
  private readonly running = new Set<string>();

  constructor(
    private readonly detail: MetricsDetailService,
    private readonly configSvc?: ConfigurationService,
    private readonly logger?: BedrockLogger,
    /** Optional so a deployment without it still writes issues, minus outcomes. */
    private readonly prom?: Pick<PrometheusClient, "query">,
    private readonly loki: LokiService = new LokiService(),
  ) {}

  current(window: MetricWindow): IssuesSnapshot | null {
    return this.snapshots.get(window) ?? null;
  }

  /** True while a window is being computed, so a route can say "working" not "off". */
  isRunning(window: MetricWindow): boolean {
    return this.running.has(window);
  }

  // 20, not 8: eleven chains had findings and only eight were written, so
  // three were missing from the page with nothing saying so. A cap exists to
  // stop a pathological deployment, not to quietly truncate a normal one.
  async refresh(window: MetricWindow = DEFAULT_WINDOW, limit = 20): Promise<IssuesSnapshot | null> {
    if (this.running.has(window)) return this.snapshots.get(window) ?? null;
    // Checked here, not at the route: an unconfigured deployment must not run
    // a model loop it was never allowed to run.
    if (!bedrockGate(process.env.AUTH_MODE ?? config.auth.mode).ok) return null;
    this.running.add(window);
    try {
      const report = await this.detail.status(window);
      // Read once for every chain. A failure here costs the outcome sentence,
      // never the issues themselves.
      const unmeasured: ChainOutcome = { recovered: null, failures: null, requests: null, addonCalls: [] };
      const outcomeOf = this.prom
        ? await outcomesBySpec(this.prom, window).catch((err) => {
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
      // three chains is one problem rendered three times.
      const callerSide = ranked.filter(([spec, f]) => sev(spec, f) === "config");
      const rest = ranked.filter(([spec, f]) => sev(spec, f) !== "config");
      const chains: [string, StatusFinding[], { spec: string; chain: string; findings: StatusFinding[] }[]][] = [
        ...rest.slice(0, limit).map(([spec, f]) => [spec, f, []] as [string, StatusFinding[], never[]]),
      ];
      if (callerSide.length > 0) {
        const [leadSpec, leadFindings] = callerSide[0]!;
        chains.push([
          leadSpec,
          leadFindings,
          callerSide.slice(1).map(([spec, findings]) => ({
            spec,
            chain: findings[0]?.chainName ?? spec,
            findings,
          })),
        ]);
      }

      const routers = this.configSvc?.getRouters() ?? [];
      const svc = new FormulatedIssueService(new BedrockService(config.bedrock.model, this.logger), this.logger);

      const issues: FormulatedIssue[] = [];
      for (const [spec, findings, alsoOnChains] of chains) {
        const chainInsights = report.insights.filter((x) => x.spec === spec);
        const outcome = alsoOnChains.length
          ? sumOutcomes([outcomeOf(spec), ...alsoOnChains.map((c) => outcomeOf(c.spec))])
          : outcomeOf(spec);
        const print = fingerprint(
          [...findings, ...alsoOnChains.flatMap((c) => c.findings)],
          chainInsights,
          outcome,
          severityOf(findings, outcome),
        );
        const hit = this.memo.get(spec);
        if (hit && hit.print === print) {
          // Same findings, same sentence. Rewriting it would only change how
          // it reads, which is churn rather than news.
          issues.push(hit.issue);
          continue;
        }

        const lines = this.loki.available
          ? await this.loki.recentErrors(spec, undefined, 150).catch(() => [])
          : [];
        const configured = routers
          .filter((r) => r.spec === spec)
          .flatMap((r) =>
            r.nodes.map((n) => ({
              upstream: n.name,
              role: (n.isBackup ? "backup" : "primary") as "primary" | "backup",
              addons: [...new Set(n.endpoints.flatMap((e) => e.addons ?? []))],
            })),
          );

        try {
          const issue = await svc.formulate({
            spec,
            chain: findings[0]?.chainName ?? spec,
            findings,
            errorGroups: groupErrors(lines, 6),
            configured,
            insights: chainInsights,
            alsoOnChains,
            recovered: outcome.recovered,
            failures: outcome.failures,
            requests: outcome.requests,
            addonCalls: outcome.addonCalls,
          });
          this.memo.set(spec, { print, issue });
          issues.push(issue);
        } catch (err) {
          this.logger?.warn(
            { spec, error: err instanceof Error ? err.message : String(err) },
            "could not formulate an issue",
          );
          // Not memoised — a failure retries next cycle, unlike a sentence,
          // which should never be rewritten once it is right.
        }
      }

      // Forget chains that no longer have findings, or the memo grows for the
      // life of the process.
      const live = new Set(chains.map(([spec]) => spec));
      for (const spec of this.memo.keys()) if (!live.has(spec)) this.memo.delete(spec);

      const snapshot: IssuesSnapshot = {
        window,
        computedAtUnix: report.computedAtUnix,
        logsAvailable: this.loki.available,
        configAvailable: routers.length > 0,
        issues,
      };
      this.snapshots.set(window, snapshot);
      return snapshot;
    } finally {
      this.running.delete(window);
    }
  }
}
