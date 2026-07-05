"use client";

/* dsh-charts.tsx — SVG chart primitives for the internal ops Dashboard.
   Ported 1:1 from the design prototype (SR_Dashboard/magma/page-dashboard.jsx). */

import { useState } from "react";

/* helpers — ported verbatim from the prototype's data.jsx so axis/tooltip
   text matches pixel-for-pixel (the app-wide lib/format.ts uses different
   rounding rules and would drift the rendered strings). */
function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}
function fmtComma(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

/* ── Sparkline ─────────────────────────────────────────────────────────────── */
export function DSHSpark({
  data,
  w = 60,
  h = 26,
  color = "var(--brand)",
}: {
  data?: number[];
  w?: number;
  h?: number;
  color?: string;
}) {
  if (!data || !data.length) return null;
  const mn = Math.min(...data),
    mx = Math.max(...data),
    rng = mx - mn || 1;
  const pts = data
    .map((v, i) => ((i / (data.length - 1)) * w) + "," + (h - 2 - ((v - mn) / rng) * (h - 5)))
    .join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ── Time label generator ──────────────────────────────────────────────────── */
export interface DSHTimeLabel {
  i: number;
  label: string;
}
function makeTimeLabels(win: string, n: number): DSHTimeLabel[] {
  const now = new Date();
  const winMs = ({ "1h": 3600000, "3h": 10800000, "24h": 86400000, "7d": 604800000 } as Record<string, number>)[win] || 86400000;
  return [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const i = Math.round(t * (n - 1));
    const dt = new Date(now.getTime() - (1 - t) * winMs);
    let label: string;
    if (win === "7d") {
      label = dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    } else if (win === "1h" || win === "3h") {
      label = dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    } else {
      label = dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    return { i, label };
  });
}

export interface DSHSeries {
  data: number[];
  color: string;
  label?: string;
  ghost?: boolean;
}
export interface DSHThreshold {
  value: number;
  color?: string;
  label?: string;
}
export interface DSHBreakdown {
  label: string;
  color: string;
  data: number[];
}
export interface DSHAxisSeries {
  data: number[];
  color: string;
  label: string;
}

/* ── Multi-series line chart ───────────────────────────────────────────────── */
export function DSHLine({
  series,
  width,
  height = 140,
  yFmt,
  yDomain,
  showArea,
  win,
  bgBand,
  onClick,
  thresholds,
}: {
  series?: DSHSeries[];
  width?: number;
  height?: number;
  yFmt?: (v: number) => string | number;
  yDomain?: [number, number];
  showArea?: boolean;
  win?: string;
  bgBand?: "ok" | "warn" | "err";
  onClick?: () => void;
  thresholds?: DSHThreshold[];
}) {
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  if (!width || !series || !series.length) return <div style={{ height: height }} />;
  const pL = 46, pR = 14, pT = 8, pB = 28;
  const iW = width - pL - pR, iH = height - pT - pB;
  const n = series[0]!.data.length;
  const allV = series.reduce<number[]>((a, s) => a.concat(s.data), []);
  const mnV = yDomain ? yDomain[0] : Math.min(...allV);
  const mxV = yDomain ? yDomain[1] : Math.max(...allV);
  const rng = mxV - mnV || 1;
  const xs = (i: number) => pL + (i / Math.max(n - 1, 1)) * iW;
  const ys = (v: number) => pT + iH - ((v - mnV) / rng) * iH;
  const fmt = yFmt || ((v: number) => (v >= 1000 ? fmtNum(v) : Math.round(v)));
  const timeLbls = makeTimeLabels(win || "24h", n);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const raw = ((mx - pL) / iW) * (n - 1);
    const ci = Math.max(0, Math.min(n - 1, Math.round(raw)));
    setHover({ i: ci, x: xs(ci) });
  };

  const tipX = hover ? Math.min(hover.x + 10, width - 130) : 0;

  return (
    <div style={{ position: "relative", cursor: onClick ? "pointer" : undefined }} onMouseLeave={() => setHover(null)}
      onClick={onClick}>
      <svg width={width} height={height} style={{ overflow: "visible", display: "block", cursor: "crosshair" }}
        onMouseMove={handleMouseMove}>
        {/* Y gridlines + labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const yp = pT + iH * (1 - t);
          return (
            <g key={t}>
              <line x1={pL} x2={pL + iW} y1={yp} y2={yp} stroke="var(--line)" strokeWidth="1" />
              <text x={pL - 5} y={yp + 3.5} fontSize="9" fill="var(--text-3)" textAnchor="end" fontFamily="var(--font-mono)">{fmt(mnV + t * rng)}</text>
            </g>
          );
        })}
        {/* X time labels */}
        {timeLbls.map((tl) => {
          const anchor = tl.i === 0 ? "start" : tl.i === n - 1 ? "end" : "middle";
          return (
            <text key={tl.i} x={xs(tl.i)} y={pT + iH + 18} fontSize="9" fill="var(--text-3)"
              textAnchor={anchor} fontFamily="var(--font-mono)">{tl.label}</text>
          );
        })}
        {/* Status band */}
        {bgBand && (
          <rect x={pL} y={pT} width={iW} height={iH}
            fill={bgBand === "ok" ? "#22c55e" : bgBand === "warn" ? "#f59e0b" : "#ef4444"}
            fillOpacity="0.055" />
        )}
        {/* Series */}
        {series.map((s, si) => {
          const pts = s.data.map((v, i) => xs(i) + "," + ys(v)).join(" ");
          const aPts = xs(0) + "," + (pT + iH) + " " + pts + " " + xs(n - 1) + "," + (pT + iH);
          return (
            <g key={si}>
              {showArea && <polygon points={aPts} fill={s.color} fillOpacity="0.10" />}
              <polyline points={pts} fill="none" stroke={s.color}
                strokeWidth={s.ghost ? 1 : 1.5}
                strokeDasharray={s.ghost ? "4 3" : undefined}
                strokeOpacity={s.ghost ? 0.45 : 1}
                strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
        {/* Threshold lines */}
        {thresholds && thresholds.map((th, ti) => {
          const ty = ys(th.value);
          if (ty < pT - 2 || ty > pT + iH + 2) return null;
          return (
            <g key={ti}>
              <line x1={pL} x2={pL + iW} y1={ty} y2={ty}
                stroke={th.color || "rgba(255,255,255,0.18)"} strokeWidth="1"
                strokeDasharray="4 3" />
              {th.label && <text x={pL + iW + 4} y={ty + 3.5} fontSize="8"
                fill={th.color || "rgba(255,255,255,0.35)"} fontFamily="var(--font-mono)">{th.label}</text>}
            </g>
          );
        })}
        {/* Crosshair + dots */}
        {hover && (
          <g pointerEvents="none">
            <line x1={hover.x} x2={hover.x} y1={pT} y2={pT + iH}
              stroke="var(--text-3)" strokeWidth="1" strokeDasharray="3 2" />
            {series.map((s, si) => {
              const v = s.data[hover.i];
              if (v == null) return null;
              return <circle key={si} cx={hover.x} cy={ys(v)} r="3.5"
                fill={s.color} stroke="var(--bg)" strokeWidth="1.5" />;
            })}
          </g>
        )}
      </svg>
      {/* Tooltip */}
      {hover && (
        <div style={{
          position: "absolute", left: tipX, top: pT + 4,
          background: "var(--bg-2, var(--bg))", border: "1px solid var(--line)",
          borderRadius: 7, padding: "7px 11px", fontSize: 11, pointerEvents: "none",
          zIndex: 20, boxShadow: "0 4px 16px rgba(0,0,0,0.3)", minWidth: 110,
        }}>
          <div style={{ fontSize: 9, color: "var(--text-3)", marginBottom: 5,
            fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--line)", paddingBottom: 4 }}>
            {timeLbls.find((t) => t.i === hover.i)?.label || ""}
          </div>
          {series.map((s, si) => {
            const v = s.data[hover.i];
            if (v == null) return null;
            return (
              <div key={si} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: si < series.length - 1 ? 3 : 0 }}>
                <span style={{ width: 8, height: 2, background: s.color, borderRadius: 1, flexShrink: 0 }} />
                {s.label && <span style={{ color: "var(--text-3)", fontSize: 10, flex: 1 }}>{s.label}</span>}
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", marginLeft: s.label ? 0 : "auto" }}>{fmt(v)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Stacked area chart ────────────────────────────────────────────────────── */
export interface DSHStackLayer {
  data: number[];
  color: string;
  label?: string;
}
export function DSHStack({
  stacks,
  width,
  height = 140,
  yFmt,
}: {
  stacks?: DSHStackLayer[];
  width?: number;
  height?: number;
  yFmt?: (v: number) => string | number;
}) {
  if (!width || !stacks || !stacks.length) return <div style={{ height: height }} />;
  const pL = 42, pR = 12, pT = 8, pB = 20;
  const iW = width - pL - pR, iH = height - pT - pB;
  const n = stacks[0]!.data.length;
  const tots = Array.from({ length: n }, (_, i) => stacks.reduce((s, st) => s + st.data[i]!, 0));
  const top = Math.max(...tots) * 1.06 || 1;
  const xs = (i: number) => pL + (i / (n - 1)) * iW;
  const ys = (v: number) => pT + iH - (v / top) * iH;
  const fmt = yFmt || ((v: number) => (v >= 1000 ? fmtNum(v) : Math.round(v)));
  let cum: number[] = new Array<number>(n).fill(0);
  const layers = stacks.map((st) => {
    const lo = cum.slice();
    cum = cum.map((c, i) => c + st.data[i]!);
    return { ...st, lo: lo, hi: cum.slice() };
  });
  return (
    <svg width={width} height={height} style={{ overflow: "visible", display: "block" }}>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const yp = pT + iH * (1 - t);
        return (
          <g key={t}>
            <line x1={pL} x2={pL + iW} y1={yp} y2={yp} stroke="var(--line)" strokeWidth="1" />
            <text x={pL - 5} y={yp + 3.5} fontSize="9" fill="var(--text-3)" textAnchor="end" fontFamily="var(--font-mono)">{fmt(t * top)}</text>
          </g>
        );
      })}
      {layers.slice().reverse().map((l, si) => {
        const tPts = l.hi.map((v, i) => xs(i) + "," + ys(v)).join(" ");
        const bPts = l.lo.slice().reverse().map((v, i) => xs(n - 1 - i) + "," + ys(v)).join(" ");
        return <polygon key={si} points={tPts + " " + bPts} fill={l.color} fillOpacity="0.82" />;
      })}
    </svg>
  );
}

/* ── Bar / column chart ───────────────────────────────────────────────────── */
export function DSHBar({
  data,
  breakdowns,
  width,
  height = 200,
  win,
  onClickBar,
  yFmt,
}: {
  data?: number[];
  breakdowns?: DSHBreakdown[];
  width?: number;
  height?: number;
  win?: string;
  onClickBar?: (i: number) => void;
  yFmt?: (v: number) => string | number;
}) {
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  if (!width) return <div style={{ height: height }} />;
  if (!data || !data.length || data.every((v) => v === 0)) {
    return (
      <div style={{ height: height, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 13, color: "var(--ok)" }}>No errors in this window. ✓</span>
      </div>
    );
  }
  const pL = 46, pR = 14, pT = 8, pB = 28;
  const iW = width - pL - pR, iH = height - pT - pB;
  const n = data.length;
  const maxV = Math.max(...data) * 1.1 || 1;
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const spikeThresh = mean * 1.6;
  const gap = Math.max(1, (iW / n) * 0.15);
  const barW = Math.max(2, (iW - gap * (n - 1)) / n);
  const bx = (i: number) => pL + i * (barW + gap);
  const bh = (v: number) => (v / maxV) * iH;
  const by = (v: number) => pT + iH - bh(v);
  const fmt = yFmt || ((v: number) => (v >= 1000 ? fmtNum(v) : Math.round(v)));
  const timeLbls = makeTimeLabels(win || "24h", n);

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const ci = Math.max(0, Math.min(n - 1, Math.round(((mx - pL) / iW) * (n - 1))));
    setHover({ i: ci, x: bx(ci) + barW / 2 });
  }
  const tipX = hover ? Math.min(hover.x + 8, width - 155) : 0;

  return (
    <div style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} style={{ overflow: "visible", display: "block" }}
        onMouseMove={handleMouseMove}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const yp = pT + iH * (1 - t);
          return (
            <g key={t}>
              <line x1={pL} x2={pL + iW} y1={yp} y2={yp} stroke="var(--line)" strokeWidth="1" />
              <text x={pL - 5} y={yp + 3.5} fontSize="9" fill="var(--text-3)" textAnchor="end" fontFamily="var(--font-mono)">{fmt(t * maxV)}</text>
            </g>
          );
        })}
        {timeLbls.map((tl) => {
          const anchor = tl.i === 0 ? "start" : tl.i === n - 1 ? "end" : "middle";
          return (
            <text key={tl.i} x={bx(tl.i) + barW / 2} y={pT + iH + 18} fontSize="9" fill="var(--text-3)"
              textAnchor={anchor} fontFamily="var(--font-mono)">{tl.label}</text>
          );
        })}
        {data.map((v, i) => {
          if (v === 0) return null;
          const isSpike = v > spikeThresh;
          const isHov = hover && hover.i === i;
          const color = isSpike ? "var(--warn)" : "var(--text-3)";
          return (
            <rect key={i}
              x={bx(i)} y={by(v)} width={barW} height={bh(v)}
              fill={color} fillOpacity={isHov ? 0.85 : 0.5}
              rx={Math.min(2, barW / 3)}
              onClick={() => { if (onClickBar) onClickBar(i); }}
              style={{ cursor: onClickBar ? "pointer" : "default" }}
            />
          );
        })}
        {hover && (
          <line x1={hover.x} x2={hover.x} y1={pT} y2={pT + iH}
            stroke="var(--text-3)" strokeWidth="1" strokeDasharray="3 2" pointerEvents="none" />
        )}
      </svg>
      {hover && data[hover.i]! > 0 && (
        <div style={{
          position: "absolute", left: tipX, top: pT + 4,
          background: "var(--bg)", border: "1px solid var(--line)",
          borderRadius: 7, padding: "8px 11px", fontSize: 11, pointerEvents: "none",
          zIndex: 20, boxShadow: "0 4px 16px rgba(0,0,0,0.35)", minWidth: 148,
        }}>
          <div style={{ fontSize: 9, color: "var(--text-3)", marginBottom: 5, fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--line)", paddingBottom: 4 }}>
            {timeLbls.find((t) => t.i === hover.i)?.label || ""}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: breakdowns ? 7 : 0 }}>
            <span style={{ fontSize: 10, color: "var(--text-3)" }}>Total errors</span>
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{fmtComma(data[hover.i])}</span>
          </div>
          {breakdowns && (
            <>
              <div style={{ height: 5, borderRadius: 3, overflow: "hidden", display: "flex", marginBottom: 6 }}>
                {breakdowns.map((b) => {
                  const w = data[hover.i]! > 0 ? ((b.data[hover.i] ?? 0) / data[hover.i]!) * 100 : 0;
                  return w > 0 ? <div key={b.label} style={{ width: w + "%", background: b.color, height: "100%" }} /> : null;
                })}
              </div>
              {breakdowns.map((b) => (
                <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span style={{ width: 8, height: 2, background: b.color, borderRadius: 1, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: "var(--text-3)", flex: 1 }}>{b.label}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>{fmtComma(b.data[hover.i])}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Dual-axis line chart (warm left / cool right) ────────────────────────── */
export function DSHDualAxis({
  left,
  right,
  width,
  height = 300,
  win,
  caption,
}: {
  left?: DSHAxisSeries;
  right?: DSHAxisSeries;
  width?: number;
  height?: number;
  win?: string;
  caption?: React.ReactNode;
}) {
  const [hover, setHov] = useState<{ i: number; x: number } | null>(null);
  if (!width || !left || !right) return <div style={{ height: height }} />;
  const pL = 52, pR = 52, pT = 12, pB = 28;
  const iW = width - pL - pR, iH = height - pT - pB;
  const n = Math.min(left.data.length, right.data.length);
  const lMin = 0, lMax = Math.max(...left.data) * 1.2 || 10;
  const rRaw = right.data.slice(0, n);
  const rMin = Math.floor(Math.min(...rRaw) * 0.996);
  const rMax = 100;
  const lRng = lMax - lMin || 1, rRng = rMax - rMin || 1;
  const xs = (i: number) => pL + (i / Math.max(n - 1, 1)) * iW;
  const yl = (v: number) => pT + iH - ((v - lMin) / lRng) * iH;
  const yr = (v: number) => pT + iH - ((v - rMin) / rRng) * iH;
  const timeLbls = makeTimeLabels(win || "24h", n);
  const lPts = left.data.slice(0, n).map((v, i) => xs(i) + "," + yl(v)).join(" ");
  const rPts = rRaw.map((v, i) => xs(i) + "," + yr(v)).join(" ");
  function handleMM(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ci = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rect.left - pL) / iW) * (n - 1))));
    setHov({ i: ci, x: xs(ci) });
  }
  const tipX = hover ? Math.min(hover.x + 10, width - 175) : 0;
  const hovL = hover ? left.data[hover.i] : null;
  const hovR = hover ? rRaw[hover.i] : null;
  return (
    <div>
      <div style={{ position: "relative" }} onMouseLeave={() => setHov(null)}>
        <svg width={width} height={height} style={{ overflow: "visible", display: "block", cursor: "crosshair" }} onMouseMove={handleMM}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const yp = pT + iH * (1 - t);
            return (
              <g key={t}>
                <line x1={pL} x2={pL + iW} y1={yp} y2={yp} stroke="var(--line)" strokeWidth="1" />
                <text x={pL - 5} y={yp + 3.5} fontSize="9" fill={left.color} textAnchor="end" fontFamily="var(--font-mono)">{(lMin + t * lRng).toFixed(1)}%</text>
                <text x={pL + iW + 5} y={yp + 3.5} fontSize="9" fill={right.color} textAnchor="start" fontFamily="var(--font-mono)">{(rMin + t * rRng).toFixed(2)}%</text>
              </g>
            );
          })}
          {timeLbls.map((tl) => {
            const anchor = tl.i === 0 ? "start" : tl.i === n - 1 ? "end" : "middle";
            return <text key={tl.i} x={xs(tl.i)} y={pT + iH + 18} fontSize="9" fill="var(--text-3)" textAnchor={anchor} fontFamily="var(--font-mono)">{tl.label}</text>;
          })}
          <text x={pL - 38} y={pT + iH / 2} fontSize="8" fill={left.color} textAnchor="middle" fontFamily="var(--font-ui)"
            transform={"rotate(-90," + (pL - 38) + "," + (pT + iH / 2) + ")"}>{"Failover ratio"}</text>
          <text x={pL + iW + 38} y={pT + iH / 2} fontSize="8" fill={right.color} textAnchor="middle" fontFamily="var(--font-ui)"
            transform={"rotate(90," + (pL + iW + 38) + "," + (pT + iH / 2) + ")"}>{"Internal availability"}</text>
          <polyline points={lPts} fill="none" stroke={left.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={rPts} fill="none" stroke={right.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {hover && (
            <g pointerEvents="none">
              <line x1={hover.x} x2={hover.x} y1={pT} y2={pT + iH} stroke="var(--text-3)" strokeWidth="1" strokeDasharray="3 2" />
              {hovL != null && <circle cx={hover.x} cy={yl(hovL)} r="3.5" fill={left.color} stroke="var(--bg)" strokeWidth="1.5" />}
              {hovR != null && <circle cx={hover.x} cy={yr(hovR)} r="3.5" fill={right.color} stroke="var(--bg)" strokeWidth="1.5" />}
            </g>
          )}
        </svg>
        {hover && (
          <div style={{
            position: "absolute", left: tipX, top: pT + 4,
            background: "var(--bg)", border: "1px solid var(--line)",
            borderRadius: 7, padding: "8px 11px", fontSize: 11, pointerEvents: "none",
            zIndex: 20, boxShadow: "0 4px 16px rgba(0,0,0,0.35)", minWidth: 168,
          }}>
            <div style={{ fontSize: 9, color: "var(--text-3)", marginBottom: 5, fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--line)", paddingBottom: 4 }}>
              {timeLbls.find((t) => t.i === hover.i)?.label || ""}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
              <span style={{ width: 10, height: 2, background: left.color, borderRadius: 1, flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: "var(--text-3)", flex: 1 }}>{left.label}</span>
              <span style={{ fontFamily: "var(--font-mono)", color: left.color }}>{(hovL || 0).toFixed(1)}%</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 10, height: 2, background: right.color, borderRadius: 1, flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: "var(--text-3)", flex: 1 }}>{right.label}</span>
              <span style={{ fontFamily: "var(--font-mono)", color: right.color }}>{(hovR || 0).toFixed(2)}%</span>
            </div>
          </div>
        )}
      </div>
      {caption && <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 10, lineHeight: 1.6, fontStyle: "italic" }}>{caption}</div>}
    </div>
  );
}
