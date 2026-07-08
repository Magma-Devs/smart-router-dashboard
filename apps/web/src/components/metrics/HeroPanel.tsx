"use client";

/* HeroPanel — the six Metrics·Overview cards. Ported verbatim from the design
 * prototype (page-metrics.jsx HeroPanel); data is live
 * /api/metrics/dashboard-summary. Null Kpi values render "—" in the design's
 * muted colour with an honest sub-line — never an invented number. The
 * design's cache-derived "↓ Xms vs node-only" decoration needs a baseline the
 * router doesn't emit, so the p95 card shows the real value undecorated. */

import type { HeroSummary, MetricWindow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { Tip } from "@/components/gateway/Tip";
import { TT } from "@/lib/tooltips";
import { fmtNum } from "@/lib/format";

export function HeroPanel({ tw, spec }: { tw: MetricWindow; spec?: string | null }) {
  const { data } = useApi<HeroSummary>(
    `/api/metrics/dashboard-summary?window=${tw}${spec ? `&spec=${encodeURIComponent(spec)}` : ""}`,
  );

  const sr = data?.successRate.value ?? null;             // ratio 0..1
  const retries = data?.retriesRecovered.value ?? null;   // count (null until family fires)
  const cachePct = data?.cacheOffloadPct.value ?? null;   // ratio 0..1 (null until family fires)
  const reqServed = data?.requestsServed.value ?? null;
  const effP95 = data?.effectiveReadP95Ms.value ?? null;
  const stale = data?.staleCaught.value ?? null;
  const provCount = data?.upstreamCount ?? 0;

  const headline: {
    label: string;
    value: React.ReactNode;
    color: string;
    sub: React.ReactNode;
    tipKey: string;
  }[] = [
    { label: "Success rate", value: sr != null ? (sr * 100).toFixed(2) + "%" : "—", color: sr != null ? "var(--ok)" : "var(--text-4)",
      sub: <>&nbsp;</>, tipKey: "effectiveSR" },
    { label: "successful retries", value: retries != null ? fmtNum(retries) : "—", color: retries != null ? "var(--ok)" : "var(--text-4)",
      sub: retries != null ? <>recovered on retry — same or another endpoint</> : <>retry counters not emitted by this build yet</>, tipKey: "successfulRetries" },
    { label: "Cache offload", value: cachePct != null ? <>{Math.round(cachePct * 100)}%</> : "—", color: cachePct != null ? "#38bdf8" : "var(--text-4)",
      sub: cachePct != null ? <>of reads served from cache · {(cachePct * 100).toFixed(0)}% hit rate</> : <>cache not enabled on this build</>, tipKey: "cacheOffload" },
  ];

  const recovered: {
    label: string;
    display: React.ReactNode;
    tipKey: string;
    color: string;
    note: string;
  }[] = [
    { display: reqServed != null ? fmtNum(reqServed) : "—", label: "Requests served", tipKey: "reqServed", color: "var(--text-3)",
      note: "across " + provCount + " upstream" + (provCount === 1 ? "" : "s") },
    { display: effP95 != null
        ? <span style={{ color: "var(--ok)", display: "inline-flex", alignItems: "baseline", gap: 6 }}>{Math.round(effP95)} ms</span>
        : "—",
      label: "Effective read p95", tipKey: "effReadP95", color: "var(--ok)",
      note: data?.emitted.cache ? "includes cache-served reads" : "no cache on this build — node read p95" },
    { display: stale != null ? fmtNum(stale) : "—", label: "stale responses caught", tipKey: "staleDetected", color: "var(--warn)",
      note: "stale head replaced" },
  ];

  return (
    <div style={{ marginBottom: 14 }}>
      {/* headline value props */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 12 }}>
        {headline.map((h) => (
          <div key={h.label} className="gw-card" style={{ padding: "13px 16px" }}>
            <div style={{ display: "inline-flex", alignItems: "center", fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>
              {h.label}<Tip text={TT[h.tipKey]!} />
            </div>
            <div className="gw-tnum" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, color: h.color, marginTop: 7 }}>
              {h.value}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 6 }}>{h.sub}</div>
          </div>
        ))}
      </div>

      {/* operational counts — each an independent metric in its own card */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
        {recovered.map((s) => (
          <div key={s.label} className="gw-card" style={{ padding: "13px 16px" }}>
            <div style={{ display: "inline-flex", alignItems: "center", fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: s.color, flexShrink: 0, marginRight: 7 }} />
              {s.label}<Tip text={TT[s.tipKey]!} />
            </div>
            <div className="gw-tnum" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, marginTop: 7 }}>
              {s.display}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 6 }}>{s.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
