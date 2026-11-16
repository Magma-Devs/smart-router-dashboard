import type { HealthCause, HealthState } from "@sr/shared";
import { fmtDayTime, fmtTime } from "./datetime";

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
 * `unknown` means no current health measurement, not "down". It has an
 * explicit warning label so missing data is a visible problem.
 */
export const HEALTH_LABEL: Record<HealthState, string> = {
  operational: "Operational",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
};

export const HEALTH_COLOR: Record<HealthState, string> = {
  operational: "var(--ok)",
  unhealthy: "var(--err)",
  unknown: "var(--warn)",
};

/** Explain an unknown health state wherever it is shown. */
export const HEALTH_UNKNOWN_HINT = "No data yet: the router reports nothing about it.";

/**
 * Why, in a few words, for a table row under the status word. The full
 * sentence is the api's (`healthReason`); null where the status says it all.
 */
export const CAUSE_SHORT: Record<HealthCause, string | null> = {
  ok: null,
  blocked: "router stopped sending",
  "checks-failing": "block checks failing",
  "no-checks": "no recent block check",
  "no-data": "no data yet",
};

/** A length of time in words: "under a minute", "12 min", "2 h 10 min", "3 days". */
export function durationWords(sec: number): string {
  const m = Math.floor(sec / 60);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 && h < 10 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/**
 * Since when a provider has been unhealthy, and for how long: "since 12:24 (2 h
 * 10 min)", the day too once it isn't today's. A start at the edge of the day
 * the api read is only a lower bound: "for over 24 h". Null when not known.
 */
export function sinceWords(since: number | null | undefined, orEarlier: boolean | undefined, nowMs: number = Date.now()): string | null {
  if (since == null) return null;
  const sec = Math.max(0, nowMs / 1000 - since);
  if (orEarlier) return `for over ${durationWords(sec)}`;
  const sameDay = new Date(since * 1000).toDateString() === new Date(nowMs).toDateString();
  return `since ${sameDay ? fmtTime(since * 1000) : fmtDayTime(since * 1000)} (${durationWords(sec)})`;
}

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
  return "gw-tag gw-tag--warn";
}

/** Worst-first ordering (an unhealthy row is the one you came to find). */
export const HEALTH_RANK: Record<HealthState, number> = {
  unhealthy: 0,
  operational: 2,
  unknown: 1,
};
