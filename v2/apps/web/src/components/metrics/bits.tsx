"use client";

/* Shared leaf helpers for the Metrics page — ported verbatim from the design
 * prototype (SR_Dashboard/magma/page-metrics.jsx). Mock-catalog lookups
 * (ERROR_BY_CODE) are replaced by the design's OWN `||` fallback shape for
 * unknown codes; callers can override when a real catalog entry exists. */

import type { TimePoint } from "@sr/shared";
import { fmtComma } from "@/lib/format";

/* ── live-series helpers (TimePoint[] → chart arrays) ─────────────────── */

/** Chart values + timestamps with null buckets dropped — we never chart an
 *  invented 0 for a bucket Prometheus had no sample in. */
export function seriesXY(pts: TimePoint[] | null | undefined): { values: number[]; times: Date[] } {
  const kept = (pts ?? []).filter((p): p is TimePoint & { v: number } => p.v !== null);
  return { values: kept.map((p) => p.v), times: kept.map((p) => new Date(p.t * 1000)) };
}

/** Plain number array (null → 0) — the exemplar OverviewView convention for
 *  stacked layers where every layer must share bucket count. */
export const nums = (pts: TimePoint[] | null | undefined): number[] => (pts ?? []).map((p) => p.v ?? 0);

/** "42s" / "12m" / "2h 05m" — CurrentlyUnavailable "down Xm" text. */
export function fmtSince(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/* ── presentational leaves (verbatim design styles) ───────────────────── */

export function AvailCell({ pct }: { pct: number }) {
  const c = pct >= 99.9 ? "var(--ok)" : pct >= 99.0 ? "var(--warn)" : "var(--err)";
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
      <span className="dot" style={{ background: c, boxShadow: pct >= 99.9 ? "0 0 4px var(--ok)" : "none", flexShrink: 0 }} />
      <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: c }}>{pct.toFixed(1)}%</span>
    </span>
  );
}

export function RatioText({ ratio }: { ratio: number | null | undefined }) {
  if (ratio == null) return <span style={{ color: "var(--text-3)" }}>—</span>;
  const c = ratio < 1 ? "var(--ok)" : ratio < 1.5 ? "var(--warn)" : "var(--err)";
  return <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: c }}>{ratio.toFixed(2)}×</span>;
}

export function CloseBtn({ onClick }: { onClick: () => void }) {
  return (
    <button className="gw-btn gw-btn--ghost" style={{ padding: 6 }} onClick={onClick}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  );
}

/* ══════════════════ ERROR DISPLAY (shared bits) ═══════════════════════ */

export const CAT_STYLE: Record<string, { bg: string; fg: string }> = {
  external: { bg: "rgba(245,158,11,0.12)", fg: "#f59e0b" },
  internal: { bg: "rgba(129,140,248,0.14)", fg: "#818cf8" },
};

export const SEV_STYLE = {
  high:   { c: "var(--err)",  bg: "rgba(239,68,68,0.09)",  ring: "rgba(239,68,68,0.35)",  lbl: "Needs attention" },
  medium: { c: "var(--warn)", bg: "rgba(251,191,36,0.09)", ring: "rgba(251,191,36,0.30)", lbl: "Watch" },
  low:    { c: "var(--text-3)", bg: "transparent",         ring: "var(--line-2)",          lbl: "Healthy" },
} as const;
export type Sev = keyof typeof SEV_STYLE;

/** Severity from a live error-rate percentage (the mock hardcoded `sev`). */
export function sevForErrRatePct(pct: number | null): Sev {
  if (pct == null) return "low";
  return pct >= 1 ? "high" : pct >= 0.1 ? "medium" : "low";
}

export function RolePill({ role }: { role: "primary" | "backup" }) {
  const on = role === "primary";
  return <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "1px 6px", borderRadius: 4, color: on ? "#60a5fa" : "#fb923c", background: on ? "rgba(96,165,250,0.1)" : "rgba(251,146,60,0.1)" }}>{on ? "Primary" : "Backup"}</span>;
}

/** One error-code line with bar, category + retryability tags. The design
 *  resolves code metadata from a mock catalog with a `||` fallback — live we
 *  have no catalog yet, so the fallback shape is the default and callers pass
 *  real metadata once labelled error counters exist. */
export function ErrCodeRow({
  code,
  count,
  total,
  last,
  color = "var(--text-3)",
  category = "external",
  retryable = true,
}: {
  code: string;
  count: number;
  total: number;
  last: boolean;
  color?: string;
  category?: string;
  retryable?: boolean;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const cat = CAT_STYLE[category] || CAT_STYLE.external!;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 2px", borderBottom: last ? "none" : "1px solid var(--line)" }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="gw-mono" style={{ fontSize: 11.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{code}</div>
        <div style={{ display: "flex", gap: 5, marginTop: 4 }}>
          <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, textTransform: "uppercase", letterSpacing: "0.05em", background: cat.bg, color: cat.fg }}>{category}</span>
          <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, textTransform: "uppercase", letterSpacing: "0.05em", background: retryable ? "rgba(96,165,250,0.12)" : "rgba(148,163,184,0.14)", color: retryable ? "#60a5fa" : "var(--text-3)" }}>{retryable ? "retryable" : "non-retryable"}</span>
        </div>
      </div>
      <div style={{ width: 84, height: 6, borderRadius: 999, background: "var(--bg-2)", flexShrink: 0 }}>
        <div style={{ width: Math.max(pct, 2) + "%", height: "100%", borderRadius: 999, background: color, opacity: 0.85 }} />
      </div>
      <span style={{ fontSize: 10, color: "var(--text-4)", minWidth: 26, textAlign: "right", flexShrink: 0 }}>{pct}%</span>
      <span className="gw-mono gw-tnum" style={{ fontSize: 12.5, fontWeight: 600, minWidth: 50, textAlign: "right", flexShrink: 0 }}>{fmtComma(count)}</span>
    </div>
  );
}
