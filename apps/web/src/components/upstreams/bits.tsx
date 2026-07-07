"use client";

/* Small shared components — ported verbatim from the design prototype
 * (page-providers.jsx): StatusDot, EyeIcon, SecretInput, FL, FE, Hint,
 * EncNote, KebabMenu, UrlParserPreview, UpstreamIdentityRow, SheetStepBar. */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { labelStyle } from "@/lib/styles";
import { UpstreamLogo } from "@/components/upstreams/UpstreamLogo";
import {
  UPSTREAM_CATALOG,
  designChainById,
  parseUrlChain,
  type UpstreamCatalogEntry,
} from "@/components/upstreams/catalog";

export const pvStatLabel: CSSProperties = { fontSize: 9, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600 };

export function StatusDot({ status }: { status: string }) {
  /* Honest extra branch: "—" (no metrics in window) renders a neutral dot —
     the design's else-branch red dot would falsely signal "down". */
  if (status === "—") return <span className="dot" style={{ background: "var(--text-4)" }} />;
  const cls = status === "healthy" ? "dot--ok" : status === "degraded" ? "dot--warn" : "dot--err";
  return <span className={"dot " + cls} />;
}

export function EyeIcon({ show }: { show: boolean }) {
  return show
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10 10 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
}

export function SecretInput({ value, onChange, placeholder, rows }: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
}) {
  const [show, setShow] = useState(false);
  const btnStyle: CSSProperties = { position: "absolute", right: 10, border: "none", background: "transparent", color: "var(--text-3)", cursor: "pointer", padding: 2 };
  if (rows) return (
    <div style={{ position: "relative" }}>
      <textarea className="gw-input gw-mono" rows={rows} value={value} onChange={onChange} placeholder={placeholder}
        style={{ fontSize: 11, resize: "vertical", paddingRight: 36,
          WebkitTextSecurity: show ? "none" : "disc", letterSpacing: show ? undefined : "0.08em" } as CSSProperties} />
      <button type="button" style={{ ...btnStyle, top: 10 }} onClick={() => setShow((s) => !s)}><EyeIcon show={show} /></button>
    </div>
  );
  return (
    <div style={{ position: "relative" }}>
      <input className="gw-input gw-mono" type={show ? "text" : "password"} value={value} onChange={onChange}
        placeholder={placeholder || "Paste your key"} style={{ fontSize: 12, paddingRight: 36 }} />
      <button type="button" style={{ ...btnStyle, top: "50%", transform: "translateY(-50%)" }} onClick={() => setShow((s) => !s)}><EyeIcon show={show} /></button>
    </div>
  );
}

export function FL({ children }: { children: React.ReactNode }) { // FieldLabel
  return <div style={{ ...labelStyle, marginBottom: 6 }}>{children}</div>;
}

export function FE({ msg }: { msg?: string }) { // FieldError
  return msg ? <div style={{ fontSize: 11, color: "var(--err)", marginTop: 4 }}>{msg}</div> : null;
}

export function Hint({ type = "warn", children }: { type?: "warn" | "info" | "err"; children: React.ReactNode }) {
  const c = { warn: ["rgba(245,158,11,0.06)","rgba(245,158,11,0.2)","var(--warn)"], info: ["rgba(96,165,250,0.06)","rgba(96,165,250,0.2)","var(--info)"], err: ["rgba(239,68,68,0.06)","rgba(239,68,68,0.2)","var(--err)"] }[type];
  return (
    <div style={{ marginTop: 8, padding: "9px 12px", borderRadius: 7, background: c[0], border: `1px solid ${c[1]}`, fontSize: 12, color: c[2], display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ flexShrink: 0 }}>{type === "err" ? "✕" : type === "warn" ? "⚠" : "ℹ"}</span>
      <span>{children}</span>
    </div>
  );
}

export function EncNote() {
  return (
    <div style={{ padding: "9px 12px", borderRadius: 7, background: "var(--hover)", border: "1px solid var(--line)", fontSize: 11, color: "var(--text-3)", display: "flex", gap: 7, alignItems: "center" }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Encrypted at rest — credentials are never returned in plaintext.
    </div>
  );
}

/* ─────────────────────────────────────────────
   Kebab (···) menu
───────────────────────────────────────────── */
export interface KebabItem {
  separator?: boolean;
  info?: boolean;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
}

export function KebabMenu({ items }: { items: KebabItem[] }) {
  const [open, setOpen] = useState(false);
  const [, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const inBtn = btnRef.current && btnRef.current.contains(e.target as Node);
      const inMenu = menuRef.current && menuRef.current.contains(e.target as Node);
      if (!inBtn && !inMenu) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((o) => !o);
  };

  return (
    <div style={{ position: "relative" }}>
      <button ref={btnRef} onClick={handleOpen} className="gw-btn gw-btn--ghost"
        style={{ padding: "4px 7px", fontSize: 15, letterSpacing: "0.06em", color: "var(--text-3)", lineHeight: 1 }}>···</button>
      {open && (
        <div ref={menuRef} style={{
          position: "absolute", right: 0, top: "calc(100% + 4px)",
          background: "var(--surface)", border: "1px solid var(--line-2)",
          borderRadius: 10, boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
          padding: "4px", zIndex: 9999, minWidth: 180,
        }}>
          {items.map((item, i) => item.separator ? (
            <div key={i} style={{ height: 1, background: "var(--line)", margin: "4px 0" }} />
          ) : item.info ? (
            <div key={i} style={{ padding: "7px 12px", fontSize: 11, color: "var(--text-4)", display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {item.label}
            </div>
          ) : (
            <button key={i} onClick={() => { setOpen(false); item.onClick?.(); }}
              style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 12px", borderRadius: 7, width: "100%", border: "none", background: "transparent", color: item.danger ? "var(--err)" : "var(--text)", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
              onMouseEnter={(e) => e.currentTarget.style.background = item.danger ? "rgba(239,68,68,0.07)" : "var(--hover)"}
              onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
              {item.icon}{item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   URL parser preview (for multi-URL flow)
───────────────────────────────────────────── */
export function UrlParserPreview({ urls, catalog }: { urls: string[]; catalog?: UpstreamCatalogEntry | null }) {
  const rows = urls.filter((u) => u.trim()).map((url) => {
    const chain = parseUrlChain(url);
    const wrongUpstream = !!(catalog?.domainPattern && url.startsWith("https") && !catalog.domainPattern.test(url));
    const altUpstream = wrongUpstream ? UPSTREAM_CATALOG.find((p) => p.domainPattern && p.domainPattern.test(url)) : null;
    return { url, chain, wrongUpstream, altUpstream };
  });
  if (!rows.length) return null;
  return (
    <div className="gw-url-preview" style={{ marginTop: 8 }}>
      {rows.map((row, i) => (
        <div key={i} className="gw-url-preview-row" style={{
          borderColor: row.wrongUpstream ? "rgba(239,68,68,0.2)" : row.chain ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.2)",
          background:  row.wrongUpstream ? "rgba(239,68,68,0.04)" : row.chain ? "rgba(34,197,94,0.04)" : "rgba(245,158,11,0.04)",
        }}>
          <span style={{ fontSize: 13, flexShrink: 0 }}>{row.wrongUpstream ? "⚠" : row.chain ? "✓" : "?"}</span>
          <span className="gw-mono" style={{ fontSize: 10, color: "var(--text-3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.url.length > 54 ? row.url.slice(0, 54) + "…" : row.url}
          </span>
          {row.chain && <span style={{ fontSize: 10, fontWeight: 600, color: designChainById(row.chain)?.color || "var(--ok)", flexShrink: 0 }}>{designChainById(row.chain)?.name}</span>}
          {!row.chain && !row.wrongUpstream && <span style={{ fontSize: 10, color: "var(--warn)", flexShrink: 0 }}>chain unknown</span>}
          {row.wrongUpstream && row.altUpstream && <span style={{ fontSize: 10, color: "var(--err)", flexShrink: 0 }}>looks like {row.altUpstream.name}</span>}
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────
   Upstream identity row (shared in forms)
───────────────────────────────────────────── */
export function UpstreamIdentityRow({ catalog, sub }: { catalog: UpstreamCatalogEntry; sub: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 14px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--line)" }}>
      <UpstreamLogo id={catalog.id} size={36} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{catalog.name}</div>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>{sub}</div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Step bar
───────────────────────────────────────────── */
export function SheetStepBar({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="gw-sheet__steps">
      {steps.map((s, i) => {
        const idx = i + 1, isDone = current > idx, isActive = current === idx;
        return (
          <div key={i} className={"gw-sheet__step" + (isActive ? " active" : "") + (isDone ? " done" : "")}>
            <span className="gw-sheet__step-num">{isDone ? "✓" : idx}</span>{s}
          </div>
        );
      })}
    </div>
  );
}

/** Live chain option (spec-keyed) for the wizard <select>s — replaces the
 *  design's mock CHAINS global. */
export interface LiveChain { spec: string; name: string }
