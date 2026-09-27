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
import type {
  StatusReport,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-client";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { IssueCards } from "./IssueCards";
import { WindowSelect } from "@/components/gateway/WindowSelect";

/** The three sections of the Issues tab - one tier each, in display order. */


/** Page visibility as an external store - SWR does not poll a hidden tab, and
 *  the freshness chip must know that. `resumedAt` is stamped each time the
 *  tab comes back so staleness is counted from then, not from the last read. */
const visibilityStore = { resumedAt: 0 };
function subscribeVisibility(onChange: () => void) {
  const handler = () => {
    if (document.visibilityState === "visible") visibilityStore.resumedAt = Date.now();
    onChange();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** The page proving it is alive - a chip beside the window selector. The dot
 *  carries the state (pulse = refreshing, amber = a read is late, red = the
 *  api is unreachable); the words stay neutral. Never green: a green dot next
 *  to "Updated" reads as "all good", which this page must never say. */
function Freshness({ lastOk, staleSec, refreshing, down, paused, promDown }: {
  lastOk: number | null; staleSec: number | null; refreshing: boolean; down: boolean; paused: boolean; promDown: boolean;
}) {
  const late = !down && !paused && staleSec != null && staleSec > 60;
  const dot = down ? "var(--err)" : late ? "var(--warn)" : "var(--text-3)";
  const label = down
    ? <>{promDown ? "Prometheus is not answering" : "Can\u2019t reach the api"}{lastOk ? <span className="gw-mono" style={{ color: "var(--text-3)" }}> · last {hhmmss(lastOk)}</span> : null}</>
    // "Paused" alone read as "monitoring stopped". It is this browser tab.
    : paused && lastOk
      ? <>Tab hidden, not refreshing <span className="gw-mono" style={{ color: "var(--text-3)" }}>· last {hhmmss(lastOk)}</span></>
      : lastOk
        ? <>Updated <span className="gw-mono">{hhmmss(lastOk)}</span>{late ? <span style={{ color: "var(--text-3)" }}> · {staleSec}s ago</span> : null}</>
        : "Checking…";
  return (
    <div role="status" aria-live="polite"
      title={down
        ? promDown
          ? "The dashboard is up, but its Prometheus did not answer - heavy windows can exceed the metrics server's own limits"
          : "A read failed, or the data is over two minutes old"
        : paused ? "Tab in background - polling resumes when visible" : refreshing ? "Refreshing…" : "The time the numbers were computed · polls every 15s"}
      style={{ height: 32, padding: "0 11px", borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--surface)",
        display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-2)", whiteSpace: "nowrap" }}>
      <span className={(refreshing || !lastOk) && !paused ? "gw-live-dot gw-live-dot--busy" : "gw-live-dot"} style={{ background: dot }} />
      <span>{label}</span>
    </div>
  );
}







export function StatusView() {
  const { timeWindow, setTimeWindow, scopeQ } = useFilters();
  const { data, error, isValidating, mutate } = useApi<StatusReport>(`/api/metrics/status?window=${timeWindow}${scopeQ}`);
  // An SRE alt-tabbing back mid-incident needs a fresh read, not the last one
  // from before they left. useApi turns revalidateOnFocus off globally; this
  // page turns it back on by hand.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") void mutate(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [mutate]);
  // "Checked at" is the page proving it is alive. With keepPreviousData a
  // dead api would otherwise leave a frozen report on screen indefinitely -
  // false calm is the one failure an incident page cannot afford.
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The api serves the last computed report instantly and refreshes behind
  // it, so the honest clock is the report's own stamp, not our receive time.
  useEffect(() => { if (data && !error) setLastOk(data.computedAtUnix ? data.computedAtUnix * 1000 : Date.now()); }, [data, error]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  // SWR does not poll a hidden tab. A tab that was not TRYING is not evidence
  // the api is down, so the staleness clock counts from the later of the last
  // good read and the moment the tab became visible again - the focus
  // revalidate above gets its ~10s to land before the chip turns red.
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
  const resumedAt = useSyncExternalStore(subscribeVisibility, () => visibilityStore.resumedAt, () => 0);
  const staleSec = lastOk == null ? null : Math.round((now - Math.max(lastOk, resumedAt)) / 1000);
  // Down = a read actually failed, OR the tab is visible and the DATA is old
  // past two minutes. The data's normal age is 15-45s (server cache + a slow
  // Prometheus read), so the amber line sits at 60s. Hidden + quiet is
  // "paused", not evidence of anything.
  const apiDown = !!error || (visible && staleSec != null && staleSec > 120);
  const paused = !visible && !error;
  // windowLabel / critical / byTier went with the metric rows — the written
  // issue carries its own window and its own severity now.
  const findings = data?.findings ?? [];
  // The badge counts what the cards render, by reading the same endpoint.
  // Deriving it from findings drifted twice — once when cards became
  // per-chain, again when caller-side chains merged into one — because a
  // second derivation of the same number is a second thing to keep in sync.
  const { data: issuesData } = useApi<{ ok: boolean; issues?: { status?: string }[] }>(
    `/api/ai/issues?window=${timeWindow}${scopeQ}`,
  );
  // Open issues only. Resolved ones stay on the page for the window they
  // were active in, under their own heading with their own count.
  const issueCount = issuesData?.ok
    ? (issuesData.issues?.filter((i) => i.status !== "resolved").length ?? null)
    : null;

  return (
    <div className="gw-page gw-metrics-inter" style={{ paddingBottom: 60 }}>
      <div className="gw-row" style={{ justifyContent: "space-between", marginBottom: 18, alignItems: "flex-start" }}>
        <h1>Status</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Freshness lastOk={lastOk} staleSec={staleSec} refreshing={isValidating} down={apiDown} paused={paused}
            promDown={error instanceof ApiError && error.statusCode === 503} />
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
        {data && issueCount != null && (
          <span className="gw-mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)",
            border: "1px solid var(--line-2)", borderRadius: 9, padding: "1px 6px" }}>{issueCount}</span>
        )}
      </div>

      <IssueCards chainsAffected={data ? [...new Set(findings.map((f) => f.chainName))] : null} />

      {data && !data.emitted && (
        <p style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 14, lineHeight: 1.5 }}>
          The router has not classified any errors yet on this build -{" "}
          <span className="gw-mono" style={{ color: "var(--text-2)" }}>smartrouter_errors_total</span>{" "}
          has never fired. Findings that depend on an error kind will appear the moment it does.
        </p>
      )}
    </div>
  );
}
