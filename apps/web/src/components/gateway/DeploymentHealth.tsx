"use client";

import type { DeploymentPulse, HealthState } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "./FiltersProvider";
import { deploymentHealthSummary, topbarFigures } from "@/lib/upstream-presentation";

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
 * on every page. Its own endpoint: six reads, whatever the chain count
 * (MAG-4296); eight on a chain's page, where it also reads the whole
 * router's figures (`allChains`), which are what the topbar shows.
 */
export function useDeploymentPulse() {
  const { withScope, routerId, chain } = useFilters();
  // On a chain's page the provider counts speak for that chain: counting every
  // chain's providers beside one chain's name read as that chain's own trouble.
  // The router's status and RPS stay the whole router's (`topbarFigures`).
  const params = [
    ...(chain ? [`spec=${encodeURIComponent(chain)}`] : []),
    ...(routerId ? [`routerId=${encodeURIComponent(routerId)}`] : []),
  ];
  const scoped = withScope("/api/metrics/pulse");
  const url = params.length ? `${scoped}${scoped.includes("?") ? "&" : "?"}${params.join("&")}` : scoped;
  return useApi<DeploymentPulse>(url, 30000, { keepPreviousData: false });
}

export function DeploymentHealth() {
  const { data, isLoading, error } = useDeploymentPulse();
  const { health, counts } = topbarFigures(data);
  return (
    <DeploymentHealthBadge
      health={health}
      counts={counts}
      loading={!data && isLoading && !error}
      error={Boolean(error)}
    />
  );
}
