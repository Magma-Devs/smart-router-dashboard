/**
 * The Errors list's groups over the whole page window, from the store's
 * recorded counts (`GET /api/error-groups`), and when the list uses them
 * instead of grouping the requests it has loaded (`lib/error-groups.ts`).
 *
 * The counts know a request's chain, error class, failing provider, outcome
 * and whether the client got the error - nothing else. So they answer for
 * the list only on the page window (not on picked or a bar's times), with no
 * filter but "Reached the client" / "Recovered" / all. Anything else - or
 * counts the store can't give - and the list groups its loaded requests, as
 * before.
 *
 * Opening a group reads its own minutes from the logs, narrowed to its
 * failing provider and class, and keeps the results its outcome stands for.
 *
 * Pure: no React, so the decisions are tested on their own.
 */
import type { ErrorGroupsReport, ErrorRequestRow, RecordedErrorGroup } from "@sr/shared";

/** Where the grouped view's groups come from. */
export type GroupSource = "recorded" | "loaded";

/** The list's result pill: every request, the ones whose error reached the client, or one result. */
export type ResultPick = "all" | "reached" | ErrorRequestRow["result"];

export interface ListView {
  /** The pill as picked; "auto" before anyone has picked one. */
  picked: ResultPick | "auto";
  /** The list is on exact times - picked, or a bar's - not the page window. */
  exactRange: boolean;
  /** A filter the counts can't apply is set: retryable, error type, customer, method or provider. */
  filtered: boolean;
  /** Loaded requests whose error reached the client - what "auto" opens on without the counts. */
  loadedReached: number;
}

/** The picks the counts answer: their requests split only by whether the client got the error. */
const RECORDED_PICKS: ReadonlySet<ListView["picked"]> = new Set(["auto", "all", "reached", "recovered"]);

/**
 * Where the groups come from, and the pill "auto" stands for. The counts when
 * they answer for what the list shows - "auto" then opens on the requests
 * whose error reached the client when the window has any; else the loaded
 * requests, "auto" opening on those whose error reached the client when the
 * loaded ones have any.
 */
export function listGroups(report: ErrorGroupsReport | null | undefined, view: ListView): { source: GroupSource; result: ResultPick } {
  const recorded = !!report?.available && report.source === "recorded" && !view.exactRange && !view.filtered && RECORDED_PICKS.has(view.picked);
  const reached = recorded ? report!.reached.count : view.loadedReached;
  const result: ResultPick = view.picked === "auto" ? (reached > 0 ? "reached" : "all") : view.picked;
  return { source: recorded ? "recorded" : "loaded", result };
}

/** The groups a pick keeps: all, the ones whose error reached the client, or the recovered ones. */
export function groupsForPick(groups: readonly RecordedErrorGroup[], result: ResultPick): RecordedErrorGroup[] {
  if (result === "reached") return groups.filter((g) => g.reachedClient);
  if (result === "recovered") return groups.filter((g) => !g.reachedClient);
  return [...groups];
}

/**
 * The list's results a group's requests have - what opening it keeps of the
 * rows its read returns. Recovered when the client didn't get the error; a
 * node's error passed through is a provider error; a request the router
 * failed is a router error, or "outcome unknown" for a transaction it gave
 * up on after sending. An outcome the list doesn't know reads "No end
 * logged" there, as the loaded groups keep it apart. A classified group
 * with several outcomes is any of them.
 */
export function resultsOfGroup(g: Pick<RecordedErrorGroup, "outcome" | "reachedClient">): ReadonlySet<ErrorRequestRow["result"]> {
  if (!g.reachedClient) return new Set(["recovered"]);
  switch (g.outcome) {
    case null: return new Set(["error-reply", "failed", "write-unknown", "unknown"]);
    case "node_error": return new Set(["error-reply"]);
    case "write_unknown": return new Set(["write-unknown"]);
    case "no_answer":
    case "rejected_before_dispatch":
    case "router_error": return new Set(["failed", "write-unknown"]);
    default: return new Set(["unknown"]);
  }
}

/** A request's outcome as the router names it, in words. */
const OUTCOME_WORDS: Record<string, string> = {
  ok: "Recovered",
  node_error: "Provider error",
  no_answer: "No usable answer",
  write_unknown: "Outcome unknown",
  rejected_before_dispatch: "Refused before sending",
  router_error: "Router failure",
};

export function outcomeWords(outcome: string | null): string {
  if (!outcome) return "Several outcomes";
  return OUTCOME_WORDS[outcome] ?? outcome.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * A group's error in words: its class ("rate limit"), or - while the router
 * names none - its outcome, marked unclassified, never a blank.
 */
export function groupErrorWords(g: Pick<RecordedErrorGroup, "errorClass" | "outcome">): { label: string; unclassified: boolean } {
  if (g.errorClass) {
    const words = g.errorClass.replace(/[_-]+/g, " ").trim();
    return { label: words.charAt(0).toUpperCase() + words.slice(1), unclassified: false };
  }
  return { label: outcomeWords(g.outcome), unclassified: true };
}

/** The query that opens a group on the list: its minutes (unix ms), its failing provider and class - empty for none. */
export function groupQuery(g: Pick<RecordedErrorGroup, "from" | "to" | "failingProvider" | "errorClass">): { from: number; to: number; q: string } {
  const from = g.from * 1000;
  const to = Math.max(g.to * 1000, from + 1);
  return {
    from,
    to,
    q: `&failingProvider=${encodeURIComponent(g.failingProvider ?? "")}&errorClass=${encodeURIComponent(g.errorClass ?? "")}`,
  };
}
