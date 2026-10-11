"use client";

import type { HealthState, OverviewData, UpstreamMetrics } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "./FiltersProvider";
import { deploymentHealthSummary } from "@/lib/upstream-presentation";

export function DeploymentHealthBadge({
  health,
  upstreams,
}: {
  health: HealthState | undefined;
  upstreams: Pick<UpstreamMetrics, "health">[] | undefined;
}) {
  const summary = deploymentHealthSummary(health, upstreams);
  return (
    <span className="pill" role="status" style={{ color: summary.color }}>
      <span
        style={{ width: 7, height: 7, borderRadius: 999, background: summary.color, flexShrink: 0 }}
      />
      {summary.label}
    </span>
  );
}

export function DeploymentHealth() {
  const { scopeQ } = useFilters();
  const { data } = useApi<OverviewData>(`/api/metrics/overview?window=1h${scopeQ}`, 30000);
  const roster = useApi<{ upstreams: UpstreamMetrics[] }>(
    `/api/metrics/upstreams?window=1h${scopeQ}`,
    15000,
    { keepPreviousData: false },
  );
  return <DeploymentHealthBadge health={data?.health} upstreams={roster.data?.upstreams} />;
}
