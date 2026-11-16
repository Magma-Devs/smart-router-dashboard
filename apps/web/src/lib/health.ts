import type { HealthCause, HealthState } from "@sr/shared";
import { fmtDayTime, fmtTime } from "./datetime";

/**
 * ONE vocabulary for `HealthState`, the shared closed union every health-aware
 * surface reads (`/api/metrics/{chains,upstreams,…}`).
 *
 * Every surface takes its words and colors for the four states from here -
 * the Upstreams roster, the Routers table, the upstream deep-dive, the Try-it
 * drawer - so one upstream reads the same way on every panel.
 *
 * `unknown` means no current health measurement, not "down". It has an
 * explicit warning label so missing data is a visible problem.
 *
 * `untracked` is a provider the router tracks no block height on, by design.
 * Nothing is missing and nothing is wrong, so it is neutral: "No block height".
 */
export const HEALTH_LABEL: Record<HealthState, string> = {
  operational: "Operational",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
  untracked: "No block height",
};

export const HEALTH_COLOR: Record<HealthState, string> = {
  operational: "var(--ok)",
  unhealthy: "var(--err)",
  unknown: "var(--warn)",
  // Neutral on purpose: nothing is wrong and nothing was measured.
  untracked: "var(--text-3)",
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
  untracked: null,
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

/** Explain a provider the router does not track by design, wherever it is shown. */
export const HEALTH_UNTRACKED_HINT =
  "No block height by design: this provider serves only add-on methods and cannot report a block height, so the router runs no block polls on it. Its health is known only from the requests it serves.";

/** The hover text a health state carries when the surface has no reason of its own. */
export function healthHint(health: HealthState): string | undefined {
  if (health === "unknown") return HEALTH_UNKNOWN_HINT;
  if (health === "untracked") return HEALTH_UNTRACKED_HINT;
  return undefined;
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
  if (health === "untracked") return "gw-tag";
  return "gw-tag gw-tag--warn";
}

/** Worst-first ordering (an unhealthy row is the one you came to find). */
export const HEALTH_RANK: Record<HealthState, number> = {
  unhealthy: 0,
  operational: 2,
  unknown: 1,
  untracked: 3,
};
