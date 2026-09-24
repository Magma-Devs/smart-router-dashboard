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
import { DEFAULT_WINDOW, type MetricWindow, type StatusFinding } from "@sr/shared";
import type { PrometheusClient } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import type { MetricsDetailService } from "./metrics-detail.js";
import { FormulatedIssueService, severityOf, type FormulatedIssue } from "./formulated-issues.js";
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

/**
 * What makes an issue worth rewriting. Headlines carry the numbers, so a rate
 * moving from 4% to 38% changes this and a quiet chain does not.
 */
export function fingerprint(findings: StatusFinding[]): string {
  return findings
    .map((f) => `${f.id}|${f.tier}|${f.headline}`)
    .sort()
    .join("~");
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
    private readonly loki: LokiService = new LokiService(),
  ) {}

  current(window: MetricWindow): IssuesSnapshot | null {
    return this.snapshots.get(window) ?? null;
  }

  /** True while a window is being computed, so a route can say "working" not "off". */
  isRunning(window: MetricWindow): boolean {
    return this.running.has(window);
  }

  async refresh(window: MetricWindow = DEFAULT_WINDOW, limit = 8): Promise<IssuesSnapshot | null> {
    if (this.running.has(window)) return this.snapshots.get(window) ?? null;
    // Checked here, not at the route: an unconfigured deployment must not run
    // a model loop it was never allowed to run.
    if (!bedrockGate(process.env.AUTH_MODE ?? config.auth.mode).ok) return null;
    this.running.add(window);
    try {
      const report = await this.detail.status(window);

      const bySpec = new Map<string, StatusFinding[]>();
      for (const f of report.findings) {
        const list = bySpec.get(f.spec) ?? [];
        list.push(f);
        bySpec.set(f.spec, list);
      }

      const rank = { critical: 0, degraded: 1, config: 2 } as const;
      const chains = [...bySpec.entries()]
        .sort((a, b) => rank[severityOf(a[1])] - rank[severityOf(b[1])] || b[1].length - a[1].length)
        .slice(0, limit);

      const routers = this.configSvc?.getRouters() ?? [];
      const svc = new FormulatedIssueService(new BedrockService(config.bedrock.model, this.logger), this.logger);

      const issues: FormulatedIssue[] = [];
      for (const [spec, findings] of chains) {
        const print = fingerprint(findings);
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
            recovered: null,
            failures: null,
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
