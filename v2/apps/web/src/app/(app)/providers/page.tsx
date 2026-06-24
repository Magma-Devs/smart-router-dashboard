"use client";

import { useMemo, useState } from "react";
import { buildChainMetaByIndex, type MetricWindow, type ProviderMetrics, type RouterConfig } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ColumnChart } from "@/components/gateway/charts";
import { fmtMs, fmtNum, fmtPct } from "@/lib/format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "right", minWidth: 70 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-4)", fontWeight: 600 }}>{label}</div>
      <div className="gw-mono gw-tnum" style={{ fontSize: 14, marginTop: 4 }}>{value}</div>
    </div>
  );
}

/** A provider card: header row + endpoint URL sub-row(s). */
function ProviderCard({ p, url }: { p: ProviderMetrics; url?: string }) {
  const meta = buildChainMetaByIndex(p.spec);
  return (
    <div className="gw-card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 34, height: 34, borderRadius: 8, background: meta.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
          {p.endpointId.slice(0, 1).toUpperCase()}
        </span>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{p.endpointId}</span>
        <span className={`tag ${p.health === "operational" ? "tag--ok" : p.health === "unhealthy" ? "tag--err" : "tag--muted"}`} style={{ fontSize: 10 }}>
          {p.health === "operational" ? "healthy" : p.health === "unhealthy" ? "degraded" : "unknown"}
        </span>
        <div style={{ flex: 1 }} />
        <Stat label="Latency" value={fmtMs(p.p95Ms)} />
        <Stat label="Uptime" value={fmtPct(p.uptime)} />
        <Stat label="Req today" value={fmtNum(p.requests)} />
        <button className="gw-btn gw-btn--ghost" style={{ padding: 6, fontSize: 16, lineHeight: 1, marginLeft: 4 }}>···</button>
      </div>
      {/* Endpoint URL sub-row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", fontSize: 13 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 150 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.color }} />
          {meta.name}
          <span className="muted" style={{ fontSize: 11 }}>· {p.health === "operational" ? "primary" : "backup"}</span>
        </span>
        <span className="gw-mono muted" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url ?? "—"}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      </div>
    </div>
  );
}

export default function ProvidersPage() {
  const [window, setWindow] = useState<MetricWindow>("1d");
  const [query, setQuery] = useState("");
  const { data } = useApi<{ providers: ProviderMetrics[] }>(`/api/metrics/providers?window=${window}`);
  const config = useApi<{ routers: RouterConfig[] }>("/api/config/routers", 60000);

  // Map endpoint name → first node url (for the sub-row).
  const urlByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of config.data?.routers ?? []) for (const n of r.nodes) if (!m.has(n.name)) m.set(n.name, n.url);
    return m;
  }, [config.data]);

  const providers = (data?.providers ?? []).filter((p) => p.endpointId.toLowerCase().includes(query.toLowerCase()));
  const totalReq = providers.reduce((s, p) => s + p.requests, 0);
  const byProvider = [...providers].sort((a, b) => b.requests - a.requests);
  const maxReq = byProvider[0]?.requests || 1;
  const peakRps = data ? Math.max(0, ...(byProvider.map(() => 0))) : 0;

  return (
    <div className="gw-page">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>Providers</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-3)", fontSize: 13 }}>
            Backing RPC endpoints the router manages · <span className="gw-mono">live deployment</span>
          </p>
        </div>
        <button className="gw-btn gw-btn--primary" style={{ fontSize: 13, padding: "8px 14px" }}>+ Add provider</button>
      </div>

      {/* Search + filter */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
        <input
          className="gw-input"
          placeholder="Search providers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 380, height: 38 }}
        />
        <div className="gw-segctl">
          {(["1d", "7d"] as const).map((w) => (
            <button key={w} className={window === w ? "on" : ""} onClick={() => setWindow(w)}>{w === "1d" ? "24h" : "7d"}</button>
          ))}
        </div>
      </div>

      {/* Provider cards (full width) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {providers.map((p) => <ProviderCard key={`${p.spec}-${p.endpointId}`} p={p} url={urlByName.get(p.endpointId)} />)}
        {data && providers.length === 0 && <div className="gw-card muted">No providers reporting yet.</div>}
      </div>

      {/* Usage section */}
      <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em", margin: "28px 0 14px" }}>Usage</h2>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, alignItems: "start" }}>
        <div className="gw-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div className="kpi-label">Requests · {window === "1d" ? "last 24h" : "last 7d"}</div>
              <div className="gw-mono gw-tnum kpi-num" style={{ marginTop: 8 }}>{fmtNum(totalReq)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="kpi-label">Peak RPS</div>
              <div className="gw-mono gw-tnum" style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>{peakRps > 0 ? fmtNum(peakRps) : "—"}</div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <ColumnChart stacks={[{ name: "req", color: "var(--brand)", values: byProvider.map((p) => p.requests) }]} height={180} xLabels={undefined} />
          </div>
        </div>

        <div className="gw-card">
          <div className="kpi-label" style={{ marginBottom: 12 }}>By provider · req today</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {byProvider.map((p) => {
              const meta = buildChainMetaByIndex(p.spec);
              return (
                <div key={`${p.spec}-${p.endpointId}`}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.endpointId}</span>
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
  );
}
