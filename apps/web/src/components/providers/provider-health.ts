import type { HealthState } from "@sr/shared";

/* A provider's health in the dashboard's one vocabulary (lib/health.ts): the
 * router's own per-provider state, `smartrouter_csm_provider_blocked`, as the
 * Upstreams tab reads it. Blocked is Unhealthy; not blocked is Operational;
 * a router that doesn't emit the gauge says nothing (null), and nothing is
 * drawn rather than a guess. */

export const BLOCKED_REASON = "The router has stopped sending this provider requests for now.";

export function providerHealth(blocked: boolean): HealthState {
  return blocked ? "unhealthy" : "operational";
}
