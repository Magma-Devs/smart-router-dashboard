"use client";

import { useState } from "react";
import {
  DEFAULT_WINDOW,
  type ChainMetrics,
  type MethodUsage,
  type MetricWindow,
  type ProviderMetrics,
  type TrafficSummary,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { WindowSelector } from "@/components/gateway/WindowSelector";
import { Sparkline } from "@/components/gateway/Sparkline";
import { TrendCell } from "@/components/gateway/TrendCell";
import { fmtMs, fmtNum, fmtPct } from "@/lib/format";

type Tab = "overview" | "providers" | "errors" | "traffic";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "providers", label: "Providers" },
  { id: "errors", label: "Errors breakdown" },
  { id: "traffic", label: "Traffic" },
];

/** A panel whose backing metric isn't emitted on this build — shown honestly
 *  rather than with invented numbers (the "no synthetic data" rule). */
function GatedPanel({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="gw-card">
      <p className="gw-card__title">{title}</p>
      <div className="muted" style={{ padding: "20px 0", fontSize: 13 }}>
        Not emitted by this router build yet — {hint}
      </div>
    </div>
  );
}

export default function MetricsPage() {
  const [window, setWindow] = useState<MetricWindow>(DEFAULT_WINDOW);
  const [spec, setSpec] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("traffic");

  const traffic = useApi<TrafficSummary>(`/api/metrics/traffic?window=${window}`);
  const chains = useApi<{ chains: ChainMetrics[] }>(`/api/metrics/chains?window=${window}`);
  const providers = useApi<{ providers: ProviderMetrics[] }>(
    tab === "providers" ? `/api/metrics/providers?window=${window}` : null,
  );
  const methods = useApi<{ methods: MethodUsage[] }>(
    `/api/metrics/methods?window=${window}${spec ? `&spec=${spec}` : ""}`,
  );

  const t = traffic.data;
  const focused = t?.chains.find((c) => c.spec === spec);
  const chartPoints = focused?.trend ?? t?.aggregate ?? [];

  return (
    <div className="gw-page" style={{ maxWidth: 1280 }}>
      {/* Header — chain selector · window · View full logs */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <button className="gw-btn" onClick={() => setSpec(undefined)}>
          <span style={{ display: "inline-flex", gap: 3 }}>
            <span style={{ width: 4, height: 12, background: "#627EEA", borderRadius: 1 }} />
            <span style={{ width: 4, height: 12, background: "#14F195", borderRadius: 1 }} />
            <span style={{ width: 4, height: 12, background: "#0052FF", borderRadius: 1 }} />
          </span>
          {spec ?? "All chains"} ▾
        </button>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <WindowSelector value={window} onChange={setWindow} />
          <button className="gw-btn gw-btn--primary">View full logs ↗</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 22, borderBottom: "1px solid var(--line)", marginBottom: 22 }}>
        {TABS.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className="gw-btn gw-btn--ghost"
            style={{
              padding: "6px 0",
              borderRadius: 0,
              fontWeight: tab === tb.id ? 600 : 500,
              color: tab === tb.id ? "var(--text)" : "var(--text-3)",
              borderBottom: tab === tb.id ? "2px solid var(--brand)" : "2px solid transparent",
            }}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "traffic" && (
        <>
          {/* Requests / sec chart */}
          <div className="gw-card" style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <p className="gw-card__title" style={{ margin: 0 }}>Requests / sec</p>
              <div style={{ textAlign: "right" }}>
                <span className="gw-stat" style={{ fontSize: 22 }}>{fmtNum(focused?.rpsNow ?? t?.rpsNow)}</span>
                <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>
                  rps now · {t?.chainCount ?? "—"} chains
                </span>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <Sparkline points={chartPoints} height={200} />
            </div>
          </div>

          {/* By chain table */}
          <div className="gw-card" style={{ padding: 0 }}>
            <p className="gw-card__title" style={{ padding: "16px 18px 0" }}>
              By chain <span className="muted" style={{ textTransform: "none", fontWeight: 400 }}>— ranked by volume</span>
            </p>
            <table className="gw-table">
              <thead>
                <tr>
                  <th>Chain</th>
                  <th>Trend</th>
                  <th style={{ textAlign: "right" }}>RPS now</th>
                  <th style={{ textAlign: "right" }}>Requests</th>
                  <th style={{ textAlign: "right" }}>Share</th>
                </tr>
              </thead>
              <tbody>
                {(t?.chains ?? []).map((c) => (
                  <tr key={c.spec} style={{ cursor: "pointer" }} onClick={() => setSpec(c.spec)}>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color }} />
                        <strong>{c.name}</strong>
                        <span className="muted mono" style={{ fontSize: 11 }}>{c.spec}</span>
                      </span>
                    </td>
                    <td><TrendCell points={c.trend} color={c.color} /></td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtNum(c.rpsNow)}</td>
                    <td style={{ textAlign: "right" }}>{fmtNum(c.requests)}</td>
                    <td style={{ textAlign: "right" }}>{fmtPct(c.share, 1)}</td>
                  </tr>
                ))}
                {t && t.chains.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 32 }}>No traffic yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Cross-validation + WebSocket (gated — not emitted on this build) */}
          <div className="gw-grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 18 }}>
            <GatedPanel title="Cross-validation · response correctness" hint="enable cross-validation to populate consensus / disagreement rates" />
            <GatedPanel title="WebSocket · live connections & subscriptions" hint="ws_* counters appear once a subscription is opened" />
          </div>

          {/* Method-level breakdown */}
          <div className="gw-card" style={{ padding: 0, marginTop: 18 }}>
            <p className="gw-card__title" style={{ padding: "16px 18px 0" }}>Method-level breakdown</p>
            <table className="gw-table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Class</th>
                  <th style={{ textAlign: "right" }}>Requests</th>
                  <th style={{ textAlign: "right" }}>P95</th>
                  <th style={{ textAlign: "right" }}>Error rate</th>
                </tr>
              </thead>
              <tbody>
                {(methods.data?.methods ?? []).map((m) => (
                  <tr key={m.method}>
                    <td className="mono">{m.method}</td>
                    <td><span className="tag tag--muted">{m.class}</span></td>
                    <td style={{ textAlign: "right" }}>{fmtNum(m.requests)}</td>
                    <td style={{ textAlign: "right" }}>{fmtMs(m.p95Ms)}</td>
                    <td style={{ textAlign: "right" }}>{fmtPct(m.errorRate)}</td>
                  </tr>
                ))}
                {methods.data && methods.data.methods.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 24 }}>No per-method data emitted yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "overview" && (
        <div className="gw-card" style={{ padding: 0 }}>
          <p className="gw-card__title" style={{ padding: "16px 18px 0" }}>Per-chain breakdown</p>
          <table className="gw-table">
            <thead>
              <tr><th>Chain</th><th>Requests</th><th>Availability</th><th>P95</th><th>Error rate</th><th>QoS</th></tr>
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
                  <td>{fmtPct(c.errorRate)}</td>
                  <td>{c.qos === null ? <span className="muted">—</span> : c.qos.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "providers" && (
        <div className="gw-card" style={{ padding: 0 }}>
          <p className="gw-card__title" style={{ padding: "16px 18px 0" }}>Providers</p>
          <table className="gw-table">
            <thead>
              <tr><th>Provider</th><th>Chain</th><th>Requests</th><th>Composite QoS</th><th>Status</th></tr>
            </thead>
            <tbody>
              {(providers.data?.providers ?? []).map((p) => (
                <tr key={`${p.spec}-${p.endpointId}`}>
                  <td><strong>{p.endpointId}</strong></td>
                  <td className="mono">{p.spec}</td>
                  <td>{fmtNum(p.requests)}</td>
                  <td>{p.scores.composite === undefined ? <span className="muted">—</span> : p.scores.composite.toFixed(2)}</td>
                  <td>
                    <span className={`tag ${p.health === "operational" ? "tag--ok" : p.health === "unhealthy" ? "tag--err" : "tag--muted"}`}>
                      {p.health === "operational" ? "Live" : p.health === "unhealthy" ? "Down" : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "errors" && (
        <GatedPanel
          title="Errors breakdown"
          hint="node_errors_total / protocol_errors_total appear once a backing endpoint returns an error"
        />
      )}
    </div>
  );
}
