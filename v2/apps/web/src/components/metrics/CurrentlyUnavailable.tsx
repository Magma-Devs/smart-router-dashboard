"use client";

/* CurrentlyUnavailable — chains whose every backing endpoint is down.
 * Ported verbatim from the design prototype (page-metrics.jsx). Exception-
 * based: renders nothing when every route is reachable. Live data:
 * /api/metrics/unavailable. `sinceSeconds` is null when the outage start
 * isn't cheaply derivable — the "down Xm" text is omitted then. */

import type { UnavailableChain } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { fmtSince } from "./bits";

export function CurrentlyUnavailable() {
  const { data } = useApi<{ unavailable: UnavailableChain[] }>("/api/metrics/unavailable");
  const rows = data?.unavailable ?? [];
  if (!rows.length) return null; // only appears when a route is genuinely down
  return (
    <div className="gw-card" style={{ marginBottom: 14, padding: 0, overflow: "hidden", border: "1px solid rgba(239,68,68,0.35)" }}>
      <div style={{ padding: "11px 16px", borderBottom: "1px solid rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.07)", display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--err)", boxShadow: "0 0 8px var(--err)", flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--err)" }}>Currently unavailable</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {rows.map((r, i) => (
          <div key={r.spec} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 16px", borderBottom: i < rows.length - 1 ? "1px solid var(--line)" : "none" }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: r.color || "#888", flexShrink: 0 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 150 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
              <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "1px 6px", borderRadius: 4, color: "var(--err)", background: "rgba(239,68,68,0.12)" }}>Unavailable</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 500 }}>No other node available for this chain</span>
            </div>
            {r.sinceSeconds != null && (
              <div className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--err)", fontWeight: 700, flexShrink: 0 }}>down {fmtSince(r.sinceSeconds)}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
