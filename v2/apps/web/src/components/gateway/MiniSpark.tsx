"use client";

import type { TimePoint } from "@sr/shared";

/** Tiny inline sparkline for KPI cards (line, optional fill). */
export function MiniSpark({
  points,
  color = "var(--brand)",
  width = 80,
  height = 28,
  fill = false,
}: {
  points: TimePoint[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
}) {
  const vals = points.map((p) => p.v ?? 0);
  if (vals.length < 2) return <span style={{ width, height, display: "inline-block" }} />;
  const max = Math.max(...vals, 0.0001);
  const min = Math.min(...vals);
  const span = max - min || 1;
  const stepX = width / (vals.length - 1);
  const y = (v: number) => height - ((v - min) / span) * (height - 4) - 2;
  const line = vals.map((v, i) => `${i * stepX},${y(v)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block" }}>
      {fill && <polygon points={`0,${height} ${line} ${width},${height}`} fill={color} opacity="0.12" />}
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Mini vertical bar chart (the per-chain latency cell in the design). */
export function MiniBars({
  points,
  color = "var(--brand)",
  width = 56,
  height = 22,
}: {
  points: TimePoint[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const vals = points.slice(-10).map((p) => p.v ?? 0);
  if (!vals.length) return <span style={{ width, height, display: "inline-block" }} />;
  const max = Math.max(...vals, 0.0001);
  const bw = width / vals.length;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      {vals.map((v, i) => {
        const h = Math.max(1, (v / max) * height);
        return <rect key={i} x={i * bw + 0.5} y={height - h} width={bw - 1} height={h} rx={0.5} fill={color} opacity={0.85} />;
      })}
    </svg>
  );
}
