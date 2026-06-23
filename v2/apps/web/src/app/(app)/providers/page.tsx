"use client";

import { useState } from "react";
import {
  DEFAULT_WINDOW,
  SCORE_TYPES,
  type MetricWindow,
  type ProviderMetrics,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { WindowSelector } from "@/components/gateway/WindowSelector";
import { fmtBlock, fmtNum } from "@/lib/format";

function scoreBar(value: number | undefined) {
  if (value === undefined) return <span className="muted">—</span>;
  const pct = Math.round(value * 100);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 52, height: 6, borderRadius: 3, background: "var(--line-2)", overflow: "hidden" }}>
        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: "var(--brand)" }} />
      </span>
      <span className="mono" style={{ fontSize: 11 }}>{value.toFixed(2)}</span>
    </span>
  );
}

export default function ProvidersPage() {
  const [window, setWindow] = useState<MetricWindow>(DEFAULT_WINDOW);
  const providers = useApi<{ providers: ProviderMetrics[] }>(`/api/metrics/providers?window=${window}`);

  return (
    <div className="gw-page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Providers</h1>
          <p className="lede">Every backing RPC endpoint the router manages, with live selection scores.</p>
        </div>
        <WindowSelector value={window} onChange={setWindow} />
      </div>

      <div className="gw-card" style={{ padding: 0 }}>
        <table className="gw-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Chain</th>
              <th>Requests</th>
              <th>In-flight</th>
              <th>Latest block</th>
              {SCORE_TYPES.map((t) => (
                <th key={t} style={{ textTransform: "capitalize" }}>{t}</th>
              ))}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(providers.data?.providers ?? []).map((p) => (
              <tr key={`${p.spec}-${p.endpointId}`}>
                <td><strong>{p.endpointId}</strong></td>
                <td className="mono">{p.spec}</td>
                <td>{fmtNum(p.requests)}</td>
                <td>{p.inFlight}</td>
                <td className="mono">{fmtBlock(p.latestBlock)}</td>
                {SCORE_TYPES.map((t) => (
                  <td key={t}>{scoreBar(p.scores[t])}</td>
                ))}
                <td>
                  <span className={`tag ${p.health === "operational" ? "tag--ok" : p.health === "unhealthy" ? "tag--err" : "tag--muted"}`}>
                    {p.health === "operational" ? "Live" : p.health === "unhealthy" ? "Down" : "—"}
                  </span>
                </td>
              </tr>
            ))}
            {providers.data && providers.data.providers.length === 0 && (
              <tr><td colSpan={11} className="muted" style={{ textAlign: "center", padding: 32 }}>No providers reporting yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
