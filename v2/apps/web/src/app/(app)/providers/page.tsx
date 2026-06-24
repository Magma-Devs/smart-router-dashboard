"use client";

import { useState } from "react";
import { buildChainMetaByIndex, type MetricWindow, type ProviderMetrics } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { fmtMs, fmtNum, fmtPct } from "@/lib/format";

/** One provider card (left column). */
function ProviderCard({ p }: { p: ProviderMetrics }) {
  const meta = buildChainMetaByIndex(p.spec);
  return (
    <div className="gw-card" style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <span style={{ width: 34, height: 34, borderRadius: 8, background: meta.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
        {p.endpointId.slice(0, 1).toUpperCase()}
      </span>
      <div style={{ minWidth: 0, flex: "0 0 200px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.endpointId}</span>
          <span className={`tag ${p.health === "operational" ? "tag--ok" : p.health === "unhealthy" ? "tag--err" : "tag--muted"}`} style={{ fontSize: 10 }}>
            {p.health === "operational" ? "healthy" : p.health === "unhealthy" ? "degraded" : "unknown"}
          </span>
        </div>
        <span className="muted mono" style={{ fontSize: 11 }}>{meta.name}</span>
      </div>
      <Stat label="Latency" value={fmtMs(p.p95Ms)} />
      <Stat label="Uptime" value={fmtPct(p.uptime)} />
      <Stat label="Req today" value={fmtNum(p.requests)} />
      <div style={{ flex: 1 }} />
      <button className="gw-btn gw-btn--ghost" style={{ padding: 6, fontSize: 16, lineHeight: 1 }}>···</button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: "0 0 84px" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-4)", fontWeight: 600 }}>{label}</div>
      <div className="gw-mono gw-tnum" style={{ fontSize: 14, marginTop: 3 }}>{value}</div>
    </div>
  );
}

export default function ProvidersPage() {
  const [window, setWindow] = useState<MetricWindow>("1d");
  const { data } = useApi<{ providers: ProviderMetrics[] }>(`/api/metrics/providers?window=${window}`);
  const providers = data?.providers ?? [];

  const totalReq = providers.reduce((s, p) => s + p.requests, 0);
  const byProvider = [...providers].sort((a, b) => b.requests - a.requests);
  const maxReq = byProvider[0]?.requests || 1;

  return (
    <div className="gw-page">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>Providers</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-3)", fontSize: 13 }}>Backing RPC endpoints the router manages, with live health and selection scores.</p>
        </div>
        <div className="gw-segctl">
          {(["1d", "7d"] as const).map((w) => (
            <button key={w} className={window === w ? "on" : ""} onClick={() => setWindow(w)}>{w === "1d" ? "24h" : "7d"}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, alignItems: "start" }}>
        {/* Left — provider cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {providers.map((p) => <ProviderCard key={`${p.spec}-${p.endpointId}`} p={p} />)}
          {data && providers.length === 0 && <div className="gw-card muted">No providers reporting yet.</div>}
        </div>

        {/* Right — summary + by-provider list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="gw-card">
            <div className="kpi-label">Requests · {window === "1d" ? "last 24h" : "last 7d"}</div>
            <div className="gw-mono gw-tnum kpi-num" style={{ marginTop: 8 }}>{fmtNum(totalReq)}</div>
            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 7 }}>{providers.length} active provider{providers.length === 1 ? "" : "s"}</div>
          </div>

          <div className="gw-card">
            <div className="kpi-label" style={{ marginBottom: 12 }}>By provider · req today</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {byProvider.map((p) => {
                const meta = buildChainMetaByIndex(p.spec);
                return (
                  <div key={`${p.spec}-${p.endpointId}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, overflow: "hidden" }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.endpointId}</span>
                      </span>
                      <span className="gw-mono gw-tnum muted">{fmtNum(p.requests)}</span>
                    </div>
                    <div className="gw-bar" style={{ height: 4 }}><span style={{ width: `${Math.round((p.requests / maxReq) * 100)}%`, background: meta.color }} /></div>
                  </div>
                );
              })}
              {byProvider.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No traffic yet.</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
