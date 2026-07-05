"use client";

import { toMetricWindow, WINDOW_OPTIONS, WINDOWS, type MetricWindow } from "@sr/shared";
import { ChainSelect, type ChainOption } from "./ChainSelect";

/* Ported verbatim from the design prototype (page-overview.jsx RouterHeader).
   The window <option> list comes from WINDOW_OPTIONS/WINDOWS, which match the
   design's 12 entries and labels exactly. */

export interface RouterHeaderProps {
  chains: ChainOption[];
  /** "all" or a spec label. */
  chainFilter: string;
  setChainFilter: (v: string) => void;
  timeWindow: MetricWindow;
  setTimeWindow: (w: MetricWindow) => void;
}

export function RouterHeader({ chains, chainFilter, setChainFilter, timeWindow, setTimeWindow }: RouterHeaderProps) {
  const sel: React.CSSProperties = { height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--surface)", color: "var(--text)", fontSize: 12, fontFamily: "inherit", cursor: "pointer" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>

      {/* Chain filter */}
      <ChainSelect value={chainFilter} onChange={setChainFilter} chains={chains} />

      <div style={{ flex: 1 }} />

      {/* Time window */}
      <select value={timeWindow} onChange={(e) => setTimeWindow(toMetricWindow(e.target.value))} style={{
        ...sel,
        paddingRight: 30,
        appearance: "none", WebkitAppearance: "none", MozAppearance: "none",
        backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 10px center",
      }}>
        {WINDOW_OPTIONS.map((v) => (
          <option key={v} value={v}>{WINDOWS[v].label}</option>
        ))}
      </select>

      {/* View full logs */}
      <a className="gw-btn gw-btn--primary" href="https://grafana.magmadevs.com/explore?schemaVersion=1&panes=%7B%22logs%22:%7B%22datasource%22:%22loki%22%7D%7D" target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
        View full logs ↗
      </a>
    </div>
  );
}
