/**
 * The incident feed, computed in the background so the page opens on it.
 *
 * Explaining four incidents takes ~35s against a live deployment, nearly all
 * of it the Prometheus reads — far too slow to open a page on. So the feed is
 * computed on a loop and served from memory, and the browser never waits.
 *
 * ## Memoised per incident, not per feed
 *
 * The obvious design recomputes the whole feed on a timer, which re-explains
 * four unchanged incidents every cycle and — worse — re-words them. The model
 * is not deterministic, so an unchanged deployment would produce a
 * differently-phrased feed every few minutes, which reads as churn and is how
 * people stop trusting a page.
 *
 * Instead each incident's explanation is cached under its own id. A cycle
 * explains only the incidents it has not seen, so a quiet hour costs nothing
 * and the wording of an existing item never moves. That also makes the feed a
 * usable notification source: an id appearing for the first time IS the event.
 *
 * Episodes are re-derived per detection and the bucket boundaries drift, so
 * ids are matched loosely — same chain, overlapping window — before an item is
 * treated as new. Without that every cycle would look like a fresh incident.
 */
import type { Incident } from "@sr/shared";
import type { PrometheusClient } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import { IncidentsService } from "./incidents.js";
import { IncidentExplainService, type IncidentExplanation } from "./incident-explain.js";
import { LokiService, groupErrors } from "./loki.js";
import { BedrockService, type BedrockLogger } from "./bedrock.js";
import { bedrockGate } from "./bedrock.js";
import { config } from "../config.js";

export interface FeedItem {
  id: string;
  spec: string;
  chain: string;
  startUnix: number;
  endUnix: number;
  ongoing: boolean;
  failures: number;
  recovered: number | null;
  /** The causal chain. Falls back to the deterministic story when unexplained. */
  steps: string[];
  conclusion: string;
  owner: IncidentExplanation["owner"];
  explained: boolean;
  /** Unix seconds this item's explanation was produced. */
  explainedAtUnix: number | null;
  /** True the first time an item appears — what a notifier should fire on. */
  isNew: boolean;
}

export interface Feed {
  computedAtUnix: number;
  hours: number;
  logsAvailable: boolean;
  configAvailable: boolean;
  items: FeedItem[];
}

/** Same chain and an overlapping window = the same episode, re-bucketed. */
function sameEpisode(a: { spec: string; startUnix: number; endUnix: number }, b: Incident): boolean {
  if (a.spec !== b.spec) return false;
  const slack = 600;
  return a.startUnix <= b.endUnix + slack && b.startUnix <= a.endUnix + slack;
}

export class IncidentFeedService {
  /** Explanations by incident id, plus the window they covered for re-matching. */
  private readonly memo = new Map<
    string,
    { spec: string; startUnix: number; endUnix: number; explanation: IncidentExplanation; atUnix: number }
  >();
  private feed: Feed | null = null;
  private running = false;

  constructor(
    private readonly prom: PrometheusClient,
    private readonly configSvc?: ConfigurationService,
    private readonly logger?: BedrockLogger,
    private readonly loki: LokiService = new LokiService(),
  ) {}

  /** The cached feed, or null before the first cycle finishes. */
  get current(): Feed | null {
    return this.feed;
  }

  /**
   * One cycle: detect, explain what is new, keep what is not.
   *
   * Guarded against overlap — a cycle can outlast its own interval on a slow
   * Prometheus, and two of them racing would double every model call.
   */
  async refresh(hours = 24, limit = 6): Promise<Feed | null> {
    if (this.running) return this.feed;
    // The gate is checked here rather than at the route: an unconfigured
    // deployment must not run a model loop it was never allowed to run.
    if (!bedrockGate(process.env.AUTH_MODE ?? config.auth.mode).ok) return this.feed;
    this.running = true;
    try {
      const report = await new IncidentsService(this.prom, this.configSvc).incidents(hours);
      const incidents = report.incidents.slice(0, limit);
      const routers = this.configSvc?.getRouters() ?? [];
      const svc = new IncidentExplainService(new BedrockService(config.bedrock.model, this.logger), this.logger);

      const items: FeedItem[] = [];
      for (const incident of incidents) {
        const hit =
          this.memo.get(incident.id) ??
          [...this.memo.values()].find((m) => sameEpisode(m, incident));

        const base = {
          id: incident.id,
          spec: incident.spec,
          chain: incident.chainName,
          startUnix: incident.startUnix,
          endUnix: incident.endUnix,
          ongoing: incident.ongoing,
          failures: incident.failures,
          recovered: incident.retriesRecovered,
        };

        if (hit) {
          // Seen before: keep the wording it already had. Re-explaining an
          // unchanged incident only changes how it reads.
          items.push({
            ...base,
            steps: hit.explanation.steps,
            conclusion: hit.explanation.conclusion,
            owner: hit.explanation.owner,
            explained: true,
            explainedAtUnix: hit.atUnix,
            isNew: false,
          });
          continue;
        }

        const lines = this.loki.available
          ? await this.loki
              .recentErrors(incident.spec, undefined, 200, incident.startUnix - 60, incident.endUnix + 60)
              .catch(() => [])
          : [];
        const configured = routers
          .filter((r) => r.spec === incident.spec)
          .flatMap((r) =>
            r.nodes.map((n) => ({
              upstream: n.name,
              role: (n.isBackup ? "backup" : "primary") as "primary" | "backup",
              addons: [...new Set(n.endpoints.flatMap((e) => e.addons ?? []))],
            })),
          );

        try {
          const explanation = await svc.explain({ incident, errorGroups: groupErrors(lines, 6), configured });
          const atUnix = Math.floor(Date.now() / 1000);
          this.memo.set(incident.id, {
            spec: incident.spec,
            startUnix: incident.startUnix,
            endUnix: incident.endUnix,
            explanation,
            atUnix,
          });
          items.push({ ...base, ...explanation, explained: true, explainedAtUnix: atUnix, isNew: true });
        } catch (err) {
          this.logger?.warn(
            { incidentId: incident.id, error: err instanceof Error ? err.message : String(err) },
            "incident feed could not explain an item",
          );
          // NOT memoised: a failure should be retried next cycle, unlike an
          // explanation, which should never be recomputed.
          items.push({
            ...base,
            steps: incident.story,
            conclusion: "",
            owner: "undetermined",
            explained: false,
            explainedAtUnix: null,
            isNew: true,
          });
        }
      }

      // Forget explanations whose episode has fallen out of the window, or the
      // memo grows for the life of the process.
      const live = new Set(incidents.map((i) => i.id));
      for (const [id, m] of this.memo) {
        if (!live.has(id) && !incidents.some((i) => sameEpisode(m, i))) this.memo.delete(id);
      }

      this.feed = {
        computedAtUnix: report.computedAtUnix,
        hours,
        logsAvailable: this.loki.available,
        configAvailable: routers.length > 0,
        items,
      };
      return this.feed;
    } finally {
      this.running = false;
    }
  }
}
