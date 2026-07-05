"use client";

/* InteractiveChart — time x-axis + hover crosshair/readout.
   Ported 1:1 from the design prototype (SR_Dashboard/magma/page-metrics.jsx). */

import { useState } from "react";
import { useChartDims } from "@/components/gateway/charts";

export const RO_WIN_MS = {
  "5m": 3e5, "15m": 9e5, "30m": 18e5, "1h": 36e5, "3h": 108e5, "6h": 216e5,
  "12h": 432e5, "24h": 864e5, "1d": 864e5, "3d": 2592e5, "7d": 6048e5,
  "14d": 12096e5, "21d": 18144e5, "30d": 25920e5,
} as const;
export type RoWin = keyof typeof RO_WIN_MS;

export function roTimes(win: string, n: number): Date[] {
  const dur = (RO_WIN_MS as Record<string, number>)[win] || RO_WIN_MS["1d"];
  const now = Date.now(), step = dur / (n - 1);
  return Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * step));
}

export function roFmtTime(d: Date, win: string): string {
  const dur = (RO_WIN_MS as Record<string, number>)[win] || RO_WIN_MS["1d"];
  if (dur <= 864e5) return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (dur <= 6048e5) return d.toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export interface InteractiveChartTarget {
  value: number;
  color?: string;
  label?: string;
}

/* Interactive chart: time x-axis + hover crosshair/readout. */
export function InteractiveChart({
  values,
  color,
  yFmt,
  target,
  yDomain,
  times,
  win,
  height = 180,
}: {
  values: number[];
  color: string;
  yFmt?: (v: number) => string | number;
  target?: InteractiveChartTarget;
  yDomain?: [number, number];
  times: Date[];
  win: string;
  height?: number;
}) {
  const [wrapRef, w] = useChartDims(600, height);
  const [hov, setHov] = useState<number | null>(null);
  const n = values.length;
  const padL = 46, padR = 14, padTop = 12, padBot = 24;
  const iW = Math.max(10, w - padL - padR), iH = height - padTop - padBot;
  if (!n) return <div ref={wrapRef} style={{ position: "relative", width: "100%", height }} />;
  let minV = Math.min(...values), maxV = Math.max(...values);
  if (target && !yDomain) { minV = Math.min(minV, target.value); maxV = Math.max(maxV, target.value); }
  const pad = (maxV - minV) * 0.14 || 1;
  const dlo = yDomain ? yDomain[0] : minV - pad;
  const dhi = yDomain ? yDomain[1] : maxV + pad;
  const range = dhi - dlo || 1;
  const cx = (i: number) => padL + (n > 1 ? (i / (n - 1)) * iW : iW / 2);
  const cy = (v: number) => padTop + iH - ((v - dlo) / range) * iH;
  const fmt = yFmt || ((v: number) => Math.round(v));
  const gVals = Array.from({ length: 5 }, (_, i) => dlo + (range * i) / 4);
  const linePts = values.map((v, i) => `${cx(i).toFixed(1)},${cy(v).toFixed(1)}`).join(" ");
  const areaD = `M ${cx(0).toFixed(1)},${(padTop + iH).toFixed(1)} ` + values.map((v, i) => `L ${cx(i).toFixed(1)},${cy(v).toFixed(1)}`).join(" ") + ` L ${cx(n - 1).toFixed(1)},${(padTop + iH).toFixed(1)} Z`;
  const xticks = [0, Math.round((n - 1) * 0.25), Math.round((n - 1) * 0.5), Math.round((n - 1) * 0.75), n - 1];
  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    let idx = Math.round(((e.clientX - rect.left - padL) / iW) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    setHov(idx);
  }
  const tipRight = hov != null && cx(hov) > padL + iW * 0.6;
  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height }} onMouseMove={onMove} onMouseLeave={() => setHov(null)}>
      <svg width={w} height={height} style={{ display: "block" }}>
        {gVals.map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={padL + iW} y1={cy(v)} y2={cy(v)} stroke="var(--line)" strokeWidth="1" opacity="0.6" />
            <text x={padL - 6} y={cy(v) + 3} textAnchor="end" fontSize="9.5" fill="var(--text-3)" fontFamily="var(--font-mono)">{fmt(v)}</text>
          </g>
        ))}
        {target && (
          <>
            <line x1={padL} x2={padL + iW} y1={cy(target.value)} y2={cy(target.value)} stroke={target.color || "var(--text-4)"} strokeWidth="1" strokeDasharray="4 3" opacity="0.8" />
            {target.label && <text x={padL + iW} y={cy(target.value) - 4} textAnchor="end" fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)">{target.label}</text>}
          </>
        )}
        <path d={areaD} fill={color} opacity="0.10" />
        <polyline points={linePts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {xticks.map((ti, k) => (
          <text key={k} x={cx(ti)} y={padTop + iH + 15} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={k === 0 ? "start" : k === xticks.length - 1 ? "end" : "middle"}>{roFmtTime(times[ti]!, win)}</text>
        ))}
        {hov != null && (
          <>
            <line x1={cx(hov)} x2={cx(hov)} y1={padTop} y2={padTop + iH} stroke="var(--text-3)" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={cx(hov)} cy={cy(values[hov]!)} r="3.5" fill={color} stroke="var(--surface)" strokeWidth="1.5" />
          </>
        )}
      </svg>
      {hov != null && (
        <div style={{ position: "absolute", top: 6, left: cx(hov), transform: `translateX(${tipRight ? "-108%" : "8px"})`, pointerEvents: "none", background: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: 6, padding: "5px 9px", whiteSpace: "nowrap", boxShadow: "0 6px 18px rgba(0,0,0,0.35)" }}>
          <div style={{ color: "var(--text-4)", fontSize: 10, fontFamily: "var(--font-mono)" }}>{roFmtTime(times[hov]!, win)}</div>
          <div className="gw-mono gw-tnum" style={{ color: "var(--text)", fontWeight: 700, fontSize: 13 }}>{fmt(values[hov]!)}</div>
        </div>
      )}
    </div>
  );
}
