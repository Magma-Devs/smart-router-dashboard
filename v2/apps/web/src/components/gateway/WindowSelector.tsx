"use client";

import { WINDOWS, type MetricWindow } from "@sr/shared";

const ORDER: MetricWindow[] = ["5m", "1h", "6h", "1d", "7d", "30d"];

export function WindowSelector({
  value,
  onChange,
}: {
  value: MetricWindow;
  onChange: (w: MetricWindow) => void;
}) {
  return (
    <div className="gw-seg" role="tablist" aria-label="Time window">
      {ORDER.map((w) => (
        <button
          key={w}
          className={w === value ? "active" : ""}
          onClick={() => onChange(w)}
          role="tab"
          aria-selected={w === value}
        >
          {WINDOWS[w].label}
        </button>
      ))}
    </div>
  );
}
