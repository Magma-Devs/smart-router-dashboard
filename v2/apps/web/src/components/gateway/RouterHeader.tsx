"use client";

import { useEffect, useState } from "react";
import { toMetricWindow, WINDOW_OPTIONS, WINDOWS, type MetricWindow } from "@sr/shared";
import { ChainSelect, type ChainOption } from "./ChainSelect";

/* Grafana base URL for the "View full logs" button. Resolved at runtime from
   /api/config (which reads DASHBOARD_GRAFANA_URL from the container env), so one
   published web image can point at any Grafana. Falls back to the build-time
   NEXT_PUBLIC_GRAFANA_URL, then to the bundled `logs` profile's :3001. */
const BUILD_GRAFANA_URL = process.env.NEXT_PUBLIC_GRAFANA_URL ?? "http://localhost:3001";

function useGrafanaUrl(): string {
  const [url, setUrl] = useState(BUILD_GRAFANA_URL);
  useEffect(() => {
    let alive = true;
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => {
        if (alive && typeof c?.grafanaUrl === "string" && c.grafanaUrl) setUrl(c.grafanaUrl);
      })
      .catch(() => {/* keep the build-time fallback */});
    return () => {
      alive = false;
    };
  }, []);
  return url;
}

/** Build the "Smart Router Dashboard Logs" board URL, scoped to the router
    service and the header's current time window. Mirrors the board's variables:
    var-service=router, var-search=<chain>, from=now-<window>s. */
function fullLogsHref(grafanaBase: string, timeWindow: MetricWindow, chainFilter: string): string {
  const rangeSeconds = WINDOWS[timeWindow].rangeSeconds;
  const params = new URLSearchParams({
    orgId: "1",
    from: `now-${rangeSeconds}s`,
    to: "now",
    timezone: "browser",
    "var-service": "router",
    // A specific chain seeds the board's regex search; "all" leaves it empty.
    "var-search": chainFilter === "all" ? "" : chainFilter,
    refresh: "5s",
  });
  return `${grafanaBase.replace(/\/$/, "")}/?${params.toString()}`;
}

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
  const grafanaBase = useGrafanaUrl();
  const logsHref = fullLogsHref(grafanaBase, timeWindow, chainFilter);
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

      {/* View full logs — links to the Grafana logs board (base URL from
          /api/config → DASHBOARD_GRAFANA_URL), scoped to the current window. */}
      <a className="gw-btn gw-btn--primary" href={logsHref} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, padding: "5px 12px", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
        View full logs ↗
      </a>
    </div>
  );
}
