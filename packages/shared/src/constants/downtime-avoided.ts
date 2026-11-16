/**
 * Downtime avoided: how long a provider was failing while its chain kept
 * answering - the time a client on that provider alone would have been
 * down, and behind the router was not.
 *
 * A stretch of a chain counts when both hold:
 *
 *  1. A provider was failing on it: the stretch is inside a burst of failed
 *     tries (the Errors timeline's own bursts, `detectErrorIncidents`, kind
 *     `failed`) and that provider failed tries on that chain in the stretch.
 *     Error replies are left out: a provider that answers with an error is
 *     up, and most such errors are the request's own.
 *  2. The chain kept answering: of the clients' requests on the chain in the
 *     stretch, at least `minAnswered` got an answer. From the counts the log
 *     store records of each request's outcome; a stretch with no client
 *     request on the chain proves nothing and counts neither way.
 *
 * A stretch counts once per chain, however many providers failed in it, and
 * whole: the count is exact to the read's step - a minute up to 3 hours, 5
 * minutes beyond (`downtimeAvoidedRead`). A window longer than a week is read
 * in pieces of a week at most at that step, never at the timeline's
 * 30-minute one: a 5-minute burst counted as 30 minutes would overstate it.
 * Each chain counts its own time, so over many chains the total can be
 * longer than the window.
 *
 * Without the recorded outcomes (a store with no log ruler) rule 2 can't be
 * checked, and the report says so (`strict: false`): its seconds are then
 * the time a provider was failing, whatever its chain did.
 */

import type { ErrorIncidentLine, ErrorIncidentSeries } from "./error-incidents.js";

export const DOWNTIME_AVOIDED_RULES = {
  /** The share of a chain's requests that must have been answered in a stretch for it to count. */
  minAnswered: 0.999,
  /** The longest piece one read covers, seconds: what the Errors timeline reads at a 5-minute step. */
  maxPieceSec: 7 * 86_400,
} as const;

/**
 * The reads behind a window ending at `end` (a multiple of the step): the
 * step, and the pieces to read, oldest first - one for a window up to a week,
 * equal pieces of a week at most beyond. A piece is read from `readFrom`, at
 * least a day back, so each provider's usual level is known; only stretches
 * after `from` count.
 */
export function downtimeAvoidedRead(rangeSeconds: number, end: number): { stepSec: number; pieces: { readFrom: number; from: number; to: number }[] } {
  const stepSec = rangeSeconds <= 3 * 3600 ? 60 : 300;
  const n = Math.max(1, Math.ceil(rangeSeconds / DOWNTIME_AVOIDED_RULES.maxPieceSec));
  const len = Math.ceil(rangeSeconds / n / stepSec) * stepSec;
  const pieces = Array.from({ length: n }, (_, i) => {
    const to = end - (n - 1 - i) * len;
    const from = Math.max(end - rangeSeconds, to - len);
    return { readFrom: Math.min(from, to - 86_400), from, to };
  });
  return { stepSec, pieces };
}

/** `GET /api/metrics/downtime-avoided`. */
export interface DowntimeAvoidedReport {
  /** The page window, unix seconds. */
  from: number;
  to: number;
  /** The stretch the counts were read at, seconds: what `seconds` is exact to. */
  stepSec: number;
  /** Strict: seconds a provider was failing while its chain kept answering. Not strict: seconds a provider was failing. */
  seconds: number;
  /** Strict only: seconds a provider was failing and its chain did NOT keep answering. */
  notAvoidedSeconds: number;
  /** Bursts of failed tries behind `seconds`. */
  incidents: number;
  /** Chains behind `seconds`. */
  chains: number;
  /** Whether "the chain kept answering" was checked (the recorded request outcomes exist). */
  strict: boolean;
  /** False when the store refused the read of the failed tries; the numbers are then zeros. */
  available: boolean;
}

/** What clients got on one chain in one stretch: their requests, and the ones the router couldn't serve. */
export interface ServedStretch {
  requests: number;
  failed: number;
}

/**
 * The count. `lines` and `series` are one read's (`detectErrorIncidents` over
 * `series`); `served` holds each chain's stretches keyed by the chain's spec
 * upper-cased and the stretch's end, or null when the store records none.
 * Stretches ending at or before `windowFrom` are before the window.
 */
export function downtimeAvoided(input: {
  lines: readonly ErrorIncidentLine[];
  series: readonly ErrorIncidentSeries[];
  stepSec: number;
  windowFrom: number;
  to: number;
  served: ReadonlyMap<string, ReadonlyMap<number, ServedStretch>> | null;
}): Pick<DowntimeAvoidedReport, "seconds" | "notAvoidedSeconds" | "incidents" | "chains" | "strict"> & { chainNames: string[] } {
  const { lines, series, stepSec, windowFrom, to, served } = input;
  const strict = served !== null;
  // Failed tries per provider: chain → stretch → count.
  const byProvider = new Map<string, Map<string, Map<number, number>>>();
  for (const s of series) {
    if (s.kind !== "failed") continue;
    const p = s.provider.toLowerCase();
    const chains = byProvider.get(p) ?? byProvider.set(p, new Map()).get(p)!;
    const pts = chains.get(s.spec.toUpperCase()) ?? chains.set(s.spec.toUpperCase(), new Map()).get(s.spec.toUpperCase())!;
    for (const [t, v] of s.points) if (v > 0) pts.set(t, v);
  }
  // A stretch of a chain, once: which bursts put it there.
  const trouble = new Map<string, Set<number>>();
  lines.forEach((line, i) => {
    if (line.kind !== "failed") return;
    for (const provider of line.providers) {
      for (const [chain, pts] of byProvider.get(provider.toLowerCase()) ?? []) {
        for (const w of line.waves) {
          for (let t = w.start; t <= w.end; t += stepSec) {
            if (t <= windowFrom || t > to || !pts.has(t)) continue;
            const key = `${chain}|${t}`;
            (trouble.get(key) ?? trouble.set(key, new Set()).get(key)!).add(i);
          }
        }
      }
    }
  });
  let seconds = 0, notAvoidedSeconds = 0;
  const incidents = new Set<number>(), chains = new Set<string>();
  for (const [key, from] of trouble) {
    const cut = key.lastIndexOf("|");
    const chain = key.slice(0, cut), t = Number(key.slice(cut + 1));
    if (strict) {
      const got = served.get(chain)?.get(t);
      // No client request on the chain in the stretch: nothing was at stake.
      if (!got || !(got.requests > 0)) continue;
      if (1 - Math.min(got.failed, got.requests) / got.requests < DOWNTIME_AVOIDED_RULES.minAnswered) { notAvoidedSeconds += stepSec; continue; }
    }
    seconds += stepSec;
    chains.add(chain);
    from.forEach((i) => incidents.add(i));
  }
  return { seconds, notAvoidedSeconds, incidents: incidents.size, chains: chains.size, strict, chainNames: [...chains].sort() };
}
