"use client";

import { useState } from "react";
import {
  DEFAULT_WINDOW,
  type ChainMetrics,
  type DashboardSummary,
  type MetricWindow,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { WindowSelector } from "@/components/gateway/WindowSelector";
import { fmtBlock, fmtMs, fmtNum, fmtPct } from "@/lib/format";

/** The Smart Router "pulse" — live status + per-chain health at a glance. */
export default function DashboardPage() {
  const [window, setWindow] = useState<MetricWindow>(DEFAULT_WINDOW);
  const summary = useApi<DashboardSummary>(`/api/metrics/dashboard-summary?window=${window}`);
  const chains = useApi<{ chains: ChainMetrics[] }>(`/api/metrics/chains?window=${window}`);
  const s = summary.data;

  return (
    <div className="gw-page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Dashboard</h1>
          <p className="lede">Live router pulse — health, traffic, and per-chain status.</p>
        </div>
        <WindowSelector value={window} onChange={setWindow} />
      </div>

      <div className="gw-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 24 }}>
        <div className="gw-card gw-card--accent">
          <p className="gw-card__title">Status</p>
          <div className="gw-stat" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={s?.health === "operational" ? "dot-ok" : s?.health === "unhealthy" ? "dot-err" : "dot-warn"} />
            {s?.health === "operational" ? "Operational" : s?.health === "unhealthy" ? "Unhealthy" : "—"}
          </div>
        </div>
        <div className="gw-card"><p className="gw-card__title">Requests</p><div className="gw-stat">{fmtNum(s?.requestsServed)}</div></div>
        <div className="gw-card"><p className="gw-card__title">Success rate</p><div className="gw-stat">{fmtPct(s?.successRate)}</div></div>
        <div className="gw-card"><p className="gw-card__title">Read p95</p><div className="gw-stat">{fmtMs(s?.effectiveReadP95Ms)}</div></div>
      </div>

      <div className="gw-card" style={{ padding: 0 }}>
        <p className="gw-card__title" style={{ padding: "16px 18px 0" }}>Chains</p>
        <table className="gw-table">
          <thead>
            <tr><th>Chain</th><th>Requests</th><th>Availability</th><th>P95</th><th>QoS</th><th>Latest block</th><th>Status</th></tr>
          </thead>
          <tbody>
            {(chains.data?.chains ?? []).map((c) => (
              <tr key={c.spec}>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color }} />
                    <strong>{c.name}</strong>
                    <span className="muted mono" style={{ fontSize: 11 }}>{c.spec}</span>
                  </span>
                </td>
                <td>{fmtNum(c.requests)}</td>
                <td>{fmtPct(c.availability)}</td>
                <td>{fmtMs(c.p95Ms)}</td>
                <td>{c.qos === null ? <span className="muted">—</span> : c.qos.toFixed(2)}</td>
                <td className="mono">{fmtBlock(c.latestBlock)}</td>
                <td>
                  <span className={`tag ${c.health === "operational" ? "tag--ok" : c.health === "unhealthy" ? "tag--err" : "tag--muted"}`}>
                    {c.health === "operational" ? "Operational" : c.health === "unhealthy" ? "Unhealthy" : "Unknown"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
