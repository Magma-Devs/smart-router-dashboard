"use client";

import { useEffect, useRef, useState } from "react";

/** Width-tracking hook (mirrors the design's useChartDims). */
function useChartWidth(fallback = 600): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(fallback);
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

/** Catmull-Rom → smoothed path. */
function smoothLine(pts: [number, number][]): string {
  if (pts.length < 2) return pts.length ? `M ${pts[0]![0]} ${pts[0]![1]}` : "";
  let d = `M ${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

const fmtY = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 1000) return (v / 1000).toFixed(1) + "k";
  if (a < 1 && a > 0) return v.toFixed(2);
  return Math.round(v).toString();
};

export function LineChart({
  series,
  height = 200,
  padX = 44,
  padY = 10,
  xLabels,
  yFmt,
  bgBands,
  gridCount = 4,
  id = "lc",
}: {
  series: Series[];
  height?: number;
  padX?: number;
  padY?: number;
  xLabels?: string[];
  yFmt?: (v: number) => string;
  bgBands?: BgBand[];
  gridCount?: number;
  id?: string;
}) {
  const [ref, w] = useChartWidth(600);
  const all = series.flatMap((s) => s.values).filter((v) => v != null && isFinite(v));
  if (!all.length) return <div ref={ref} style={{ width: "100%", height }} />;
  const lo = Math.min(...all) * 0.97;
  const hi = Math.max(...all) * 1.03;
  const range = hi - lo || 1;
  const n = Math.max(...series.map((s) => s.values.length));
  const iW = w - padX * 2;
  const iH = height - padY * 2 - (xLabels === undefined ? 0 : 18);
  const cx = (i: number) => padX + (n > 1 ? (i / (n - 1)) * iW : iW / 2);
  const cy = (v: number) => padY + iH - ((v - lo) / range) * iH;
  const single = series.filter((s) => s.values.length).length === 1;
  const baseY = padY + iH;
  const fmt = yFmt ?? fmtY;
  const gVals = Array.from({ length: gridCount + 1 }, (_, i) => lo + (range * i) / gridCount);

  return (
    <div ref={ref} style={{ width: "100%", height }}>
      <svg width={w} height={height} style={{ overflow: "visible", display: "block" }}>
        <defs>
          {series.map((s, si) => (
            <linearGradient key={si} id={`${id}g${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color ?? "var(--brand)"} stopOpacity={single ? 0.34 : 0.22} />
              <stop offset="55%" stopColor={s.color ?? "var(--brand)"} stopOpacity={single ? 0.1 : 0.06} />
              <stop offset="100%" stopColor={s.color ?? "var(--brand)"} stopOpacity="0" />
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
        {series.map((s, si) => {
          if (!s.values.length) return null;
          const doFill = s.fill !== undefined ? s.fill : single;
          if (!doFill) return null;
          const p = s.values.map((v, i) => [cx(i), cy(v)] as [number, number]);
          const last = p[p.length - 1]!;
          const first = p[0]!;
          const d = `${smoothLine(p)} L ${last[0].toFixed(1)} ${baseY.toFixed(1)} L ${first[0].toFixed(1)} ${baseY.toFixed(1)} Z`;
          return <path key={"a" + si} d={d} fill={`url(#${id}g${si})`} stroke="none" />;
        })}
        {series.map((s, si) =>
          s.values.length ? (
            <path
              key={si}
              d={smoothLine(s.values.map((v, i) => [cx(i), cy(v)]))}
              fill="none"
              stroke={s.color ?? "var(--brand)"}
              strokeWidth={s.width ?? 2}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={s.dashed ? "4 3" : undefined}
              opacity={s.opacity ?? 1}
            />
          ) : null,
        )}
        {xLabels?.map((lab, i, a) => (
          <text key={"x" + i} x={padX + (a.length > 1 ? (i / (a.length - 1)) * iW : iW / 2)} y={padY + iH + 13} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={i === 0 ? "start" : i === a.length - 1 ? "end" : "middle"}>{lab}</text>
        ))}
      </svg>
    </div>
  );
}

export function StackedAreaChart({
  layers,
  height = 200,
  padX = 44,
  padY = 10,
  xLabels,
  normalized = false,
}: {
  layers: Layer[];
  height?: number;
  padX?: number;
  padY?: number;
  xLabels?: string[];
  normalized?: boolean;
}) {
  const [ref, w] = useChartWidth(600);
  if (!layers.length || !layers[0]!.values.length) return <div ref={ref} style={{ width: "100%", height }} />;
  const n = layers[0]!.values.length;
  const iW = w - padX * 2;
  const iH = height - padY * 2 - (xLabels === undefined ? 0 : 18);
  const cumV = layers.map((_, li) =>
    Array.from({ length: n }, (__, i) => layers.slice(0, li + 1).reduce((s, l) => s + (l.values[i] || 0), 0)),
  );
  const maxV = normalized ? 100 : Math.max(...cumV[cumV.length - 1]!) * 1.05 || 1;
  const cx = (i: number) => padX + (n > 1 ? (i / (n - 1)) * iW : iW / 2);
  const cy = (v: number) => padY + iH - (v / maxV) * iH;
  const gVals = [0.25, 0.5, 0.75, 1.0].map((f) => maxV * f);
  const fmt = (v: number) => (normalized ? v.toFixed(0) + "%" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v).toString());

  // normalize each column to 100% when normalized
  const draw = layers.map((_, li) =>
    cumV[li]!.map((v, i) => {
      if (!normalized) return v;
      const total = cumV[cumV.length - 1]![i] || 1;
      return (v / total) * 100;
    }),
  );

  return (
    <div ref={ref} style={{ width: "100%", height }}>
      <svg width={w} height={height} style={{ overflow: "visible", display: "block" }}>
        {gVals.map((v, i) => (
          <g key={i}>
            <line x1={padX} x2={padX + iW} y1={cy(v)} y2={cy(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={padX - 5} y={cy(v) + 3} textAnchor="end" fontSize="9" fill="var(--text-3)" fontFamily="var(--font-mono)">{fmt(v)}</text>
          </g>
        ))}
        {layers.map((layer, li) => {
          const top = draw[li]!;
          const bot = li > 0 ? draw[li - 1]! : new Array(n).fill(0);
          const poly = [
            ...top.map((v, i) => `${cx(i).toFixed(1)},${cy(v).toFixed(1)}`),
            ...[...bot].reverse().map((v, i) => `${cx(n - 1 - i).toFixed(1)},${cy(v).toFixed(1)}`),
          ].join(" ");
          return <polygon key={li} points={poly} fill={layer.color} opacity="0.65" />;
        })}
        {xLabels?.map((lab, i, a) => (
          <text key={"x" + i} x={padX + (a.length > 1 ? (i / (a.length - 1)) * iW : iW / 2)} y={padY + iH + 13} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={i === 0 ? "start" : i === a.length - 1 ? "end" : "middle"}>{lab}</text>
        ))}
      </svg>
    </div>
  );
}

export function ColumnChart({
  stacks,
  height = 200,
  padX = 44,
  padY = 10,
  xLabels,
  highlightSpikes = false,
}: {
  stacks: Layer[];
  height?: number;
  padX?: number;
  padY?: number;
  xLabels?: string[];
  highlightSpikes?: boolean;
}) {
  const [ref, w] = useChartWidth(600);
  if (!stacks.length || !stacks[0]!.values.length) return <div ref={ref} style={{ width: "100%", height }} />;
  const n = stacks[0]!.values.length;
  const iW = w - padX * 2;
  const iH = height - padY * 2 - (xLabels === undefined ? 0 : 18);
  const totals = Array.from({ length: n }, (_, i) => stacks.reduce((s, l) => s + (l.values[i] || 0), 0));
  const maxV = Math.max(...totals) * 1.1 || 1;
  const avg = totals.reduce((a, b) => a + b, 0) / n;
  const barW = Math.max(2, iW / n - 2);
  const bx = (i: number) => padX + (i + 0.5) * (iW / n) - barW / 2;
  const gVals = [0.25, 0.5, 0.75, 1.0].map((f) => Math.round(maxV * f));

  return (
    <div ref={ref} style={{ width: "100%", height }}>
      <svg width={w} height={height} style={{ overflow: "visible", display: "block" }}>
        {gVals.map((v, i) => (
          <g key={i}>
            <line x1={padX} x2={padX + iW} y1={padY + iH - (v / maxV) * iH} y2={padY + iH - (v / maxV) * iH} stroke="var(--line)" strokeWidth="1" />
            <text x={padX - 5} y={padY + iH - (v / maxV) * iH + 3} textAnchor="end" fontSize="9" fill="var(--text-3)" fontFamily="var(--font-mono)">{v >= 1000 ? (v / 1000).toFixed(1) + "k" : v}</text>
          </g>
        ))}
        {totals.map((total, i) => {
          if (total === 0) return null;
          const isSpike = highlightSpikes && total > avg * 2.2;
          let cum = 0;
          return (
            <g key={i}>
              {stacks.map((s, si) => {
                const v = s.values[i] || 0;
                if (v === 0) return null;
                const bh = (v / maxV) * iH;
                const y = padY + iH - ((cum + v) / maxV) * iH;
                cum += v;
                return <rect key={si} x={bx(i)} y={y} width={barW} height={Math.max(bh, 0.5)} fill={isSpike ? "var(--warn)" : s.color} opacity={isSpike ? 0.88 : 0.7} rx={si === stacks.length - 1 ? 1.5 : 0} />;
              })}
            </g>
          );
        })}
        {xLabels?.map((lab, i, a) => (
          <text key={"x" + i} x={padX + (a.length > 1 ? (i / (a.length - 1)) * iW : iW / 2)} y={padY + iH + 13} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={i === 0 ? "start" : i === a.length - 1 ? "end" : "middle"}>{lab}</text>
        ))}
      </svg>
    </div>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  square?: boolean;
  dashed?: boolean;
}
export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
      {items.map((item, i) => (
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
