"use client";

/* The Errors list grouped over the whole page window, from the store's
 * recorded counts (/api/error-groups): the same columns as the groups of the
 * loaded requests (ErrorRequests), each line's bars on the window's own clock.
 * A click opens the group's requests: the list reads its minutes from the
 * logs, narrowed to its failing provider and class. */

import type { ErrorGroupsReport, RecordedErrorGroup } from "@sr/shared";
import { buildChainMetaByIndex } from "@sr/shared";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { fmtComma } from "@/lib/format";
import { groupErrorWords, outcomeWords } from "@/lib/recorded-error-groups";
import { onRowKey } from "./request-log";

const CACHED = "Cached";

/** Who failed it, in a few words: the provider's name, the cache, or none. */
const providerWords = (g: RecordedErrorGroup) =>
  g.failingProvider === null ? "No provider" : g.failingProvider === CACHED ? "Cache" : g.failingProvider;

const NO_PROVIDER_HINT = "No try failed: the router refused or failed the request itself, before or without sending it to a provider.";

/** "No usable answer at node-a on Ethereum" - a group in one line. */
export function recordedGroupTitle(g: RecordedErrorGroup): string {
  const { label } = groupErrorWords(g);
  const at = g.failingProvider === null ? "" : ` at ${g.failingProvider === CACHED ? "the cache" : g.failingProvider}`;
  const on = g.spec ? ` on ${buildChainMetaByIndex(g.spec).name}` : "";
  return `${label}${at}${on}`;
}

/** A unix-seconds time with its date, as the loaded groups' span says it,
 *  unless the time before it (`after`) said the same day. */
function timeOn(sec: number, after?: number): string {
  const d = new Date(sec * 1000);
  const sameDay = after != null && new Date(after * 1000).toDateString() === d.toDateString();
  return d.toLocaleString("en-US", { ...(sameDay ? {} : { month: "short", day: "numeric" }), hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Above the list while one group is open: which, how many the counts hold, its minutes, and the way back - which takes the focus. */
export function RecordedGroupHeader({ group, backRef, onClose }: { group: RecordedErrorGroup; backRef?: React.Ref<HTMLButtonElement>; onClose: () => void }) {
  return (
    <div style={{ padding: "8px 16px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, fontSize: 12, flexWrap: "wrap" }}>
      <span style={{ color: "var(--text-3)" }}>One group:</span>
      <span style={{ color: "var(--text)", fontWeight: 600 }}>{recordedGroupTitle(group)}</span>
      <span className="gw-tnum" style={{ color: "var(--text-4)" }}>
        {fmtComma(group.count)} request{group.count === 1 ? "" : "s"} counted, {timeOn(group.from)} - {timeOn(group.to, group.from)}: the list reads their lines
      </span>
      <button ref={backRef} className="gw-btn" style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 11.5 }} onClick={onClose}>← All groups</button>
    </div>
  );
}

export function RecordedGroupsTable({ report, groups, windowLabel, hiddenRecovered, onShowRecovered, onOpen }: {
  report: ErrorGroupsReport;
  /** The groups the result pick keeps, most requests first. */
  groups: RecordedErrorGroup[];
  /** The page window's words ("12 hours"). */
  windowLabel: string;
  /** Recovered requests the opening pick hides, and how many groups they make. */
  hiddenRecovered: { count: number; groups: number };
  onShowRecovered: () => void;
  /** Lists a group's requests; absent when the router's logs can't be read. */
  onOpen?: (g: RecordedErrorGroup) => void;
}) {
  const { grid } = report;
  const axisFrom = grid.start - grid.stepSec;
  const shown = groups.reduce((n, g) => n + g.count, 0);
  const peak = Math.max(1, ...groups.flatMap((g) => g.buckets));
  return (
    <div>
      {/* What the groups cover, before anything else: the whole window, from the counts. */}
      <div style={{ padding: "9px 16px", borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--text-2)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>
          {fmtComma(shown)} request{shown === 1 ? "" : "s"} in {fmtComma(groups.length)} group{groups.length === 1 ? "" : "s"} over the last {windowLabel},
          {" "}from the recorded counts{report.partialFrom ? <> up to {timeOn(report.partialFrom, axisFrom)}</> : null}.
          {report.omitted.groups > 0 && (
            <> The {fmtComma(report.limit)} largest groups are listed: {fmtComma(report.omitted.groups)} more hold {fmtComma(report.omitted.count)} request{report.omitted.count === 1 ? "" : "s"}.</>
          )}
        </span>
      </div>
      <div className="gw-log-scroll">
        <table className="gw-table" style={{ tableLayout: "fixed", width: "100%", minWidth: 860 }}>
          <colgroup>
            <col style={{ width: "34%" }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 280 }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Error</th>
              <th>Failed at</th>
              <th style={{ textAlign: "right" }}>Requests</th>
              <th>When <span style={{ fontWeight: 400, color: "var(--text-4)", textTransform: "none", letterSpacing: 0 }}>{timeOn(axisFrom)} - {timeOn(report.asOf, axisFrom)}</span></th>
              <th>Client</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const open = () => onOpen?.(g);
              const words = groupErrorWords(g);
              const chain = g.spec ? buildChainMetaByIndex(g.spec).name : "chain not in the counts";
              // With a class, the outcome its requests share says what the client got; unclassified, the outcome is the label.
              const sub = words.unclassified ? chain : `${chain} · ${outcomeWords(g.outcome)}`;
              return (
                <tr key={g.key} data-group={g.key} {...(onOpen ? { tabIndex: 0, className: "gw-logrow", onClick: open, onKeyDown: onRowKey(open), title: "Show these requests" } : {})}>
                  <td style={{ maxWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      {g.spec && <span style={{ display: "flex", flexShrink: 0 }}><ChainBadge spec={g.spec} size={16} /></span>}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={words.label}>{words.label}</span>
                          {words.unclassified && (
                            <span className="gw-tag" title="The router names no class for this error yet: the group is its outcome at this provider." style={{ fontSize: 10, color: "var(--text-4)", borderColor: "currentColor", flexShrink: 0 }}>unclassified</span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ maxWidth: 0 }}>
                    <span className={g.failingProvider ? "gw-mono" : undefined} title={g.failingProvider ? undefined : NO_PROVIDER_HINT}
                      style={{ fontSize: 12, color: g.failingProvider ? "var(--text)" : "var(--text-3)" }}>{providerWords(g)}</span>
                  </td>
                  <td className="gw-tnum" style={{ textAlign: "right", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{fmtComma(g.count)}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 20, borderBottom: "1px solid var(--line)" }} aria-hidden>
                      {g.buckets.map((b, k) => (
                        <span key={k} style={{ flex: 1, height: b ? Math.max(3, Math.round((b / peak) * 20)) : 0, background: b ? "var(--text-3)" : "transparent", opacity: 0.7, borderRadius: 1 }} />
                      ))}
                    </div>
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text-2)" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: g.reachedClient ? "var(--err)" : "var(--ok)", flexShrink: 0 }} />
                      {g.reachedClient ? "Reached the client" : "Recovered"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hiddenRecovered.count > 0 && (
        <div style={{ padding: "9px 16px", fontSize: 12, color: "var(--text-2)", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ok)", flexShrink: 0 }} />
          Also {fmtComma(hiddenRecovered.count)} recovered request{hiddenRecovered.count === 1 ? "" : "s"} in {fmtComma(hiddenRecovered.groups)} group{hiddenRecovered.groups === 1 ? "" : "s"}: a provider failed and the router answered from another.
          <button className="gw-btn" style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 11.5 }} onClick={onShowRecovered}>Show them</button>
        </div>
      )}
    </div>
  );
}
