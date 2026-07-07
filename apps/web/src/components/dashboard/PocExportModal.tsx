"use client";

/* PocExportModal — ported 1:1 from the design prototype's POCExportModal
   (SR_Dashboard/magma/page-dashboard.jsx ~641-704). The export itself is the
   design's POC stub (busy spinner, then close) — no backend endpoint yet. */

import { useState } from "react";
import { DSHChip } from "./bits";

export function PocExportModal({ onClose }: { onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [start, setStart] = useState(thirtyAgo);
  const [end, setEnd] = useState(today);
  const [narr, setNarr] = useState("");
  const [fmt, setFmt] = useState("PDF");
  const [busy, setBusy] = useState(false);
  function doExport() {
    setBusy(true);
    setTimeout(() => { setBusy(false); onClose(); }, 1400);
  }
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.72)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 12,
        width: 460, padding: "24px", display: "flex", flexDirection: "column", gap: 18,
        boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Export POC Report</div>
            <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3 }}>Before/After summary for your CTO.</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", padding: 4, lineHeight: 1, flexShrink: 0 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={{ fontSize: 10, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 600 }}>POC start</label>
            <input type="date" className="gw-input" value={start} max={end}
              onChange={(e) => setStart(e.target.value)} style={{ fontSize: 12 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={{ fontSize: 10, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 600 }}>POC end</label>
            <input type="date" className="gw-input" value={end} min={start}
              onChange={(e) => setEnd(e.target.value)} style={{ fontSize: 12 }} />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={{ fontSize: 10, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 600 }}>Narrative <span style={{ color: "var(--text-4)", textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
          <textarea className="gw-input" rows={3} value={narr}
            onChange={(e) => setNarr(e.target.value)}
            placeholder="Add a closing note for the CTO — what went well, what to highlight…"
            style={{ resize: "vertical", fontSize: 12, lineHeight: 1.55 }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 10, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 600 }}>Format</label>
          <DSHChip options={["PDF", "Markdown"]} value={fmt} onChange={setFmt} />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          <button className="gw-btn gw-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="gw-btn gw-btn--primary" onClick={doExport} disabled={busy}>
            {busy ? "Generating…" : "Export " + fmt}
          </button>
        </div>
      </div>
    </div>
  );
}
