"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChainBadge } from "./ChainBadge";

/* Ported verbatim from the design prototype (page-overview.jsx ChainSelect);
   chains are keyed by Prometheus `spec` label instead of the mock's `id`. */

export interface ChainOption {
  spec: string;
  name: string;
  color: string;
  /** Offered but dimmed — the page can show little or nothing for it. */
  muted?: boolean;
  /** Why it's dimmed, shown after the name (e.g. "no traffic yet"). */
  hint?: string;
}

export interface ChainSelectProps {
  /** "all" or a spec label. */
  value: string;
  onChange: (v: string) => void;
  /** Any order — the list is sorted by chain name for display. */
  chains: ChainOption[];
}

export function ChainSelect({ value, onChange, chains: unsorted }: ChainSelectProps) {
  /* Alphabetical by name, ascending. The callers' own orders are meaningless
     to someone hunting for a chain: the metrics list arrives in whatever order
     Prometheus returns its label values, the config list in the order the
     values file happens to declare its routers. */
  const chains = useMemo(
    () => [...unsorted].sort((a, b) => a.name.localeCompare(b.name)),
    [unsorted],
  );
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const cur = value === "all" ? null : chains.find((c) => c.spec === value);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} style={{ height: 32, padding: "0 9px", borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--surface)", color: "var(--text)", fontSize: 12, fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}>
        {cur
          ? <ChainBadge spec={cur.spec} size={16} />
          : <span style={{ display: "inline-flex", gap: 1.5 }}>
              {chains.slice(0, 3).map((c) => <span key={c.spec} style={{ width: 4, height: 9, borderRadius: 1, background: c.color }} />)}
            </span>}
        <span>{cur ? cur.name : "All chains"}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 120, minWidth: 180, padding: 4, borderRadius: 9, background: "var(--surface-2)", border: "1px solid var(--line-2)", boxShadow: "0 10px 30px rgba(0,0,0,0.5)", maxHeight: 300, overflowY: "auto" }}>
          <button onClick={() => { onChange("all"); setOpen(false); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 6, border: "none", background: value === "all" ? "var(--hover)" : "transparent", color: "var(--text)", fontSize: 12, fontFamily: "inherit", cursor: "pointer", textAlign: "left" }}>
            <span style={{ display: "inline-flex", gap: 1.5 }}>{chains.slice(0, 3).map((c) => <span key={c.spec} style={{ width: 4, height: 10, borderRadius: 1, background: c.color }} />)}</span>
            All chains
          </button>
          {chains.map((c) => (
            <button key={c.spec} onClick={() => { onChange(c.spec); setOpen(false); }} title={c.hint} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 6, border: "none", background: value === c.spec ? "var(--hover)" : "transparent", color: c.muted ? "var(--text-3)" : "var(--text)", fontSize: 12, fontFamily: "inherit", cursor: "pointer", textAlign: "left" }}>
              <ChainBadge spec={c.spec} size={16} />
              <span style={{ opacity: c.muted ? 0.75 : 1 }}>{c.name}</span>
              {/* A chain this page can't populate is still selectable — dimmed
                  and labelled beats hidden, which reads as "not configured". */}
              {c.hint && (
                <span style={{ marginLeft: "auto", paddingLeft: 8, fontSize: 10, color: "var(--text-4)", whiteSpace: "nowrap" }}>{c.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
