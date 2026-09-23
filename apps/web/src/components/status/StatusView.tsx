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
import { WINDOWS, type MetricWindow } from "@sr/shared";
import type {
  StatusFinding,
  StatusInsight,
  StatusReport,
  StatusTier,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-client";
import { errorDocsUrl, errorMeaning } from "@/lib/error-docs";
import { fullLogsHref, useGrafanaUrl } from "@/components/gateway/RouterHeader";
import { fmtComma } from "@/lib/format";
import { ProvidersTab } from "./ProvidersTab";
import { IncidentsTab } from "./IncidentsTab";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { BriefPanel } from "./BriefPanel";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { WindowSelect } from "@/components/gateway/WindowSelect";

/** The three sections of the Issues tab - one tier each, in display order. */
const TIER: Record<StatusTier, { label: string; color: string }> = {
  critical: { label: "Critical", color: "var(--err)" },
  attention: { label: "Degraded", color: "var(--warn)" },
  config: { label: "Config", color: "var(--info)" },
};
const TIER_ORDER: StatusTier[] = ["critical", "attention", "config"];

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

const hhmm = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const hhmmss = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
/** Minutes past 90 read as hours; past 48h as days. "at least 43200 min" is a
 *  real string a 30d window produced. */
const dur = (sec: number) => {
  const m = Math.round(sec / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(sec / 3600);
  if (h < 48) return `${h} h`;
  return `${Math.round(sec / 86400)} d`;
};

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

interface ErrorGroupRow {
  count: number;
  lastAtUnix: number;
  errorName: string | null;
  methods: string[];
  method: string | null;
  example: string;
}

/** Top error shapes for this finding, from the router's logs - deduplicated,
 *  biggest first. One example line carries the searchable detail; the full
 *  stream stays in Grafana. Absent Loki, the section does not render. */
function RecentErrors({ spec, upstream, code }: { spec: string; upstream: string | null; code?: string }) {
  const { data } = useApi<{ available: boolean; sampled: number; groups: ErrorGroupRow[] }>(
    `/api/metrics/errors/recent?spec=${encodeURIComponent(spec)}${upstream ? `&upstream=${encodeURIComponent(upstream)}` : ""}${code ? `&code=${encodeURIComponent(code)}` : ""}`,
    60000,
  );
  if (!data) return <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 8 }}>Reading the logs…</div>;
  if (!data.available || data.groups.length === 0) return null;
  // Largest-remainder rounding: the displayed shares must sum to 100, and the
  // tail outside the top groups is shown as "other" - independently rounded
  // percentages read as a mistake ("98% + 3%").
  const counts = data.groups.map((g) => g.count);
  const otherCount = Math.max(0, data.sampled - counts.reduce((a, b) => a + b, 0));
  if (otherCount > 0) counts.push(otherCount);
  const raw = counts.map((c) => (c / data.sampled) * 100);
  const shares = raw.map(Math.floor);
  let left = 100 - shares.reduce((a, b) => a + b, 0);
  [...raw.keys()].sort((a, b) => (raw[b]! - shares[b]!) - (raw[a]! - shares[a]!)).forEach((i) => {
    if (left > 0) { shares[i]! += 1; left -= 1; }
  });
  return (
    <>
      <div style={{ fontSize: 11, color: "var(--text-4)", margin: "12px 0 4px" }}>
        {data.sampled === 1 ? "the one logged error · 24h" : `breakdown of the last ${fmtComma(data.sampled)} logged errors · 24h`}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto auto auto 1fr", gap: "4px 12px", fontSize: 11 }}>
        {data.groups.map((g, i) => (
          <div key={i} style={{ display: "contents" }}>
            <span className="gw-mono gw-tnum" style={{ color: "var(--text-2)", fontWeight: 700, textAlign: "right" }}>{shares[i]}%</span>
            <span className="gw-mono" style={{ color: "var(--text-4)" }}>last {hhmm(g.lastAtUnix)}</span>
            <span className="gw-mono" style={{ color: "var(--text-3)" }}>{g.errorName ?? g.method ?? "-"}</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }}
                title={`seen ${g.count}x - ${g.example}`}>{g.example}</span>
              {/* The cause in plain words, plus where it hit - the method is
                  detail here, never what splits a fault into rows. */}
              <span style={{ display: "block", color: "var(--text-4)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {g.errorName ? errorMeaning(g.errorName) : ""}
                {g.methods.length > 0 && (
                  <span className="gw-mono"> · {g.methods[0]}{g.methods.length > 1 ? ` +${g.methods.length - 1} more` : ""}</span>
                )}
              </span>
            </span>
          </div>
        ))}
        {otherCount > 0 && (
          <div style={{ display: "contents" }}>
            <span className="gw-mono gw-tnum" style={{ color: "var(--text-4)", textAlign: "right" }}>{shares[shares.length - 1]}%</span>
            <span /><span />
            <span style={{ color: "var(--text-4)", fontSize: 12.5 }}>other ({fmtComma(otherCount)} lines)</span>
          </div>
        )}
      </div>
    </>
  );
}

function Row({ f, windowLabel, timeWindow }: { f: StatusFinding; windowLabel: string; timeWindow: MetricWindow }) {
  const [open, setOpen] = useState(false);
  const grafana = useGrafanaUrl();
  return (
    <div
      id={`finding-${f.spec}`}
      role="button" tabIndex={0} aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
      style={{ borderTop: "1px solid var(--line)", cursor: "pointer", scrollMarginTop: 80 }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 11, padding: "13px 18px", alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <ChainBadge spec={f.spec} size={15} />
            <span style={{ fontSize: 14, fontWeight: 650 }}>{f.chainName}</span>
            {f.upstream && (
              <>
                <span style={{ color: "var(--text-4)" }}>·</span>
                <span className="gw-mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>{f.upstream}</span>
              </>
            )}
            {f.role && (
              <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 700,
                border: "1px solid var(--line-2)", color: "var(--text-4)", borderRadius: 3, padding: "0 4px" }}>{f.role}</span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 4, lineHeight: 1.55 }}>
            {f.headline}
            {f.reference && (
              <span style={{ color: "var(--text-4)", marginLeft: 7 }}>· {f.reference}</span>
            )}
            {/* The grep bridge: the router's logs print these same codes, so
                the code the SRE searched must be legible on the COLLAPSED row -
                the same chip the expanded state uses, not a faint parenthetical. */}
            {f.codes.length > 0 && (
              <span className="gw-mono" style={{ fontSize: 11, marginLeft: 7, background: "var(--bg-2)",
                border: "1px solid var(--line-2)", borderRadius: 4, padding: "1px 6px", color: "var(--text-2)",
                whiteSpace: "nowrap" }}>{f.codes[0]}</span>
            )}
          </div>
        </div>
        {/* Status + timeframe, prominent: ONGOING/RESOLVED with when - the
            two things the SRE lines up against their own logs first. */}
        <div style={{ textAlign: "right", whiteSpace: "nowrap", paddingTop: 2 }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 800,
            color: f.ongoing === true ? "var(--text)" : "var(--text-3)", display: "block" }}>
            {f.ongoing === true ? "ongoing" : f.ongoing === false ? "resolved" : `last ${windowLabel}`}
          </span>
          <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
            {f.firstSeenUnix != null
              ? f.ongoing === false && f.lastSeenUnix != null
                ? `${hhmm(f.firstSeenUnix)} - ${hhmm(f.lastSeenUnix)}`
                : `since ${hhmm(f.firstSeenUnix)}`
              : null}
            <span aria-hidden="true" style={{ fontSize: 11, color: "var(--text-4)", marginLeft: 6 }}>{open ? "▾" : "▸"}</span>
          </span>
        </div>
      </div>

      {open && (
        <div style={{ padding: "4px 18px 16px", borderTop: "1px dashed var(--line)", fontSize: 12.5 }}>
          {/* With codes the evidence sits right of them; without codes a
              right-aligned block floats over a void - one inline line then. */}
          {f.codes.length === 0 && f.evidence.length > 0 && (
            <div style={{ marginTop: 10, color: "var(--text-3)", fontSize: 12.5 }}>
              {f.evidence.map((e, i) => (
                <span key={e.k}>
                  {i > 0 && <span style={{ color: "var(--text-4)" }}> · </span>}
                  <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-4)" }}>{e.k}</span>{" "}
                  <span className="gw-tnum" style={{ color: "var(--text-2)" }}>{e.v}</span>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginTop: 10 }}>
          {f.codes.length > 0 ? (
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 12px", margin: 0 }}>
              {f.codes.map((c) => (
                <div key={c} style={{ display: "contents" }}>
                  <dt>
                    <a href={errorDocsUrl(c)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                      className="gw-mono" style={{ fontSize: 11, background: "var(--bg-2)", border: "1px solid var(--line)",
                      borderRadius: 4, padding: "2px 7px", color: "var(--text-2)", textDecoration: "none", whiteSpace: "nowrap" }}>{c}</a>
                  </dt>
                  <dd style={{ margin: 0, color: "var(--text-3)", lineHeight: 1.5 }}>
                    {f.codeCounts?.[c] != null && f.codeCounts[c] > 0 && (
                      <b className="gw-mono gw-tnum" style={{ color: "var(--text-2)", fontWeight: 700, marginRight: 7 }}>
                        {fmtComma(f.codeCounts[c])}<span style={{ fontWeight: 400, color: "var(--text-4)" }}> reached a caller</span>
                      </b>
                    )}
                    {errorMeaning(c)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : <span />}
          {f.codes.length > 0 && f.evidence.length > 0 && (
            <div style={{ textAlign: "right", color: "var(--text-3)", flexShrink: 0 }}>
              {f.evidence.map((e) => (
                <div key={e.k}>
                  <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-4)" }}>{e.k}</span>{" "}
                  <span className="gw-tnum" style={{ color: "var(--text-2)" }}>{e.v}</span>
                </div>
              ))}
            </div>
          )}
          </div>
          <RecentErrors spec={f.spec} upstream={f.upstream} code={f.codes.length === 1 ? f.codes[0] : undefined} />
          <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-2)" }}>
              →{" "}
              {f.remedy.split("**").map((part, i) =>
                i % 2 ? <b key={i} style={{ color: "var(--text)" }}>{part}</b> : <span key={i}>{part}</span>,
              )}
            </span>
            <a href={fullLogsHref(grafana, timeWindow, f.spec)} target="_blank" rel="noreferrer"
              onClick={(e) => e.stopPropagation()} title="Opens Grafana on this chain and window"
              style={{ fontSize: 11, color: "var(--text-3)", textDecoration: "underline dotted", textUnderlineOffset: 3, whiteSpace: "nowrap" }}>
              logs ↗
            </a>
          </div>
        </div>
      )}
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
  const { data, error, isLoading, isValidating, mutate } = useApi<StatusReport>(`/api/metrics/status?window=${timeWindow}`);
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
  const windowLabel = WINDOWS[timeWindow]?.label ?? timeWindow;

  const findings = data?.findings ?? [];
  const critical = findings.filter((f) => f.tier === "critical");
  const byTier = (t: StatusTier) => findings.filter((f) => f.tier === t);
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

      {tab === "issues" && (<>
        <BriefPanel />
      <Section title="Critical"
        color={apiDown ? "var(--err)" : critical.length ? "var(--err)" : isLoading && !data ? "var(--text-4)" : "var(--text-3)"}
        count={critical.length}>
        {/* Three states, never one: "not measured" must not look like "nothing
            wrong". No green here either - the page's own rule. */}
        {apiDown && !data ? (
          <div style={{ padding: "14px 18px", fontSize: 12.5, color: "var(--err)" }}>
            Could not reach the dashboard api - nothing on this page is measured right now.
          </div>
        ) : isLoading && !data ? (
          <div style={{ padding: "14px 18px", fontSize: 12.5, color: "var(--text-4)" }}>Checking…</div>
        ) : critical.length ? (
          critical.map((f) => <Row key={f.id} f={f} windowLabel={windowLabel} timeWindow={timeWindow} />)
        ) : (
          <div style={{ padding: "14px 18px", fontSize: 12.5, color: "var(--text-3)" }}>
            Nothing critical in this window.
          </div>
        )}
      </Section>

      {/* Degraded, then Config - each its own section so no row carries a tier
          label. Absent when empty: an empty "Degraded" card is wallpaper.
          "Only one provider available" collapses into a single expandable row
          past two chains - on a one-primary-everywhere deployment it is true
          for most of the fleet, and 23 copies of one sentence hide the rows
          that differ. */}
      {TIER_ORDER.filter((t) => t !== "critical").map((t) => {
        const rows = byTier(t);
        if (rows.length === 0) return null;
        return (
          <Section key={t} title={TIER[t].label} color={TIER[t].color} count={rows.length}>
            {rows.map((f) => <Row key={f.id} f={f} windowLabel={windowLabel} timeWindow={timeWindow} />)}
          </Section>
        );
      })}
      </>)}

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
