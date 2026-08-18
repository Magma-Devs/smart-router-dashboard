import type { HealthState } from "@sr/shared";

/**
 * ONE vocabulary for `HealthState`, the shared closed union every health-aware
 * surface reads (`/api/metrics/{chains,upstreams,…}`).
 *
 * Before this existed, four surfaces each invented their own words for the
 * same three states — "healthy / degraded / —" on the Upstreams roster,
 * "Operational / Unhealthy / —" in the Routers table, "Live · up / Down / —"
 * in the upstream deep-dive, and the raw wire word in the Try-it drawer — so
 * one upstream could read three different ways depending on which panel you
 * were looking at. The Routers table's wording won because it was the most
 * prominent; everything else now defers to these.
 *
 * `unknown` is "no metrics in this window", NOT "down" — hence a neutral dot
 * and an em dash rather than a red anything.
 */
export const HEALTH_LABEL: Record<HealthState, string> = {
  operational: "Operational",
  unhealthy: "Unhealthy",
  unknown: "—",
};

export const HEALTH_COLOR: Record<HealthState, string> = {
  operational: "var(--ok)",
  unhealthy: "var(--err)",
  unknown: "var(--text-4)",
};

/** Why a row reads `—` — worth a title attribute wherever it's shown bare. */
export const HEALTH_UNKNOWN_HINT = "No metrics reported in this window";

export function healthLabel(health: HealthState): string {
  return HEALTH_LABEL[health];
}

export function healthColor(health: HealthState): string {
  return HEALTH_COLOR[health];
}

/** `gw-tag` variant for a chip that carries a health state. */
export function healthTagClass(health: HealthState): string {
  if (health === "operational") return "gw-tag gw-tag--ok";
  if (health === "unhealthy") return "gw-tag gw-tag--err";
  return "gw-tag";
}

/** Worst-first ordering (an unhealthy row is the one you came to find). */
export const HEALTH_RANK: Record<HealthState, number> = {
  unhealthy: 0,
  operational: 1,
  unknown: 2,
};
