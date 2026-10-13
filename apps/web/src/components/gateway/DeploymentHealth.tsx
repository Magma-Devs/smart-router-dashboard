"use client";

import type { HealthState, OverviewData } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "./FiltersProvider";
import { deploymentHealthSummary } from "@/lib/upstream-presentation";

export function DeploymentHealthBadge({
  health,
  counts,
  loading = false,
  error = false,
}: {
  health: HealthState | undefined;
  counts: OverviewData["upstreamHealthCounts"] | undefined;
  loading?: boolean;
  error?: boolean;
}) {
  const summary = loading
    ? { label: "Checking health…", color: "var(--text-3)" }
    : error
      ? { label: "Health data unavailable · check connection", color: "var(--warn)" }
      : deploymentHealthSummary(health, counts);
  return (
    <span
      className="pill"
      role="status"
      aria-busy={loading}
      title={
        !loading && !error && (health === "unknown" || !health || (counts?.unknown ?? 0) > 0)
          ? "No current health data reported; check the router and Prometheus scrape."
          : undefined
      }
      style={{ color: summary.color }}
    >
      <span
        style={{ width: 7, height: 7, borderRadius: 999, background: summary.color, flexShrink: 0 }}
      />
      {summary.label}
    </span>
  );
}

export function useDeploymentOverview() {
  const { scopeQ, routerId } = useFilters();
  const configScope = routerId ? `&routerId=${encodeURIComponent(routerId)}` : "";
  return useApi<OverviewData>(`/api/metrics/overview?window=1h${scopeQ}${configScope}`, 30000, {
    keepPreviousData: false,
  });
}

export function DeploymentHealth() {
  const { data, isLoading, error } = useDeploymentOverview();
  return (
    <DeploymentHealthBadge
      health={data?.health}
      counts={data?.upstreamHealthCounts}
      loading={!data && isLoading && !error}
      error={Boolean(error)}
    />
  );
}
