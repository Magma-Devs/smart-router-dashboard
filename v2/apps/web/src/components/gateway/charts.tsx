"use client";

/* charts.tsx — reusable SVG chart primitives for Smart Router dashboard.
   Ported 1:1 from the design prototype (SR_Dashboard/magma/charts.jsx). */

import { useEffect, useRef, useState } from "react";

/* default x-axis tick labels — charts hold ~24h of hourly data */
export const X_DEFAULT = ["−24h", "−18h", "−12h", "−6h", "now"];

/* ── observe container w + h ─────────────────────────────────────────── */
export function useChartDims(
  fw = 600,
  fh = 200,
): [React.RefObject<HTMLDivElement | null>, number, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(fw);
  const [h, setH] = useState(fh);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      const cw = Math.max(200, e.contentRect.width);
      const ch = e.contentRect.height;
      setW(cw);
      if (ch > 40) setH(ch);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w, h];
}

/* ── 0→1 animation progress ─────────────────────────────────────────── */
export function useAnimProg(key: string | number, ms = 700): number {
  const [p, setP] = useState(0);
  useEffect(() => {
    setP(0);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const v = Math.min(1, (t - t0) / ms);
      setP(v);
      if (v < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return p;
}

/* ── smooth path (Catmull-Rom → bezier) ─────────────────────────────── */
function smoothLine(pts: [number, number][], tension = 0.16): string {
  if (pts.length < 2) return pts.length ? `M ${pts[0]![0]} ${pts[0]![1]}` : "";
  let d = `M ${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) * tension;
    const c1y = p1[1] + (p2[1] - p0[1]) * tension;
    const c2x = p2[0] - (p3[0] - p1[0]) * tension;
    const c2y = p2[1] - (p3[1] - p1[1]) * tension;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

export interface Series {
  values: number[];
  color?: string;
  width?: number;
  fill?: boolean;
  dashed?: boolean;
  opacity?: number;
}
export interface Layer {
  name: string;
  values: number[];
  color: string;
}
export interface BgBand {
  lo: number;
  hi: number;
  fill: string;
}
export interface ChartTarget {
  value: number;
  color?: string;
  label?: string;
}

/* ── LineChart ───────────────────────────────────────────────────────── */
/* series: [{values, color, dashed, width, opacity, fill}]
   bgBands: [{lo, hi, fill}]   target: {value, color, label} */
export function LineChart({
  series,
  height,
  padX = 40,
  padY = 10,
  xLabels,
  yFmt,
  target,
  bgBands,
  id = "lc",
  gridCount = 4,
  yDomain,
}: {
  series: Series[];
  height?: number;
  padX?: number;
  padY?: number;
  /** null ⇒ no x labels (and no reserved space); undefined ⇒ X_DEFAULT */
  xLabels?: string[] | null;
  yFmt?: (v: number) => string;
  target?: ChartTarget;
  bgBands?: BgBand[];
  id?: string;
  gridCount?: number;
  yDomain?: [number, number];
}) {
  const [ref, w, oh] = useChartDims(600, height || 200);
  const h = height || oh;
  const prog = useAnimProg(id + (series?.[0]?.values?.length ?? 0));

  const containerStyle: React.CSSProperties = { width: "100%", height: height ? height : "100%", overflow: "hidden" };
  if (!series?.length) return <div ref={ref} style={containerStyle} />;

  const all = series.flatMap((s) => s.values ?? []).filter((v) => v != null && isFinite(v));
  if (!all.length) return <div ref={ref} style={containerStyle} />;

  const lo = yDomain ? yDomain[0] : Math.min(...all) * 0.97,
    hi = yDomain ? yDomain[1] : Math.max(...all) * 1.03,
    range = hi - lo || 1;
  const n = Math.max(...series.map((s) => s.values?.length ?? 0));
  const iW = w - padX * 2,
    iH = h - padY * 2 - (xLabels === null ? 0 : 18);
  const cx = (i: number) => padX + (n > 1 ? (i / (n - 1)) * iW : iW / 2);
  const cy = (v: number) => padY + iH - ((v - lo) / range) * iH;
  const ptsArr = (vals: number[]) => vals.map((v, i) => [cx(i), cy(v)] as [number, number]);
  const baseY = padY + iH;
  const clipId = `${id}cp`;
  // fill the area under a series when it's the only line, or when explicitly asked
  const single = series.filter((s) => s.values?.length).length === 1;
  const fmt =
    yFmt ||
    ((v: number) => {
      const a = Math.abs(v);
      if (a >= 1000) return (v / 1000).toFixed(1) + "k";
      if (a < 1) return v.toFixed(2);
      return Math.round(v).toString();
    });
  const gVals = Array.from({ length: gridCount + 1 }, (_, i) => lo + (range * i) / gridCount);

  return (
    <div ref={ref} style={containerStyle}>
      <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
        <defs>
          <clipPath id={clipId}>
            <rect x={padX} y={padY - 4} width={Math.max(0, iW * prog)} height={iH + 8} />
          </clipPath>
          {series.map((s, si) => (
            <linearGradient key={si} id={`${id}g${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color || "var(--brand)"} stopOpacity={single ? 0.34 : 0.22} />
              <stop offset="55%" stopColor={s.color || "var(--brand)"} stopOpacity={single ? 0.1 : 0.06} />
              <stop offset="100%" stopColor={s.color || "var(--brand)"} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {bgBands?.map((b, bi) => {
          const yTop = cy(Math.min(hi, b.hi));
          const yBot = cy(Math.max(lo, b.lo));
          return <rect key={bi} x={padX} y={yTop} width={iW} height={Math.max(0, yBot - yTop)} fill={b.fill} opacity="0.09" />;
        })}
        {gVals.map((v, i) => (
          <g key={i}>
            <line x1={padX} x2={padX + iW} y1={cy(v)} y2={cy(v)} stroke="var(--line)" strokeWidth="1" opacity="0.6" />
            <text x={padX - 5} y={cy(v) + 3} textAnchor="end" fontSize="9" fill="var(--text-3)" fontFamily="var(--font-mono)">{fmt(v)}</text>
          </g>
        ))}
        {target && (
          <>
            <line x1={padX} x2={padX + iW} y1={cy(target.value)} y2={cy(target.value)}
              stroke={target.color || "var(--ok)"} strokeWidth="1" strokeDasharray="4 3" opacity="0.7" />
            {target.label && (
              <text x={padX + iW + 3} y={cy(target.value) + 3} fontSize="9"
                fill={target.color || "var(--ok)"} fontFamily="var(--font-mono)">{target.label}</text>
            )}
          </>
        )}
        <g clipPath={`url(#${clipId})`}>
          {/* area fills (decaying gradient) */}
          {series.map((s, si) => {
            if (!s.values?.length) return null;
            const doFill = s.fill !== undefined ? s.fill : single;
            if (!doFill) return null;
            const p = ptsArr(s.values);
            const d = `${smoothLine(p)} L ${p[p.length - 1]![0].toFixed(1)} ${baseY.toFixed(1)} L ${p[0]![0].toFixed(1)} ${baseY.toFixed(1)} Z`;
            return <path key={"a" + si} d={d} fill={`url(#${id}g${si})`} stroke="none" />;
          })}
          {/* lines */}
          {series.map((s, si) =>
            s.values?.length ? (
              <path key={si} d={smoothLine(ptsArr(s.values))} fill="none"
                stroke={s.color || "var(--brand)"} strokeWidth={s.width || 2}
                strokeLinejoin="round" strokeLinecap="round"
                strokeDasharray={s.dashed ? "4 3" : undefined}
                opacity={s.opacity ?? 1} />
            ) : null,
          )}
          {/* end-point marker on single-series charts */}
          {single &&
            (() => {
              const s = series.find((x) => x.values?.length);
              if (!s) return null;
              const lastI = s.values.length - 1;
              return <circle cx={cx(lastI)} cy={cy(s.values[lastI]!)} r="3" fill={s.color || "var(--brand)"} stroke="var(--surface)" strokeWidth="1.5" />;
            })()}
        </g>
        {xLabels !== null && (xLabels || X_DEFAULT).map((lab, _i, _a) => (
          <text key={"x" + _i} x={padX + (_a.length > 1 ? (_i / (_a.length - 1)) * iW : iW / 2)} y={padY + iH + 13} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={_i === 0 ? "start" : _i === _a.length - 1 ? "end" : "middle"}>{lab}</text>
        ))}
      </svg>
    </div>
  );
}

/* ── StackedAreaChart ────────────────────────────────────────────────── */
/* layers: [{name, values, color}] — bottom layer first */
export function StackedAreaChart({
  layers,
  height,
  padX = 40,
  padY = 10,
  xLabels,
  normalized = false,
  id = "sa",
}: {
  layers: Layer[];
  height?: number;
  padX?: number;
  padY?: number;
  /** null ⇒ no x labels (and no reserved space); undefined ⇒ X_DEFAULT */
  xLabels?: string[] | null;
  normalized?: boolean;
  id?: string;
}) {
  const [ref, w, oh] = useChartDims(600, height || 200);
  const h = height || oh;
  const prog = useAnimProg(id + (layers?.[0]?.values?.length ?? 0));

  const containerStyle: React.CSSProperties = { width: "100%", height: height ? height : "100%", overflow: "hidden" };
  if (!layers?.length || !layers[0]!.values?.length) return <div ref={ref} style={containerStyle} />;

  const n = layers[0]!.values.length;
  const iW = w - padX * 2,
    iH = h - padY * 2 - (xLabels === null ? 0 : 18);
  const cumV = layers.map((_, li) =>
    Array.from({ length: n }, (__, i) => layers.slice(0, li + 1).reduce((s, l) => s + (l.values[i] || 0), 0)),
  );
  const maxV = normalized ? 100 : Math.max(...cumV[cumV.length - 1]!) * 1.05 || 1;
  const cx = (i: number) => padX + (n > 1 ? (i / (n - 1)) * iW : iW / 2);
  const cy = (v: number) => padY + iH - (v / maxV) * iH;
  const clipId = `${id}cp`;
  const gVals = [0.25, 0.5, 0.75, 1.0].map((f) => maxV * f);
  const fmt = (v: number) => (normalized ? v.toFixed(0) + "%" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v).toString());

  return (
    <div ref={ref} style={containerStyle}>
      <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
        <defs>
          <clipPath id={clipId}><rect x={padX} y={padY} width={Math.max(0, iW * prog)} height={iH + 2} /></clipPath>
        </defs>
        {gVals.map((v, i) => (
          <g key={i}>
            <line x1={padX} x2={padX + iW} y1={cy(v)} y2={cy(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={padX - 5} y={cy(v) + 3} textAnchor="end" fontSize="9" fill="var(--text-3)" fontFamily="var(--font-mono)">{fmt(v)}</text>
          </g>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {layers.map((layer, li) => {
            const top = cumV[li]!;
            const bot = li > 0 ? cumV[li - 1]! : Array<number>(n).fill(0);
            const poly = [
              ...top.map((v, i) => `${cx(i).toFixed(1)},${cy(v).toFixed(1)}`),
              ...[...bot].reverse().map((v, i) => `${cx(n - 1 - i).toFixed(1)},${cy(v).toFixed(1)}`),
            ].join(" ");
            const topLine = top.map((v, i) => `${cx(i).toFixed(1)},${cy(v).toFixed(1)}`).join(" ");
            return (
              <g key={li}>
                <polygon points={poly} fill={layer.color} opacity="0.65" />
                <polyline points={topLine} fill="none" stroke={layer.color} strokeWidth="1" opacity="0.9" />
              </g>
            );
          })}
        </g>
        {xLabels !== null && (xLabels || X_DEFAULT).map((lab, _i, _a) => (
          <text key={"x" + _i} x={padX + (_a.length > 1 ? (_i / (_a.length - 1)) * iW : iW / 2)} y={padY + iH + 13} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={_i === 0 ? "start" : _i === _a.length - 1 ? "end" : "middle"}>{lab}</text>
        ))}
      </svg>
    </div>
  );
}

/* ── ColumnChart ─────────────────────────────────────────────────────── */
/* stacks: [{name, values, color}] — bottom to top */
export function ColumnChart({
  stacks,
  height,
  padX = 40,
  padY = 10,
  xLabels,
  highlightSpikes = false,
  id = "col",
}: {
  stacks: Layer[];
  height?: number;
  padX?: number;
  padY?: number;
  /** null ⇒ no x labels (and no reserved space); undefined ⇒ X_DEFAULT */
  xLabels?: string[] | null;
  highlightSpikes?: boolean;
  id?: string;
}) {
  const [ref, w, oh] = useChartDims(600, height || 160);
  const h = height || oh;
  const prog = useAnimProg(id + (stacks?.[0]?.values?.length ?? 0));
  const [hov, setHov] = useState<number | null>(null);

  const containerStyle: React.CSSProperties = { width: "100%", height: height ? height : "100%", overflow: "hidden" };
  if (!stacks?.length || !stacks[0]!.values?.length) return <div ref={ref} style={containerStyle} />;

  const n = stacks[0]!.values.length;
  const iW = w - padX * 2,
    iH = h - padY * 2 - (xLabels === null ? 0 : 18);
  const totals = Array.from({ length: n }, (_, i) => stacks.reduce((s, l) => s + (l.values[i] || 0), 0));
  const maxV = Math.max(...totals) * 1.1 || 1;
  const avg = totals.reduce((a, b) => a + b, 0) / n;
  const barW = Math.max(2, iW / n - 2);
  const bx = (i: number) => padX + (i + 0.5) * (iW / n) - barW / 2;
  const cy = (v: number) => padY + iH - (v / maxV) * iH;
  const gVals = [0.25, 0.5, 0.75, 1.0].map((f) => Math.round(maxV * f));

  return (
    <div ref={ref} style={containerStyle}>
      <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
        {gVals.map((v, i) => (
          <g key={i}>
            <line x1={padX} x2={padX + iW} y1={cy(v)} y2={cy(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={padX - 5} y={cy(v) + 3} textAnchor="end" fontSize="9" fill="var(--text-3)" fontFamily="var(--font-mono)">
              {v >= 1000 ? (v / 1000).toFixed(1) + "k" : v}
            </text>
          </g>
        ))}
        {totals.map((total, i) => {
          if (total === 0 || i / n > prog) return null;
          const isSpike = highlightSpikes && total > avg * 2.2;
          let cum = 0;
          return (
            <g key={i} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
              {stacks.map((s, si) => {
                const v = s.values[i] || 0;
                if (v === 0) { cum += v; return null; }
                const bh = (v / maxV) * iH;
                const y = padY + iH - ((cum + v) / maxV) * iH;
                cum += v;
                return (
                  <rect key={si} x={bx(i)} y={y} width={barW} height={Math.max(bh, 0.5)}
                    fill={isSpike ? "var(--warn)" : s.color} opacity={isSpike ? 0.88 : 0.7}
                    rx={si === stacks.length - 1 ? 1.5 : 0} />
                );
              })}
              {hov === i && <rect x={bx(i) - 1} y={padY} width={barW + 2} height={iH} fill="white" opacity="0.04" rx="2" />}
            </g>
          );
        })}
        {xLabels !== null && (xLabels || X_DEFAULT).map((lab, _i, _a) => (
          <text key={"x" + _i} x={padX + (_a.length > 1 ? (_i / (_a.length - 1)) * iW : iW / 2)} y={padY + iH + 13} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={_i === 0 ? "start" : _i === _a.length - 1 ? "end" : "middle"}>{lab}</text>
        ))}
      </svg>
    </div>
  );
}

/* ── SparkLine ───────────────────────────────────────────────────────── */
export function SparkLine({
  values,
  color = "var(--brand)",
  width = 60,
  height = 22,
}: {
  values?: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (!values?.length || values.length < 2) return null;
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / range) * (height - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block", flexShrink: 0, opacity: 0.75 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── ChartLegend ─────────────────────────────────────────────────────── */
export interface LegendItem {
  label: string;
  color: string;
  square?: boolean;
  dashed?: boolean;
}
export function ChartLegend({ items, style }: { items: LegendItem[]; style?: React.CSSProperties }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", ...style }}>
      {(items || []).map((item, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-3)" }}>
          <span
            style={{
              display: "inline-block",
              flexShrink: 0,
              width: item.square ? 8 : 14,
              height: item.square ? 8 : 2,
              borderRadius: item.square ? 2 : 0,
              background: item.dashed ? "transparent" : item.color,
              borderTop: item.dashed ? `2px dashed ${item.color}` : undefined,
              opacity: item.square ? 0.8 : 1,
            }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
