"use client";

import { useState } from "react";

/* Ported verbatim from the design prototype (shell.jsx CopyButton). */

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const onClick = async () => {
    try { await navigator.clipboard.writeText(text); } catch {}
    setDone(true);
    setTimeout(() => setDone(false), 1400);
  };
  return (
    <button className="gw-btn gw-btn--ghost" onClick={onClick} style={{ padding: "3px 7px", fontSize: 11, gap: 5 }}>
      {done
        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      }
      {label && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}
