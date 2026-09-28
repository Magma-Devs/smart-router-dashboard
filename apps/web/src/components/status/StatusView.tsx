"use client";

/* StatusView - is this deployment healthy, and if not, what exactly is wrong.
 *
 * Built for the CUSTOMER's SRE, against two moments:
 *  1. "My logs show an error - show me it on this page in five seconds."
 *     The chain name, the timestamp, the error code and the count each have a
 *     string-matchable landing spot: headlines print the classified code,
 *     rows carry first/last-seen.
 *  2. "Now let me investigate." Rows expand to evidence, the router's own
 *     selection reasoning, and an instruction.
 *
 * Plus a standing INSIGHTS section - posture, not fires - where every
 * threshold ships with the arithmetic behind it ("why this threshold"),
 * because a number the customer cannot interrogate is a number they will not
 * trust.
 *
 * Never reports successes. No green checkmarks; the CHAINS table states
 * "no rule crossed" or "not enough traffic to judge", never "operational".
 *
 * Colour rule - ONE colour per row, carried by ONE element. The tier lives
 * on the section (its header dot + name) and is echoed by the row's dot;
 * nothing else on a row is tinted: no tier badge, no red "still happening",
 * no blue links. Three sections, one tier each - Critical / Degraded /
 * Config - so a row never has to say its own tier. A first version put a
 * dot, a filled badge, a red timeline and a coloured link on every row and
 * read as noise; the tier was encoded four times and the headline got lost. */

import { useEffect, useState, useSyncExternalStore } from "react";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { IssueCards } from "./IssueCards";
import { WindowSelect } from "@/components/gateway/WindowSelect";

/** What the page reads: the issue log, filtered to the window by the api. */
interface IssuesRead {
  ok: boolean;
  warming?: boolean;
  /** Why there are no issues to show: AI is off, or needs sign-in. */
  reason?: string;
  /** When the last background check finished. */
  computedAtUnix?: number;
  classified?: boolean;
  issues?: { status?: string }[];
}

/**
 * The background check runs every 5 minutes and can take a few. Past three
 * missed runs the chip turns amber; past six, red — the checks have stopped,
 * which is usually Prometheus or the log store not answering.
 */
const LATE_SEC = 15 * 60;
const STOPPED_SEC = 30 * 60;

/** Page visibility as an external store - SWR does not poll a hidden tab, and
 *  the freshness chip must know that. */
function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** The page proving it is alive - a chip beside the window selector. The dot
 *  carries the state (pulse = checking, amber = checks are late, red = they
 *  stopped or the api is unreachable); the words stay neutral. Never green: a
 *  green dot next to "Last check" reads as "all good", which this page must
 *  never say. */
function Freshness({ lastOk, ageSec, refreshing, unreachable, paused }: {
  lastOk: number | null; ageSec: number | null; refreshing: boolean; unreachable: boolean; paused: boolean;
}) {
  const stopped = !unreachable && ageSec != null && ageSec > STOPPED_SEC;
  const late = !unreachable && !stopped && ageSec != null && ageSec > LATE_SEC;
  const dot = unreachable || stopped ? "var(--err)" : late ? "var(--warn)" : "var(--text-3)";
  const ago = ageSec != null ? `${Math.round(ageSec / 60)} min ago` : "";
  const label = unreachable
    ? <>Can\u2019t reach the api{lastOk ? <span className="gw-mono" style={{ color: "var(--text-3)" }}> · last check {hhmm(lastOk)}</span> : null}</>
    : !lastOk
      ? "Checking…"
      : stopped
        ? <>Checks have stopped <span className="gw-mono" style={{ color: "var(--text-3)" }}>· last {hhmm(lastOk)}, {ago}</span></>
        : <>Last check <span className="gw-mono">{hhmm(lastOk)}</span>{late ? <span style={{ color: "var(--text-3)" }}> · {ago}</span> : null}</>;
  return (
    <div role="status" aria-live="polite"
      title={unreachable
        ? "The page could not reach the api"
        : stopped
          ? "The background check has not finished in 30 minutes - Prometheus or the log store may not be answering"
          : paused
            ? "Tab in background - the page reads again when it is visible"
            : "When the issues were last checked · the api checks every 5 minutes, in the background"}
      style={{ height: 32, padding: "0 11px", borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--surface)",
        display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-2)", whiteSpace: "nowrap" }}>
      <span className={(refreshing || !lastOk) && !paused ? "gw-live-dot gw-live-dot--busy" : "gw-live-dot"} style={{ background: dot }} />
      <span>{label}</span>
    </div>
  );
}

export function StatusView() {
  const { timeWindow, setTimeWindow, scopeQ } = useFilters();
  // ONE read: the issue log, which the api keeps current in the background
  // and filters to the window in a millisecond. The page used to ask
  // Prometheus for a whole report over the window as well — for 7 days on a
  // large deployment that ran four minutes and ended in a 504, and the cards
  // never needed it. The same key as the cards', so it is one request.
  const { data, error, isValidating, mutate } = useApi<IssuesRead>(`/api/ai/issues?window=${timeWindow}${scopeQ}`);
  // An SRE alt-tabbing back mid-incident needs a fresh read, not the last one
  // from before they left. useApi turns revalidateOnFocus off globally; this
  // page turns it back on by hand.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") void mutate(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [mutate]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
  // The honest clock is the check's own stamp, not when this browser read it:
  // a page that keeps reading an api whose checks have stopped must say so.
  const lastOk = data?.ok && data.computedAtUnix ? data.computedAtUnix * 1000 : null;
  const ageSec = lastOk == null ? null : Math.max(0, Math.round((now - lastOk) / 1000));
  // AI off, or needing sign-in: the cards say which, and a clock over
  // nothing would only read as "stuck".
  const refused = data != null && !data.ok && !data.warming;
  // Open issues only. Resolved ones stay on the page for the window they
  // were active in, under their own heading with their own count.
  const issueCount = data?.ok ? (data.issues?.filter((i) => i.status !== "resolved").length ?? null) : null;

  return (
    <div className="gw-page gw-metrics-inter" style={{ paddingBottom: 60 }}>
      <div className="gw-row" style={{ justifyContent: "space-between", marginBottom: 18, alignItems: "flex-start" }}>
        <h1>Status</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!refused && (
            <Freshness lastOk={lastOk} ageSec={ageSec} refreshing={isValidating} unreachable={!!error} paused={!visible && !error} />
          )}
          <WindowSelect value={timeWindow} onChange={setTimeWindow} />
        </div>
      </div>

      {/* One section. Live incidents was folded in: a burst of failed
          customer requests — the alert's own test — opens or updates that
          chain's issue, so whenever the alert fires, there is an issue here.
          The count is the OPEN issues on screen, not the findings behind
          them: a badge that disagrees with what is under it is the page
          arguing with itself. */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, borderBottom: "1px solid var(--line)", paddingBottom: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Issues</span>
        {issueCount != null && (
          <span className="gw-mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)",
            border: "1px solid var(--line-2)", borderRadius: 9, padding: "1px 6px" }}>{issueCount}</span>
        )}
      </div>

      <IssueCards />

      {data?.ok && data.classified === false && (
        <p style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 14, lineHeight: 1.5 }}>
          The router has not classified any errors yet on this build -{" "}
          <span className="gw-mono" style={{ color: "var(--text-2)" }}>smartrouter_errors_total</span>{" "}
          has never fired. Findings that depend on an error kind will appear the moment it does.
        </p>
      )}
    </div>
  );
}
