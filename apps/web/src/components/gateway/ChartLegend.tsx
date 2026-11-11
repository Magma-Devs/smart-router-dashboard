/* The legend under a time chart and the chart-plus-legend row: the Upstreams
 * deep-dive's charts and a provider's graphs draw them alike. */

import type { ReactNode } from "react";
import { PAD_R, PAD_X } from "@/lib/chart-time";

export interface LegendRow {
  key: string;
  name: string;
  color: string;
  /** A count beside the name (the errors legend); the line legends name their lines only. */
  value?: string;
  selected?: boolean;
  /** A line for a line chart's series, a square for a bar chart's. */
  mark?: "line" | "box";
}

/**
 * The legend under a chart, one line left to right: which line is which. The
 * values themselves are read on the chart, beside the dots under the pointer
 * (LineChart pointLabels), where the eye already is. It starts where the plot
 * starts, and pointing at a name brings its line forward.
 */
export function LegendLine({ heading, rows, foot, onFocus }: {
  heading?: string;
  rows: LegendRow[];
  foot?: ReactNode;
  onFocus?: (key: string | null) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 18, rowGap: 6, marginTop: 6, paddingLeft: PAD_X, paddingRight: PAD_R }}>
      {heading && <span className="gw-mono" style={{ fontSize: 10, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{heading}</span>}
      {rows.map((r) => (
        <span key={r.key} onMouseEnter={onFocus ? () => onFocus(r.key) : undefined} onMouseLeave={onFocus ? () => onFocus(null) : undefined}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span style={{ width: r.mark === "box" ? 9 : 12, height: r.mark === "box" ? 9 : r.selected ? 3 : 2, borderRadius: r.mark === "box" ? 2 : 1, background: r.color, flexShrink: 0 }} />
          <span className={r.mark === "box" ? undefined : "gw-mono"} style={{ fontSize: 11, color: r.selected ? "var(--text)" : "var(--text-2)", fontWeight: r.selected ? 600 : 400, whiteSpace: "nowrap" }}>{r.name}</span>
          {r.value != null && <span className="gw-mono gw-tnum" style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{r.value}</span>}
        </span>
      ))}
      {foot && <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-4)" }}>{foot}</span>}
    </div>
  );
}

/** A chart, and its legend on one line under it. */
export function ChartRow({ height, chart, legend }: { height: number; chart: ReactNode; legend: ReactNode }) {
  return (
    <div>
      <div style={{ height }}>{chart}</div>
      {legend}
    </div>
  );
}
