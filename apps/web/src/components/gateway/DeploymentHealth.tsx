"use client";

import type { DeploymentPulse, HealthState } from "@sr/shared";
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
  counts: DeploymentPulse["upstreamHealthCounts"] | undefined;
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

/**
 * The topbar's pulse — health, upstream health counts, current RPS — polled
 * on every page. Its own six-read endpoint: the full overview it used to read
 * for these three fields costs dozens of reads a call (MAG-4296).
 */
export function useDeploymentPulse() {
  const { withScope, routerId } = useFilters();
  const scoped = withScope("/api/metrics/pulse");
  const url = routerId
    ? `${scoped}${scoped.includes("?") ? "&" : "?"}routerId=${encodeURIComponent(routerId)}`
    : scoped;
  return useApi<DeploymentPulse>(url, 30000, { keepPreviousData: false });
}

export function DeploymentHealth() {
  const { data, isLoading, error } = useDeploymentPulse();
  return (
    <DeploymentHealthBadge
      health={data?.health}
      counts={data?.upstreamHealthCounts}
      loading={!data && isLoading && !error}
      error={Boolean(error)}
    />
  );
}
