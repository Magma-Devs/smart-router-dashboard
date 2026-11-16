import type { DeploymentPulse, HealthState, UpstreamMetrics } from "@sr/shared";
import { durationWords } from "./health";

/**
 * A historical request statistic must not certify an unavailable upstream.
 * An `untracked` one keeps its color: its requests are the only evidence there is.
 */
export function upstreamMetricColor(health: HealthState, color: string): string {
  return health === "operational" || health === "untracked" ? color : "var(--text-3)";
}

/** The headline of a provider's health notice; null for one that is fine. */
export function upstreamHealthNotice(health: HealthState, reason?: string): string | null {
  if (health === "operational") return null;
  // One sentence of its own: the api's reason says the same thing, and both read as a repeat.
  if (health === "untracked")
    return "This provider has no block height by design: it serves only add-on methods, so the router runs no block checks on it. The request metrics below are the only health evidence for it.";
  const status = health === "unhealthy" ? "This provider is unhealthy." : "This provider's health is not known.";
  const evidence =
    reason ??
    (health === "unknown" ? "No data yet: the router reports nothing about it." : "The router reports a problem with it.");
  return `${status} ${evidence}`;
}

/** Seconds behind the chain from which it is worth saying. */
const CAVEAT_BEHIND_SEC = 30;

/**
 * What an OPERATIONAL provider's status leaves out about its block: one that
 * stopped moving, or is well behind the chain. Failed block checks are not
 * said: a provider that still serves is operational, and the count gives the
 * reader nothing to do. Null when there is nothing to add, and for a provider
 * that isn't operational - its status already carries the reason.
 */
export function upstreamCaveat(pm: Pick<UpstreamMetrics, "health" | "behindSec" | "stale">): string | null {
  if (pm.health !== "operational") return null;
  if (pm.stale) return "its block stopped moving";
  return pm.behindSec != null && pm.behindSec >= CAVEAT_BEHIND_SEC ? `${Math.round(pm.behindSec)} s behind the chain` : null;
}

/**
 * A provider's latest block against the chain's: the highest block any
 * provider of that chain reports. "latest" when it is that block, else how
 * many blocks behind and, where the chain's block rate is known, how long
 * that is - a block count means nothing across chains. Marked (`warn`) from
 * the same 30 seconds the status caveat uses, and when its block stopped
 * moving while the chain went on. Null when it reports no block, or the
 * chain's latest isn't known.
 */
export function blockBehind(
  pm: Pick<UpstreamMetrics, "latestBlock" | "blockLag" | "behindSec" | "stale">,
  fmt: (n: number) => string = String,
): { text: string; tone: "ok" | "warn" | "plain" } | null {
  if (pm.latestBlock == null || pm.blockLag == null) return null;
  if (pm.blockLag <= 0) return pm.stale ? { text: "not moving", tone: "warn" } : { text: "latest", tone: "ok" };
  const sec = pm.behindSec;
  const time = sec != null && sec >= 1 ? ` · ${sec < 60 ? `${Math.round(sec)} s` : durationWords(sec)}` : "";
  const text = `${fmt(pm.blockLag)} behind${time}`;
  if (pm.stale) return { text: `${text} · not moving`, tone: "warn" };
  return { text, tone: sec != null && sec >= CAVEAT_BEHIND_SEC ? "warn" : "plain" };
}

/**
 * What the topbar shows from a pulse: the router's status and RPS across
 * every chain (`allChains`) on every page, beside provider counts that
 * follow the page's chain. A pulse without `allChains` - an api image older
 * than the web's, mid-rollout - gives its own figures.
 */
export function topbarFigures(pulse: DeploymentPulse | undefined): {
  health: HealthState | undefined;
  rps: number | null | undefined;
  counts: DeploymentPulse["upstreamHealthCounts"] | undefined;
} {
  const wide = pulse?.allChains ?? pulse;
  return { health: wide?.health, rps: wide?.throughputRps, counts: pulse?.upstreamHealthCounts };
}

/**
 * What the top bar says about the deployment, and only when there is
 * something to say: nothing (null) while the router and every provider are
 * fine - a permanent "operational" teaches the eye to skip the spot where a
 * problem will one day be written. Router availability and its providers'
 * health are separate facts, so both are named when both are off.
 */
export function deploymentHealthSummary(
  health: HealthState | undefined,
  counts: DeploymentPulse["upstreamHealthCounts"] | undefined,
): { label: string; color: string } | null {
  const unhealthy = counts?.unhealthy ?? 0;
  const unknown = counts?.unknown ?? 0;
  const parts: string[] = [];
  if (health === "unhealthy") parts.push("Router unhealthy");
  else if (health !== "operational") parts.push("Router health not known");
  // "Provider" is the one word for it across the pages (the Errors and
  // Transactions tabs say it too); "upstream" and "node" were the other two.
  if (unhealthy) parts.push(`${unhealthy} provider${unhealthy === 1 ? "" : "s"} unhealthy`);
  if (unknown) parts.push(unhealthy ? `${unknown} to check` : `${unknown} provider${unknown === 1 ? "" : "s"} to check`);
  if (!parts.length) return null;
  // Red is the router's own trouble; a provider's is a warning while the router serves.
  return { label: parts.join(" · "), color: health === "unhealthy" ? "var(--err)" : "var(--warn)" };
}
