"use client";

import type { TimePoint } from "@sr/shared";

/** Tiny inline trend line for table cells (the design's "Trend" column). */
export function TrendCell({
  points,
  color = "var(--brand)",
  width = 120,
  height = 28,
}: {
  points: TimePoint[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const vals = points.map((p) => p.v ?? 0);
  if (vals.length < 2) return <span className="muted">—</span>;
  const max = Math.max(...vals, 0.0001);
  const min = Math.min(...vals);
  const span = max - min || 1;
  const stepX = width / (vals.length - 1);
  const y = (v: number) => height - ((v - min) / span) * (height - 4) - 2;
  const line = vals.map((v, i) => `${i * stepX},${y(v)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
