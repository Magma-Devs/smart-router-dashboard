import { toMetricWindow, type MetricWindow } from "@sr/shared";

/* How often a panel re-reads. Pure, so the rules are tested without a
 * browser; `useApi` hands the result to SWR. */

const POLL_MS: Record<MetricWindow, number> = {
  "5m": 15_000,
  "15m": 15_000,
  "30m": 15_000,
  "1h": 15_000,
  "3h": 60_000,
  "6h": 60_000,
  "12h": 60_000,
  "1d": 300_000,
  "3d": 300_000,
  "7d": 900_000,
  "14d": 900_000,
  "21d": 900_000,
  "30d": 900_000,
};

/**
 * How often a panel over `win` re-reads. Chart steps grow with the window and
 * from 3h the api reads recorded series that move once a minute, so a faster
 * poll fetches the same answer again: from 30m up, a poll slides the window
 * by under 1% of its length. Never slower than the window's chart step.
 */
export function pollMsFor(win: MetricWindow): number {
  return POLL_MS[win];
}

const METRICS_KEY = /^\/api\/metrics\//;

/**
 * The interval a key polls at. A metrics read over a window
 * (`/api/metrics/…?window=`) polls no faster than that window's cadence; any
 * other key at the caller's interval. 0 (never) stays 0, and a window the api
 * doesn't know reads as the api reads it: the default.
 */
export function pollMsForKey(key: string, ms: number): number {
  if (ms <= 0 || !METRICS_KEY.test(key)) return ms;
  const q = key.indexOf("?");
  const win = q < 0 ? null : new URLSearchParams(key.slice(q + 1)).get("window");
  return win === null ? ms : Math.max(ms, pollMsFor(toMetricWindow(win)));
}

/* The idle gate: nobody at the page for 10 minutes slows every poll, an hour
 * stops them. `idle-store.ts` runs these rules against the page's events. */

/** Polling as asked, slowed, or stopped. */
export type IdlePhase = "active" | "slow" | "paused";

/** No activity for this long multiplies every interval by `IDLE_SLOWDOWN`. */
export const IDLE_SLOW_AFTER_MS = 10 * 60_000;
/** No activity for this long pauses every poll. */
export const IDLE_PAUSE_AFTER_MS = 60 * 60_000;
export const IDLE_SLOWDOWN = 4;
/** Activity this close to the last counted is not counted again. */
export const ACTIVITY_THROTTLE_MS = 1_000;

/** The phase `idleMs` after the last activity. */
export function idlePhase(idleMs: number): IdlePhase {
  if (idleMs >= IDLE_PAUSE_AFTER_MS) return "paused";
  if (idleMs >= IDLE_SLOW_AFTER_MS) return "slow";
  return "active";
}

/** How long until the phase moves on its own; null once paused, which only activity ends. */
export function msToNextPhase(idleMs: number): number | null {
  if (idleMs < IDLE_SLOW_AFTER_MS) return IDLE_SLOW_AFTER_MS - idleMs;
  if (idleMs < IDLE_PAUSE_AFTER_MS) return IDLE_PAUSE_AFTER_MS - idleMs;
  return null;
}

/**
 * An interval under the gate; 0 (never) stays 0. Paused keeps the slowed
 * timer: SWR's `isPaused` turns each tick into a no-op, and a timer that
 * somehow missed the resume still comes back on its own.
 */
export function gatedPollMs(ms: number, phase: IdlePhase): number {
  return phase === "active" ? ms : ms * IDLE_SLOWDOWN;
}

export interface IdleState {
  /** When activity was last counted (ms since the epoch). */
  lastActivityAt: number;
  /** The phase last announced to subscribers. */
  phase: IdlePhase;
  /** Returns from idle so far: each one re-reads and re-arms every poll. */
  resumes: number;
}

export function idleStart(now: number, resumes = 0): IdleState {
  return { lastActivityAt: now, phase: "active", resumes };
}

/**
 * Activity at `now`. The same object back when there's nothing to record
 * (throttled). Idle by the clock is a return from idle even before the phase
 * timer has said so - the polls read the clock, not the announcement.
 */
export function onActivity(s: IdleState, now: number): IdleState {
  const idleMs = now - s.lastActivityAt;
  if (s.phase === "active" && idlePhase(idleMs) === "active") {
    return idleMs >= 0 && idleMs < ACTIVITY_THROTTLE_MS ? s : { ...s, lastActivityAt: now };
  }
  return idleStart(now, s.resumes + 1);
}

/** The phase timer firing at `now`: the same object back while the phase holds. */
export function onPhaseTimer(s: IdleState, now: number): IdleState {
  const phase = idlePhase(now - s.lastActivityAt);
  return phase === s.phase ? s : { ...s, phase };
}

/** Pages the gate leaves alone: the standalone Metrics page is for screens nobody touches. */
const IDLE_EXEMPT_PATHS = ["/standalone"];

/** Whether the idle gate holds the polls of the page at `pathname`. */
export function idleGateApplies(pathname: string): boolean {
  return !IDLE_EXEMPT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
