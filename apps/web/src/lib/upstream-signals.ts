import type { UpstreamMetrics } from "@sr/shared";

/**
 * The words for the signal an upstream keeps when no traffic reaches it: its
 * block polls. The router does not wait for a request to watch an upstream -
 * a chain tracker polls each one for its latest block on the chain's own
 * cadence, backups included, with no relay needed.
 *
 * Wording lives here rather than in the panels for the reason `lib/health.ts`
 * exists: one upstream is read on several surfaces, and several phrasings of
 * one fact is how a reader ends up believing they are several facts.
 */

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
