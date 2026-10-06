"use client";

import { Fragment, useRef, useState } from "react";

/* Ported verbatim from the design prototype (page-metrics.jsx renderTipText + Tip). */

/** Mini `**bold**` / paragraph / line-break renderer for tooltip strings. */
export function renderTipText(text: string): React.ReactNode {
  if (typeof text !== "string") return text;
  const norm = text.replace(/\\n/g, "\n").replace(/[—–]/g, "-");
  return norm.split(/\n{2,}/).map((para, pi) => {
    const lines = para.split("\n");
    return (
      <span key={pi} style={{ display: "block", marginTop: pi ? 8 : 0 }}>
        {lines.map((line, li) => {
          const segs = line.split("**");
          return (
            <Fragment key={li}>
              {li > 0 && <br />}
              {segs.map((seg, si) => si % 2 === 1
                ? <strong key={si} style={{ color: "var(--text)", fontWeight: 600 }}>{seg}</strong>
                : <Fragment key={si}>{seg}</Fragment>
              )}
            </Fragment>
          );
        })}
      </span>
    );
  });
}

export function Tip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const open = () => { const r = ref.current && ref.current.getBoundingClientRect(); if (r) setPos({ x: Math.min(Math.max(r.left + r.width / 2, 152), window.innerWidth - 152), y: r.bottom + 7 }); };
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex", verticalAlign: "middle" }}
      onMouseEnter={open} onMouseLeave={() => setPos(null)}>
      <span style={{ width: 14, height: 14, borderRadius: "50%", background: "var(--bg-2)", border: "1px solid var(--line-2)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "var(--text-3)", cursor: "help", flexShrink: 0, fontFamily: "var(--font-ui)", lineHeight: 1, marginLeft: 4 }}>i</span>
      {pos && (
        <span style={{ position: "fixed", top: pos.y, left: pos.x, transform: "translateX(-50%)", zIndex: 9999, width: "max-content", maxWidth: 300, padding: "10px 12px", borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--line-2)", fontSize: 11, fontWeight: 400, color: "var(--text-2)", lineHeight: 1.5, letterSpacing: "normal", textTransform: "none", textAlign: "left", boxShadow: "0 8px 24px rgba(0,0,0,0.45)", pointerEvents: "none", whiteSpace: "normal" }}>{renderTipText(text)}</span>
      )}
    </span>
  );
}
