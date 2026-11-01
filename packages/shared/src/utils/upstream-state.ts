import type { HealthState } from "../types/domain.js";

/**
 * Share of an upstream's tries that, once failed, make a point unhealthy:
 * half or more. One failed try in a busy minute is the router doing its job
 * (it retries elsewhere); half of them failing is the upstream not serving.
 */
export const UNHEALTHY_FAILED_SHARE = 0.5;

/** The evidence about one upstream at one point; null = that series has no sample there. */
export interface UpstreamCellEvidence {
  /** Tries per second the router sent it. */
  rps: number | null;
  /** Failed tries per second. */
  failedRps: number | null;
  /** Latest-block polls that answered. */
  pollsOk: number | null;
  /** Latest-block polls that failed. */
  pollsFailed: number | null;
}

/**
 * The health one point of an upstream's history reads as, from the two
 * signals that exist per upstream over time: the router's tries (requests and
 * successes by `provider_address`) and the chain tracker's latest-block polls
 * (`rpc_endpoint_fetch_latest_*`, every configured upstream, backups included).
 * `rpc_endpoint_overall_health` is NOT read: it starts optimistic and moves
 * only on relay outcomes, so as history it says nothing about an idle backup.
 *
 * - `unhealthy`: at least `UNHEALTHY_FAILED_SHARE` of its tries failed, or
 *   every poll failed - the same rule current health applies to polls.
 * - `operational`: some tries or polls succeeded and neither of the above.
 * - `unknown`: scraped, but neither tried nor polled. The poll gate skips a
 *   poll that traffic or a peer pod already made, so zero polls is "not
 *   polled", never "healthy".
 * - `null`: no series had a sample - a gap, not a health.
 */
export function upstreamCellState(e: UpstreamCellEvidence): HealthState | null {
  if (e.rps === null && e.failedRps === null && e.pollsOk === null && e.pollsFailed === null) return null;
  const tries = e.rps ?? 0;
  const failed = Math.min(e.failedRps ?? 0, tries);
  const ok = e.pollsOk ?? 0;
  const pollFailed = e.pollsFailed ?? 0;
  if (tries > 0 && failed >= tries * UNHEALTHY_FAILED_SHARE) return "unhealthy";
  if (pollFailed > 0 && ok === 0) return "unhealthy";
  if (tries > 0 || ok > 0) return "operational";
  return "unknown";
}
