"use client";

import type { TimePoint } from "@sr/shared";

/** Lightweight inline SVG area chart — no chart-lib dependency. */
export function Sparkline({
  points,
  height = 140,
  color = "var(--brand)",
}: {
  points: TimePoint[];
  height?: number;
  color?: string;
}) {
  const vals = points.map((p) => p.v ?? 0);
  if (vals.length < 2) {
    return (
      <div className="muted" style={{ height, display: "grid", placeItems: "center", fontSize: 13 }}>
        Not enough data yet
      </div>
    );
  }
  const max = Math.max(...vals, 0.0001);
  const w = 600;
  const stepX = w / (vals.length - 1);
  const y = (v: number) => height - (v / max) * (height - 8) - 4;
  const line = vals.map((v, i) => `${i * stepX},${y(v)}`).join(" ");
  const area = `0,${height} ${line} ${w},${height}`;

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#spark-fill)" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
