"use client";

/* ADD SHEET — Step 1 (entry type) + Step 2 (pick preset).
 * Ported verbatim from the design prototype (page-providers.jsx
 * Step1EntryType + StepPickPreset). */

import { useState } from "react";
import { UpstreamLogo } from "@/components/upstreams/UpstreamLogo";
import { UPSTREAM_CATALOG, type UpstreamCatalogEntry } from "@/components/upstreams/catalog";

export type EntryType = "UPSTREAM" | "URL" | "JWT";

export function Step1EntryType({ onPick }: { onPick: (t: EntryType) => void }) {
  const items: { id: EntryType; icon: React.ReactNode; label: string; caption: string }[] = [
    {
      id: "UPSTREAM",
      icon: (
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", width: 44, justifyContent: "center" }}>
          {(["alchemy", "infura", "quicknode", "ankr"] as const).map((id) => (
            <UpstreamLogo key={id} id={id} size={16} />
          ))}
        </div>
      ),
      label: "Upstream preset",
      caption: "Alchemy, Infura, QuickNode and more — paste your API key and you're done.",
    },
    {
      id: "URL",
      icon: (
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
      ),
      label: "Custom URL",
      caption: "Your own node, a private cluster, or any upstream not listed above.",
    },
    {
      id: "JWT",
      icon: (
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>
        </svg>
      ),
      label: "JWT",
      caption: "Token-based auth — paste a pre-issued JWT or let us mint one per request from your signing key.",
    },
  ];
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {items.map((item) => (
        <button key={item.id} onClick={() => onPick(item.id)} style={{
          display: "flex", alignItems: "center", gap: 16, padding: "16px 18px", borderRadius: 10,
          border: "1px solid var(--line)", background: "var(--bg)", cursor: "pointer",
          textAlign: "left", width: "100%", fontFamily: "inherit", transition: "border-color 0.12s, background 0.12s",
        }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--line-2)"; e.currentTarget.style.background = "var(--hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.background = "var(--bg)"; }}>
          <div style={{ width: 50, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{item.icon}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>{item.label}</div>
            <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.5 }}>{item.caption}</div>
          </div>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────
   ADD SHEET — Step 2 (UPSTREAM): pick preset
───────────────────────────────────────────── */
export function StepPickPreset({ existingIds, onPick }: { existingIds: string[]; onPick: (cat: UpstreamCatalogEntry) => void }) {
  const [search, setSearch] = useState("");
  const filtered = UPSTREAM_CATALOG.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ position: "relative" }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input className="gw-input" type="search" placeholder="Search upstreams…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 32 }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8 }}>
        {filtered.map((cat) => {
          const disabled = existingIds.includes(cat.id);
          return (
            <button key={cat.id} disabled={disabled} onClick={() => onPick(cat)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderRadius: 10,
                border: "1px solid var(--line)", background: disabled ? "transparent" : "var(--bg)",
                cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
                fontFamily: "inherit", transition: "border-color 0.1s, background 0.1s", width: "100%", textAlign: "left", position: "relative" }}
              onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.borderColor = "var(--line-2)"; e.currentTarget.style.background = "var(--hover)"; } }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.background = disabled ? "transparent" : "var(--bg)"; }}>
              <UpstreamLogo id={cat.id} size={28} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{cat.name}</span>
              {disabled && <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--text-4)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>connected</span>}
            </button>
          );
        })}
      </div>
      {!filtered.length && <div style={{ textAlign: "center", padding: "20px 0", color: "var(--text-3)", fontSize: 13 }}>No upstreams match &quot;{search}&quot;</div>}
    </div>
  );
}
