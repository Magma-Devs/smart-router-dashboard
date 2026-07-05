"use client";

/* DashHeader — the Dashboard page's sticky filter header, ported 1:1 from the
   design prototype (SR_Dashboard/magma/page-dashboard.jsx ~707-825).
   QUIRK ported as-is: `position: sticky; top: 52` (the prototype topbar is
   52px). The staff-only customer <select> is intentionally skipped; the
   identity block renders the self-hosted deployment identity instead.
   The Methods/Providers secondary filters are header-local chrome exactly as
   in the design (their state is never consumed by the charts). */

import { useState } from "react";
import { DshMultiSelect, type DshOption } from "./DshMultiSelect";
import { DshStatus } from "./DshStatus";
import { PocExportModal } from "./PocExportModal";

const WINS = ["1h", "3h", "24h", "7d", "Custom"];

/* Design's method-class filter vocabulary (verbatim). */
const ALL_METHODS: DshOption[] = [
  { id: "light", name: "Light reads" },
  { id: "heavy", name: "Heavy reads" },
  { id: "writes", name: "Writes" },
  { id: "traces", name: "Traces" },
  { id: "uncategorized", name: "Uncategorized" },
];

export function DashHeader({
  win,
  setWin,
  chains,
  setChains,
  chainOptions,
  providerOptions,
}: {
  win: string;
  setWin: (w: string) => void;
  chains: string[];
  setChains: (ids: string[]) => void;
  chainOptions: DshOption[];
  providerOptions: DshOption[];
}) {
  const [showFilter, setShowFilter] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [showPOC, setShowPOC] = useState(false);
  const [csStart, setCsStart] = useState(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  const [csEnd, setCsEnd] = useState(new Date().toISOString().slice(0, 10));
  const [methods, setMethods] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);

  const hasSecondary = methods.length > 0 || providers.length > 0;
  const isCustomWin = win.startsWith("custom:");

  function applyCustom() {
    setWin("custom:" + csStart + ":" + csEnd);
    setShowCustom(false);
  }
  function customLabel() {
    if (!isCustomWin) return "Custom";
    const pts = win.split(":");
    return pts[1] + " – " + pts[2];
  }

  return (
    <div style={{ position: "sticky", top: 52, zIndex: 90, flexShrink: 0, background: "var(--bg-2, rgba(255,255,255,0.03))", borderBottom: "1px solid var(--line)" }}>
      {/* Main row */}
      <div style={{ padding: "9px 24px", display: "flex", alignItems: "center", gap: 10, overflowX: "auto" }}>
        {/* Identity (self-hosted — the staff customer select is cloud-only) */}
        <div style={{ flexShrink: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>Smart Router</div>
          <div style={{ fontSize: 10, color: "var(--text-3)" }}>self-hosted</div>
        </div>
        <div style={{ width: 1, height: 24, background: "var(--line)", flexShrink: 0 }} />
        {/* Time window */}
        <div style={{ display: "flex", gap: 2, background: "var(--hover)", borderRadius: 6, padding: 2, flexShrink: 0 }}>
          {WINS.map((w) => {
            const active = w === "Custom" ? isCustomWin : win === w;
            return (
              <button key={w}
                onClick={() => { if (w === "Custom") setShowCustom(!showCustom); else setWin(w); }}
                style={{
                  padding: "2px 9px", borderRadius: 5, border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 500, fontFamily: "var(--font-ui)",
                  background: active ? "var(--bg)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-3)",
                  whiteSpace: "nowrap",
                }}>{w === "Custom" ? customLabel() : w}</button>
            );
          })}
        </div>
        {/* Chain multi-select */}
        <DshMultiSelect label="Chains" options={chainOptions} value={chains} onChange={setChains} />
        {/* + filter */}
        <button onClick={() => setShowFilter(!showFilter)} style={{
          display: "flex", alignItems: "center", gap: 4, padding: "4px 9px",
          fontSize: 11, fontWeight: 500,
          background: (showFilter || hasSecondary) ? "rgba(255,57,0,0.08)" : "transparent",
          border: "1px solid " + ((showFilter || hasSecondary) ? "rgba(255,57,0,0.25)" : "var(--line)"),
          borderRadius: 6, cursor: "pointer", fontFamily: "var(--font-ui)",
          color: (showFilter || hasSecondary) ? "var(--brand)" : "var(--text-3)",
        }}>{hasSecondary ? "✕ filters" : "+ filter"}</button>
        <div style={{ flex: 1 }} />
        <DshStatus />
        <button className="gw-btn gw-btn--primary"
          onClick={() => setShowPOC(true)}
          style={{ fontSize: 11, flexShrink: 0 }}>Export POC report</button>
      </div>
      {/* Custom date picker */}
      {showCustom && (
        <div style={{ padding: "8px 24px 10px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, background: "var(--hover)", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>Custom range</span>
          <input type="date" className="gw-input" value={csStart} max={csEnd}
            onChange={(e) => setCsStart(e.target.value)}
            style={{ fontSize: 11, padding: "3px 8px", width: "auto" }} />
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>→</span>
          <input type="date" className="gw-input" value={csEnd} min={csStart}
            onChange={(e) => setCsEnd(e.target.value)}
            style={{ fontSize: 11, padding: "3px 8px", width: "auto" }} />
          <button className="gw-btn gw-btn--primary" onClick={applyCustom} style={{ fontSize: 11, padding: "4px 12px" }}>Apply</button>
          <button className="gw-btn gw-btn--ghost" onClick={() => setShowCustom(false)} style={{ fontSize: 11, padding: "4px 10px" }}>Cancel</button>
        </div>
      )}
      {/* Secondary filters */}
      {showFilter && (
        <div style={{ padding: "8px 24px 10px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, background: "var(--hover)", flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>Filters</span>
          <DshMultiSelect label="Methods" options={ALL_METHODS} value={methods} onChange={setMethods} />
          <DshMultiSelect label="Providers" options={providerOptions} value={providers} onChange={setProviders} />
          {hasSecondary && (
            <button className="gw-btn gw-btn--ghost"
              onClick={() => { setMethods([]); setProviders([]); }}
              style={{ fontSize: 11, padding: "3px 9px", color: "var(--text-3)" }}>Clear</button>
          )}
        </div>
      )}
      {showPOC && <PocExportModal onClose={() => setShowPOC(false)} />}
    </div>
  );
}
