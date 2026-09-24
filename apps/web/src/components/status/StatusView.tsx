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
  StatusInsight,
  StatusReport,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-client";
import { ProvidersTab } from "./ProvidersTab";
import { IncidentsTab } from "./IncidentsTab";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { IssueCards } from "./IssueCards";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { WindowSelect } from "@/components/gateway/WindowSelect";

/** The three sections of the Issues tab - one tier each, in display order. */

type Tab = "issues" | "providers" | "incidents" | "insights";

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
    : paused && lastOk
      ? <>Paused <span className="gw-mono" style={{ color: "var(--text-3)" }}>· last {hhmmss(lastOk)}</span></>
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




/** One insight row: the number with its baseline, and the threshold's
 *  arithmetic one tap away. */
function InsightRow({ ins }: { ins: StatusInsight }) {
  const [why, setWhy] = useState(false);
  return (
    <div style={{ borderTop: "1px solid var(--line)", padding: "12px 18px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 11, alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <ChainBadge spec={ins.spec} size={15} />
            <span style={{ fontSize: 12.5, fontWeight: 650 }}>{ins.chainName}</span>
            {ins.upstream && (
              <>
                <span style={{ color: "var(--text-4)" }}>·</span>
                <span className="gw-mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>{ins.upstream}</span>
              </>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 4, lineHeight: 1.5, maxWidth: "76ch" }}>
            {ins.headline}
          </div>
          <button
            aria-expanded={why}
            onClick={(e) => { e.stopPropagation(); setWhy((w) => !w); }}
            style={{ background: "none", border: "none", padding: "6px 0", margin: "1px 0 -6px", cursor: "pointer",
              fontSize: 11, color: "var(--text-3)", fontFamily: "inherit", textDecoration: "underline dotted",
              textUnderlineOffset: 3 }}
          >
            {why ? "hide why" : "why this threshold"}
          </button>
          {why && (
            <div style={{ marginTop: 7, fontSize: 11, color: "var(--text-3)", lineHeight: 1.55,
              borderLeft: "2px solid var(--line-2)", paddingLeft: 10, maxWidth: "70ch" }}>
              {ins.basis}
            </div>
          )}
        </div>
        <div className="gw-mono gw-tnum" style={{ fontSize: 11, textAlign: "right", whiteSpace: "nowrap", color: "var(--text-3)" }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-2)", display: "block" }}>{ins.value}</span>
          {ins.baseline}
        </div>
      </div>
    </div>
  );
}

function Section({ title, note, color, count, children }: {
  title: string; note?: string; color: string; count?: number; children: React.ReactNode;
}) {
  return (
    <div className="gw-card" style={{ padding: 0, overflow: "hidden", marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 18px",
        background: "var(--bg-2)", borderBottom: "1px solid var(--line)" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <h2 style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: "-0.01em", margin: 0 }}>{title}</h2>
        {count != null && count > 0 && (
          <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-4)",
            border: "1px solid var(--line-2)", borderRadius: 9, padding: "0 6px" }}>{count}</span>
        )}
        {note && <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)", textAlign: "right" }}>{note}</span>}
      </div>
      {children}
    </div>
  );
}


export function StatusView() {
  const { timeWindow, setTimeWindow } = useFilters();
  const { data, error, isValidating, mutate } = useApi<StatusReport>(`/api/metrics/status?window=${timeWindow}`);
  // An SRE alt-tabbing back mid-incident needs a fresh read, not the last one
  // from before they left. useApi turns revalidateOnFocus off globally; this
  // page turns it back on by hand.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") void mutate(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [mutate]);
  const [nfOpen, setNfOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("issues");
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
  const insights = data?.insights ?? [];
  const noFailover = data?.noFailover ?? [];
  const insightCount = insights.length + (noFailover.length ? 1 : 0);

  const providerCount = new Set(findings.filter((f) => f.upstream && f.tier !== "config").map((f) => f.upstream)).size;
  const tabs: [Tab, string, number | null][] = [
    ["issues", "Issues", findings.length],
    ["providers", "Providers", providerCount],
    ["incidents", "Incidents", null],
    ["insights", "Insights", insightCount],
  ];

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

      <div role="tablist" aria-label="Status sections" style={{ display: "flex", borderBottom: "1px solid var(--line)", marginBottom: 16 }}>
        {tabs.map(([k, l, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{
            display: "inline-flex", alignItems: "center", gap: 7,
            padding: "8px 16px", border: "none", background: "transparent",
            fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            color: tab === k ? "var(--text)" : "var(--text-3)",
            borderBottom: tab === k ? "2px solid var(--brand)" : "2px solid transparent",
            marginBottom: -1, transition: "color 0.15s",
          }}>
            {l}
            {data && n != null && (
              <span className="gw-mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)",
                border: "1px solid var(--line-2)", borderRadius: 9, padding: "1px 6px" }}>{n}</span>
            )}
          </button>
        ))}
      </div>

      {/* ISSUES - one written issue per affected chain, in severity sections.
          The metric rows are gone: "38.9% errors - line 5%" is the
          measurement, and the gist is what the reader came for. The numbers
          live on the finding rows the issue cites. */}
      {tab === "issues" && (
        <IssueCards chainsAffected={[...new Set(findings.map((f) => f.chainName))]} />
      )}

      {/* PROVIDERS - one row per provider, verdict from the same findings. */}
      {tab === "providers" && <ProvidersTab findings={findings} timeWindow={timeWindow} />}

      {/* INCIDENTS - failure bursts of the last 24h, customer-ready. */}
      {tab === "incidents" && <IncidentsTab />}

      {/* INSIGHTS - standing posture. Every threshold explains itself. */}
      {tab === "insights" && (insights.length > 0 || noFailover.length > 0 ? (
        <Section title="Insights" color="var(--info)" count={insightCount}>
          {noFailover.length > 0 && (
            <div
              role="button" tabIndex={0} aria-expanded={nfOpen}
              onClick={() => setNfOpen((o) => !o)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setNfOpen((o) => !o); } }}
              style={{ cursor: "pointer", borderTop: "1px solid var(--line)" }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 11, padding: "12px 18px", alignItems: "start" }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 650 }}>
                    {noFailover.length} chain{noFailover.length === 1 ? " has" : "s have"} only one upstream configured
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 4, lineHeight: 1.5, maxWidth: "76ch" }}>
                    Primary or backup makes no difference when there is only one. If it fails, the chain is down until a second upstream is added.
                  </div>
                </div>
                <span aria-hidden="true" className="gw-mono" style={{ fontSize: 11, color: "var(--text-4)", paddingTop: 4 }}>{nfOpen ? "▾" : "▸"}</span>
              </div>
              {nfOpen && (
                <div style={{ padding: "2px 18px 14px 18px", borderTop: "1px dashed var(--line)" }}>
                  <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", fontSize: 12.5, margin: 0 }}>
                    {noFailover.map((c) => (
                      <div key={c.spec} style={{ display: "contents" }}>
                        <dt style={{ color: "var(--text-2)", fontWeight: 600, whiteSpace: "nowrap" }}>{c.name}</dt>
                        <dd style={{ margin: 0, color: "var(--text-3)" }}>{c.reason}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          )}
          {insights.map((i) => <InsightRow key={i.id} ins={i} />)}
        </Section>
      ) : (
        <div className="gw-card" style={{ padding: "14px 18px", fontSize: 12.5, color: "var(--text-3)" }}>
          {data ? "Nothing is drifting against its own history in this window." : "Checking…"}
        </div>
      ))}

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
