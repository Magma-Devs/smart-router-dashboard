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

function StatCard({ title, value, sub, accent }: { title: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`gw-card${accent ? " gw-card--accent" : ""}`}>
      <p className="gw-card__title">{title}</p>
      <div className="gw-stat">{value}</div>
      {sub && <div className="gw-stat__sub">{sub}</div>}
    </div>
  );
}

export default function OverviewPage() {
  const [window, setWindow] = useState<MetricWindow>(DEFAULT_WINDOW);
  const summary = useApi<DashboardSummary>(`/api/metrics/dashboard-summary?window=${window}`);
  const chains = useApi<{ chains: ChainMetrics[] }>(`/api/metrics/chains?window=${window}`);

  const s = summary.data;

  return (
    <div className="gw-page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Overview</h1>
          <p className="lede">Smart Router health and traffic at a glance.</p>
        </div>
        <WindowSelector value={window} onChange={setWindow} />
      </div>

      <div className="gw-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 24 }}>
        <StatCard title="Requests served" value={fmtNum(s?.requestsServed)} sub={`across ${s?.providerCount ?? "—"} providers`} accent />
        <StatCard title="Success rate" value={fmtPct(s?.successRate)} sub="effective, after retries" />
        <StatCard title="Effective read p95" value={fmtMs(s?.effectiveReadP95Ms)} sub="blended latency" />
        <StatCard title="Stale responses caught" value={fmtNum(s?.staleResponsesCaught)} sub="consistency enforcement" />
        <StatCard title="Chains" value={String(s?.chainCount ?? "—")} sub={`${s?.providerCount ?? "—"} backing endpoints`} />
        <StatCard title="Status" value={s?.health === "operational" ? "Operational" : s?.health === "unhealthy" ? "Unhealthy" : "—"} sub="router overall health" />
      </div>

      <div className="gw-card" style={{ padding: 0 }}>
        <p className="gw-card__title" style={{ padding: "16px 18px 0" }}>Routers · how each chain performs</p>
        <table className="gw-table">
          <thead>
            <tr>
              <th>Router</th>
              <th>Providers</th>
              <th>Requests</th>
              <th>Availability</th>
              <th>P95</th>
              <th>Error rate</th>
              <th>QoS</th>
              <th>Latest block</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(chains.data?.chains ?? []).map((c) => (
              <tr key={c.spec}>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.color }} />
                    <strong>{c.name}</strong>
                    <span className="muted mono" style={{ fontSize: 11 }}>{c.spec}</span>
                  </span>
                </td>
                <td>{c.providerCount}</td>
                <td>{fmtNum(c.requests)}</td>
                <td>{fmtPct(c.availability)}</td>
                <td>{fmtMs(c.p95Ms)}</td>
                <td>{fmtPct(c.errorRate)}</td>
                <td>{c.qos === null ? <span className="muted">—</span> : c.qos.toFixed(2)}</td>
                <td className="mono">{fmtBlock(c.latestBlock)}</td>
                <td>
                  <span className={`tag ${c.health === "operational" ? "tag--ok" : c.health === "unhealthy" ? "tag--err" : "tag--muted"}`}>
                    {c.health === "operational" ? "Operational" : c.health === "unhealthy" ? "Unhealthy" : "Unknown"}
                  </span>
                </td>
              </tr>
            ))}
            {chains.data && chains.data.chains.length === 0 && (
              <tr><td colSpan={9} className="muted" style={{ textAlign: "center", padding: 32 }}>No chains are emitting metrics yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
