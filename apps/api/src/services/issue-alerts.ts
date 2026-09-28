/**
 * Push alerts: a chain turning Critical, and that Critical issue resolving,
 * posted to a webhook the operator sets.
 *
 * The page only helps someone who is looking at it. Off unless
 * `ISSUES_WEBHOOK_URL` is set — who gets told, and about what, is the
 * operator's decision, not this code's. Only Critical is sent: the one badge
 * that means the chain cannot be used.
 *
 * The body is `{ text }`, which a Slack incoming webhook posts as a message
 * and any other receiver can read. The url usually carries a secret, so it
 * is never logged.
 */
import type { ServedIssue } from "./issues-feed.js";
import type { BedrockLogger } from "./bedrock.js";

export interface AlertEvent {
  kind: "critical" | "resolved";
  issue: ServedIssue;
}

/**
 * What changed between two reads of the log that someone should be told:
 * an issue that is now Critical and was not before (new, reopened, or its
 * badge moved up), and a Critical issue that resolved.
 */
export function criticalChanges(before: ServedIssue[], after: ServedIssue[]): AlertEvent[] {
  const was = new Map(before.map((i) => [i.id, i]));
  const events: AlertEvent[] = [];
  for (const i of after) {
    const prev = was.get(i.id);
    if (i.status === "open" && i.severity === "critical" && (!prev || prev.status === "resolved" || prev.severity !== "critical")) {
      events.push({ kind: "critical", issue: i });
    } else if (i.status === "resolved" && prev?.status === "open" && prev.severity === "critical") {
      events.push({ kind: "resolved", issue: i });
    }
  }
  return events;
}

/** One message per event: the card's own lines, nothing the page does not say. */
export function alertText(e: AlertEvent, dashboardUrl?: string): string {
  const i = e.issue;
  const where = (i.specs?.length ?? 1) > 1 ? `${i.specs.length} chains` : i.chain;
  const link = dashboardUrl ? `${dashboardUrl.replace(/\/+$/, "")}/status` : null;
  if (e.kind === "resolved") return [`Resolved — ${where}: ${i.title}`, link].filter(Boolean).join("\n");
  return [
    `Critical — ${where}: ${i.title}`,
    i.impact,
    i.whoActs ? `Who acts: ${i.whoActs}` : null,
    link,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function postAlerts(
  url: string,
  events: AlertEvent[],
  opts: { dashboardUrl?: string; logger?: BedrockLogger; timeoutMs?: number } = {},
): Promise<void> {
  for (const e of events) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: alertText(e, opts.dashboardUrl) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      if (!res.ok) opts.logger?.warn({ status: res.status, issue: e.issue.id }, "issue alert was not accepted");
    } catch (err) {
      // The url is a secret: the error, never the url.
      opts.logger?.warn({ issue: e.issue.id, error: err instanceof Error ? err.message : String(err) }, "could not send an issue alert");
    }
  }
}
