import type { HealthState, UpstreamMetrics } from "@sr/shared";

/** A historical request statistic must not certify an unavailable upstream. */
export function upstreamMetricColor(health: HealthState, color: string): string {
  return health === "operational" ? color : "var(--text-3)";
}

export function upstreamHealthNotice(health: HealthState): string | null {
  if (health === "operational") return null;
  return health === "unhealthy"
    ? "This upstream is unhealthy. Request metrics below describe the selected time window."
    : "Current upstream health is unknown. Request metrics below describe the selected time window.";
}

/** Router availability and the health of every backing upstream are separate facts. */
export function deploymentHealthSummary(
  health: HealthState | undefined,
  upstreams: Pick<UpstreamMetrics, "health">[] | undefined,
): { label: string; color: string } {
  const label =
    health === "operational"
      ? "Router operational"
      : health === "unhealthy"
        ? "Router unhealthy"
        : "Router health unknown";
  const unhealthy = upstreams?.filter((row) => row.health === "unhealthy").length ?? 0;
  const unknown = upstreams?.filter((row) => row.health === "unknown").length ?? 0;
  const parts = [label];
  if (unhealthy) parts.push(`${unhealthy} upstream${unhealthy === 1 ? "" : "s"} unhealthy`);
  if (unknown) parts.push(`${unknown} upstream${unknown === 1 ? "" : "s"} unknown`);
  return {
    label: parts.join(" · "),
    color:
      health === "unhealthy"
        ? "var(--err)"
        : unhealthy
          ? "var(--warn)"
          : health !== "operational" || unknown
            ? "var(--text-3)"
            : "var(--ok)",
  };
}
