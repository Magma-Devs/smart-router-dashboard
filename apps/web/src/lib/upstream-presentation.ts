import type { DeploymentPulse, HealthState } from "@sr/shared";

/** A historical request statistic must not certify an unavailable upstream. */
export function upstreamMetricColor(health: HealthState, color: string): string {
  return health === "operational" ? color : "var(--text-3)";
}

export function upstreamHealthNotice(health: HealthState, reason?: string): string | null {
  if (health === "operational") return null;
  const status =
    health === "unhealthy" ? "This provider is unhealthy." : "This provider's current health is unknown.";
  const evidence =
    reason ??
    (health === "unknown"
      ? "No current health data reported; check the router and Prometheus scrape."
      : "The router reports a health problem.");
  return `${status} ${evidence} Request metrics below describe the selected time window.`;
}

/** Router availability and the health of every backing upstream are separate facts. */
export function deploymentHealthSummary(
  health: HealthState | undefined,
  counts: DeploymentPulse["upstreamHealthCounts"] | undefined,
): { label: string; color: string } {
  const label =
    health === "operational"
      ? "Router operational"
      : health === "unhealthy"
        ? "Router unhealthy"
        : "Router health unknown";
  const unhealthy = counts?.unhealthy ?? 0;
  const unknown = counts?.unknown ?? 0;
  const parts = [label];
  // "Provider" is the one word for it across the pages (the Errors and
  // Transactions tabs say it too); "upstream" and "node" were the other two.
  if (unhealthy) parts.push(`${unhealthy} provider${unhealthy === 1 ? "" : "s"} unhealthy`);
  if (unknown) parts.push(`${unknown} provider${unknown === 1 ? "" : "s"} with no health data`);
  return {
    label: parts.join(" · "),
    color:
      health === "unhealthy"
        ? "var(--err)"
        : unhealthy
          ? "var(--warn)"
          : health !== "operational" || unknown
            ? "var(--warn)"
            : "var(--ok)",
  };
}
