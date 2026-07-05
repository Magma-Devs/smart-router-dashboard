"use client";

/* TroubleDetail — port of the design prototype's TroubleDetail flyout
   (SR_Dashboard/magma/page-dashboard.jsx ~1077-1129). Opens from a trouble
   row on the Metrics tab. This build has no per-(chain, client) series
   family, so the two mini charts render the design's empty chart body
   (muted "—") instead of the prototype's seeded mock series. */

import { buildChainMetaByIndex, type DashboardTroubleRow } from "@sr/shared";
import { DSHNoData, dshFmtComma } from "./bits";

export function TroubleDetail({
  item,
  onClose,
}: {
  item: DashboardTroubleRow;
  win: string;
  onClose: () => void;
}) {
  const ch = buildChainMetaByIndex(item.chain);
  const ratio = item.baselineRatio;
  const rc = ratio == null ? "var(--text-4)" : ratio < 1 ? "var(--ok)" : ratio < 1.5 ? "var(--warn)" : "var(--err)";
  const stats = [
    {
      label: "Failover",
      value: item.failoverPct != null ? item.failoverPct + "%" : "—",
      color: item.failoverPct != null && item.failoverPct > 25 ? "var(--warn)" : "var(--text)",
    },
    {
      label: "SR",
      value: item.sr != null ? item.sr.toFixed(2) + "%" : "—",
      color: item.sr == null ? "var(--text-4)" : item.sr < 99 ? "var(--err)" : "var(--ok)",
    },
    {
      label: "P95",
      value: item.p95 != null ? item.p95 + " ms" : "—",
      color: rc,
    },
  ];
  return (
    <div style={{ position: "fixed", top: 52, right: 0, bottom: 0, width: 380, zIndex: 150,
      background: "var(--bg)", borderLeft: "1px solid var(--line)", overflowY: "auto",
      display: "flex", flexDirection: "column", boxShadow: "-4px 0 24px rgba(0,0,0,0.35)" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{ch.name || item.chain} · {item.client}</div>
          <div style={{ fontSize: 10, color: "var(--text-3)" }}>(chain, client) detail</div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", padding: 4, lineHeight: 1 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {stats.map((s) => (
            <div key={s.label} style={{ background: "var(--hover)", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 9, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 16, fontWeight: 500, fontFamily: "var(--font-mono)", color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-2)", marginBottom: 6 }}>Success Rate</div>
          {/* No per-pair series family on this build — honest empty body. */}
          <DSHNoData height={100} />
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-2)", marginBottom: 6 }}>
            P95 · baseline{" "}
            {ratio != null
              ? <span style={{ color: rc, fontFamily: "var(--font-mono)" }}>{ratio.toFixed(2)}×</span>
              : <span style={{ color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>—</span>}
          </div>
          <DSHNoData height={100} />
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-2)", marginBottom: 8 }}>Providers on this pair</div>
          {item.providers.map((p) => {
            const isInt = p.toLowerCase().includes("self");
            return (
              <div key={p} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
                <span style={{ fontSize: 11, color: "var(--text-2)", flex: 1 }}>{p}</span>
                <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, fontWeight: 600, background: isInt ? "rgba(96,165,250,0.12)" : "rgba(251,146,60,0.12)", color: isInt ? "#60a5fa" : "#fb923c" }}>{isInt ? "Internal" : "Fallback"}</span>
              </div>
            );
          })}
          {item.failoverCount != null && (
            <div style={{ fontSize: 10, color: "var(--text-4)", marginTop: 4 }}>{dshFmtComma(item.failoverCount)} failover events</div>
          )}
        </div>
        <button className="gw-btn gw-btn--ghost" style={{ fontSize: 12 }} onClick={onClose}>Filter dashboard to this pair →</button>
      </div>
    </div>
  );
}
