import type { UpstreamMetrics } from "@sr/shared";

/**
 * ONE vocabulary for the two signals an upstream keeps when no traffic reaches
 * it — its QoS score and its poll outcomes.
 *
 * Both exist because the router does not wait for a request to judge an
 * upstream. A probe loop scores every configured upstream (backups included)
 * every few seconds, and a chain tracker polls each one for its latest block on
 * the chain's own cadence. Neither needs a relay.
 *
 * The dashboard used to throw both away. `/api/metrics/upstreams` read the QoS
 * gauge the ROUTING path writes — present only where a relay had been routed —
 * and the roster then folded that column into the "No recent traffic" cell
 * anyway. So a backup nobody had failed over to read as a row the dashboard
 * knew nothing about, when in fact the router was scoring it continuously.
 *
 * Wording lives here rather than in the panels for the reason `lib/health.ts`
 * exists: the same upstream is read across the roster, the deep-dive and the
 * empty state, and three phrasings of one fact is how a reader ends up
 * believing they are three different facts.
 */

/** What the roster's QoS column shows when the score is missing entirely. */
export const QOS_NONE = "—";

/**
 * Why a QoS cell reads the way it does — for a `title`.
 *
 * The distinction that matters is not the number, it is when it was written.
 * The sampler's gauge is refreshed on a timer for every upstream; the routing
 * path's is frozen at the last relay, which on an idle row can be any age at
 * all. Both carry the same five numbers from the same optimizer computation,
 * so this is a freshness caveat, never a "different score" caveat.
 */
export function qosHint(pm: UpstreamMetrics): string | undefined {
  if (pm.scoreSource === "optimizer") {
    return "Live score from the router's probe loop — refreshed for every upstream on a timer, so it stays current with no traffic.";
  }
  if (pm.scoreSource === "endpoint") {
    return pm.requests > 0
      ? "Score as of the router's last selection for this upstream."
      : "Score as of the last time a request was routed here — this upstream has served none in this window, so it may be old. This router build does not publish the probe loop's live score.";
  }
  return "No score reported for this upstream.";
}

/** True when the score is real but may be arbitrarily stale — worth marking. */
export function qosIsStale(pm: UpstreamMetrics): boolean {
  return pm.scoreSource === "endpoint" && pm.requests === 0;
}

/** Composite QoS as the 0–100 figure every surface renders, or null. */
export function qosValue(pm: UpstreamMetrics): number | null {
  return pm.scores.composite != null ? pm.scores.composite * 100 : null;
}

/**
 * How the router's own polls went, for a field already labelled "Block polls" —
 * so it counts and does not name them again.
 *
 * The both-zero case is the one that has to stay honest. A poll gate suppresses
 * polls that served traffic — or another pod's poll — already made redundant,
 * so zero polls is "we did not ask", never "it did not answer". Reporting that
 * as healthy is exactly the invention the empty state used to make when it
 * claimed "probes are passing" without reading anything.
 */
export function pollSummary(polls: UpstreamMetrics["polls"]): string | null {
  if (polls === null) return null;
  if (polls.ok + polls.failed === 0) return "none in this window";
  const answered = `${fmt(polls.ok)} answered`;
  return polls.failed === 0 ? answered : `${answered} · ${fmt(polls.failed)} failed`;
}

/** Colour for a poll summary — silent about the case it cannot judge. */
export function pollColor(polls: UpstreamMetrics["polls"]): string {
  if (polls === null) return "var(--text-4)";
  const total = polls.ok + polls.failed;
  if (total === 0) return "var(--text-4)";
  if (polls.failed === 0) return "var(--ok)";
  if (polls.ok === 0) return "var(--err)";
  return "var(--warn)";
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toString();
}
