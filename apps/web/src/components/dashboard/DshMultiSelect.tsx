"use client";

/* DshMultiSelect — ported 1:1 from the design prototype's DSHMultiSelect
   (SR_Dashboard/magma/page-dashboard.jsx ~531-608). Inline styles verbatim.
   `value: []` means "all selected". */

import { useEffect, useRef, useState } from "react";

export interface DshOption {
  id: string;
  name: string;
  color?: string;
}

export function DshMultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: DshOption[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function h(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const allSel = value.length === 0 || value.length === options.length;
  const btnLabel = allSel ? label + ": All" : label + ": " + value.length + "/" + options.length;
  function toggle(id: string) {
    const base = value.length === 0 ? options.map((o) => o.id) : value.slice();
    const next = base.includes(id) ? base.filter((i) => i !== id) : base.concat([id]);
    onChange(next.length === options.length ? [] : next);
  }
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen(!open)} style={{
        display: "flex", alignItems: "center", gap: 5, padding: "4px 10px",
        fontSize: 11, fontWeight: 500,
        background: !allSel ? "rgba(255,57,0,0.08)" : "var(--hover)",
        border: "1px solid " + (!allSel ? "rgba(255,57,0,0.3)" : "var(--line)"),
        borderRadius: 6, cursor: "pointer", fontFamily: "var(--font-ui)",
        color: !allSel ? "var(--brand)" : "var(--text-2)", whiteSpace: "nowrap",
      }}>
        {btnLabel}
        <svg width="8" height="5" viewBox="0 0 8 5" fill="none"><path d="M1 1L4 4L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200,
          background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 8,
          padding: "4px 0", minWidth: 190, maxHeight: 280, overflowY: "auto",
          boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
        }}>
          <button onClick={() => onChange([])} style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%",
            padding: "6px 12px", background: "none", border: "none",
            borderBottom: "1px solid var(--line)", cursor: "pointer",
            fontSize: 11, color: "var(--text-3)", fontFamily: "var(--font-ui)", marginBottom: 2,
          }}>
            <span style={{
              width: 13, height: 13, borderRadius: 3,
              border: "1px solid " + (allSel ? "var(--brand)" : "var(--line)"),
              background: allSel ? "var(--brand)" : "transparent",
              display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}>
              {allSel && <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5l2.5 2.5L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </span>
            All {label.toLowerCase()}
          </button>
          {options.map((opt) => {
            const checked = value.length === 0 || value.includes(opt.id);
            return (
              <button key={opt.id} onClick={() => toggle(opt.id)} style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "5px 12px", background: "none", border: "none",
                cursor: "pointer", fontSize: 11, fontFamily: "var(--font-ui)",
                color: checked ? "var(--text)" : "var(--text-3)",
              }}>
                <span style={{
                  width: 13, height: 13, borderRadius: 3,
                  border: "1px solid " + (checked ? "var(--brand)" : "var(--line)"),
                  background: checked ? "var(--brand)" : "transparent",
                  display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  {checked && <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5l2.5 2.5L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </span>
                {opt.color && <span style={{ width: 7, height: 7, borderRadius: "50%", background: opt.color, flexShrink: 0 }} />}
                {opt.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
