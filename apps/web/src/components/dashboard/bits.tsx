"use client";

/* bits.tsx — small Dashboard-page building blocks, ported 1:1 from the design
   prototype (SR_Dashboard/magma/page-dashboard.jsx: DSHChip/DSHDelta/DSHKpi/
   DSHCard/DSHLgnd/DSHSection + the dsCW responsive-width hook). Inline styles
   are verbatim (load-bearing pixel values). */

import { useEffect, useRef, useState } from "react";
import type { TimePoint } from "@sr/shared";

/* formatters — verbatim from the prototype's data.jsx so rendered strings
   match pixel-for-pixel (lib/format.ts rounds differently). */
export function dshFmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  // sub-1 axis values (fractional req/s) — never print raw float precision
  if (n > 0 && n < 1) return n.toFixed(2);
  if (!Number.isInteger(n)) return n.toFixed(1);
  return String(n);
}
export function dshFmtComma(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

/** TimePoint[] → number[] for stats/aggregation (mean, totals). Null buckets
 *  collapse to 0 — fine for sums/means; use `toNumsGap` for chart lines. */
export function toNums(pts: TimePoint[] | undefined | null, scale = 1): number[] {
  return (pts ?? []).map((p) => (p.v ?? 0) * scale);
}

/** TimePoint[] → (number|null)[] preserving gaps, for the multi-series charts
 *  that BREAK the line at null buckets instead of plunging to 0 (the api
 *  grid-aligns series with explicit nulls where a chain had no data). */
export function toNumsGap(pts: TimePoint[] | undefined | null, scale = 1): (number | null)[] {
  return (pts ?? []).map((p) => (p.v == null ? null : p.v * scale));
}

/** Mean of a series, or null when empty (for ratio/threshold colouring). */
export function meanOf(vals: number[]): number | null {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/* ── Responsive-width hook (the prototype's dsCW) ─────────────────────────── */
export function useChartWidth(fb = 500): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(fb);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setW(Math.max(60, e.contentRect.width));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/* ── Chip tab selector ─────────────────────────────────────────────────────── */
export function DSHChip({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 2, background: "var(--hover)", borderRadius: 6, padding: 2 }}>
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} style={{
          padding: "2px 8px", borderRadius: 5, border: "none", cursor: "pointer",
          fontSize: 10, fontWeight: 500, fontFamily: "var(--font-ui)",
          background: value === o ? "var(--bg-2)" : "transparent",
          color: value === o ? "var(--text)" : "var(--text-3)",
        }}>{o}</button>
      ))}
    </div>
  );
}

/* ── Delta indicator ───────────────────────────────────────────────────────── */
export function DSHDelta({ v, unit = "", inv }: { v: number | null | undefined; unit?: string; inv?: boolean }) {
  if (v == null) return null;
  const good = inv ? v < 0 : v > 0;
  const c = v === 0 ? "var(--text-3)" : good ? "var(--ok)" : "var(--err)";
  const absV = Math.abs(v);
  return (
    <span style={{ fontSize: 11, color: c, fontFamily: "var(--font-mono)", display: "block", marginTop: 4 }}>
      {v > 0 ? "↑ " : v < 0 ? "↓ " : "· "}{absV < 10 ? absV.toFixed(2) : Math.round(absV)}{unit} vs prior
    </span>
  );
}

/* ── KPI card ──────────────────────────────────────────────────────────────── */
export function DSHKpi({
  label,
  value,
  delta,
  deltaUnit,
  inv,
  spark,
  sparkColor,
  onClick,
  tooltip,
  children,
}: {
  label: string;
  value: React.ReactNode;
  delta?: number | null;
  deltaUnit?: string;
  inv?: boolean;
  spark?: number[];
  sparkColor?: string;
  onClick?: () => void;
  tooltip?: string;
  children?: React.ReactNode;
}) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={tooltip}
      style={{
        flex: 1, minWidth: 160, padding: "16px 18px",
        background: hov ? "var(--hover)" : "var(--bg)",
        border: "1px solid var(--line)", borderRadius: 10,
        cursor: onClick ? "pointer" : "default",
        transition: "background 0.12s",
      }}>
      <div style={{ fontSize: 10, color: "var(--text-4)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 2 }}>
        <div style={{ fontSize: 36, fontWeight: 400, letterSpacing: "-0.04em", fontFamily: "var(--font-mono)", lineHeight: 1, color: "var(--text)" }}>{value}</div>
        {spark && spark.length > 1 && <div style={{ marginBottom: 6, opacity: 0.65 }}><DSHSparkMini data={spark} color={sparkColor || "var(--brand)"} w={60} h={28} /></div>}
      </div>
      <DSHDelta v={delta} unit={deltaUnit} inv={inv} />
      {children}
    </div>
  );
}

/* Sparkline (the prototype's DSHSpark) — local copy so bits stays standalone. */
export function DSHSparkMini({ data, w = 60, h = 26, color = "var(--brand)" }: { data?: number[]; w?: number; h?: number; color?: string }) {
  if (!data || !data.length) return null;
  const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1;
  const pts = data
    .map((v, i) => ((i / (data.length - 1)) * w) + "," + (h - 2 - ((v - mn) / rng) * (h - 5)))
    .join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ── Chart card ────────────────────────────────────────────────────────────── */
export function DSHCard({
  title,
  sub,
  controls,
  style,
  children,
}: {
  title: string;
  sub?: string;
  controls?: React.ReactNode;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>{title}</span>
        {sub && <span style={{ fontSize: 10, color: "var(--text-4)" }}>{sub}</span>}
        <div style={{ flex: 1 }} />
        {controls}
      </div>
      {children}
    </div>
  );
}

/* ── Legend ────────────────────────────────────────────────────────────────── */
export function DSHLgnd({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 3, background: it.color, borderRadius: 2, display: "inline-block", flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: "var(--text-3)" }}>{it.label}</span>
        </span>
      ))}
    </div>
  );
}

/* ── Section header ────────────────────────────────────────────────────────── */
export function DSHSection({ letter, title }: { letter: string; title: string }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-2)", marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ padding: "1px 7px", borderRadius: 5, background: "var(--hover)", color: "var(--text-3)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{letter}</span>
      {title}
    </div>
  );
}

/* ── Null-gated chart body — the design's muted "—" empty state ──────────── */
export function DSHNoData({ height, note }: { height: number; note?: string }) {
  return (
    <div style={{ height, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
      <span style={{ fontSize: 13, color: "var(--text-4)" }}>—</span>
      {note && <span style={{ fontSize: 10, color: "var(--text-4)" }}>{note}</span>}
    </div>
  );
}
