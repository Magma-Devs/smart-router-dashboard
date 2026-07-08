"use client";

import { useEffect, useRef, useState } from "react";
import { WINDOW_OPTIONS, WINDOWS, type MetricWindow } from "@sr/shared";

/* Themed time-window dropdown — replaces the native <select> whose option list
   renders in the OS theme (white-on-blue), which looked out of place on the
   dark UI. Mirrors ChainSelect: themed popover, hover/selected states, an icon,
   click-outside to close. Options come from WINDOW_OPTIONS/WINDOWS. */

export function WindowSelect({
  value,
  onChange,
}: {
  value: MetricWindow;
  onChange: (w: MetricWindow) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line-2)",
          background: "var(--surface)", color: "var(--text)", fontSize: 12, fontFamily: "inherit",
          cursor: "pointer", display: "flex", alignItems: "center", gap: 8, minWidth: 120,
          justifyContent: "space-between",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          {WINDOWS[value].label}
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 120, minWidth: 150, padding: 4, borderRadius: 9, background: "var(--surface-2)", border: "1px solid var(--line-2)", boxShadow: "0 10px 30px rgba(0,0,0,0.5)", maxHeight: 320, overflowY: "auto" }}>
          {WINDOW_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => { onChange(v); setOpen(false); }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                borderRadius: 6, border: "none",
                background: value === v ? "var(--hover)" : "transparent",
                color: value === v ? "var(--text)" : "var(--text-2)",
                fontSize: 12, fontWeight: value === v ? 600 : 400, fontFamily: "inherit",
                cursor: "pointer", textAlign: "left",
              }}
            >
              {WINDOWS[v].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
