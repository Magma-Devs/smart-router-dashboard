"use client";

/* WebSocketPanel — live connections & subscriptions. Ported verbatim from the
 * design prototype (page-metrics.jsx WebSocketPanel). Live data:
 * /api/metrics/websocket. ws_* counters register only once a subscription
 * opens — until then the panel keeps full design chrome with "—" values. */

import { buildChainMetaByIndex, type MetricWindow, type WebSocketReport } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { Tip } from "@/components/gateway/Tip";
import { ThCol } from "@/components/gateway/SortTable";
import { fmtComma, fmtNum } from "@/lib/format";

const WS_TIP = "Long-lived WebSocket activity.\n\n**Active connections** is a live count — callers connected right now.\n\n**Subscriptions** and **subscription errors** are lifetime totals since the router started — these counters are too small for windowed math (a window misses the counter's very first increment). Error rate = errors ÷ subscriptions.";

export function WebSocketPanel({ tw }: { tw: MetricWindow }) {
  const { data: ws } = useApi<WebSocketReport>(`/api/metrics/websocket?window=${tw}`);

  const active = ws?.activeConnections ?? null;
  const subs = ws?.subscriptions ?? null;
  const errs = ws?.subscriptionErrors ?? null;
  const errRate = subs != null && subs > 0 && errs != null ? (errs / subs) * 100 : null;
  const errColor = (r: number) => (r < 0.5 ? "var(--ok)" : r < 1 ? "var(--warn)" : "var(--err)");

  return (
    <div className="gw-card" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)", display: "inline-flex", alignItems: "center", marginBottom: 18 }}>
        WebSocket · live connections & subscriptions<Tip text={WS_TIP} />
      </div>

      {/* 3 headline stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 20, marginBottom: 24, paddingBottom: 24, borderBottom: "1px solid var(--line)" }}>
        <div>
          <div className="gw-mono gw-tnum" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: active == null ? "var(--text-4)" : "var(--text)" }}>{active != null ? fmtComma(active) : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8, display: "inline-flex", alignItems: "center" }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: active != null ? "var(--ok)" : "var(--text-4)", boxShadow: active != null ? "0 0 6px var(--ok)" : "none", marginRight: 6 }} />active connections · now
          </div>
        </div>
        <div>
          <div className="gw-mono gw-tnum" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: subs == null ? "var(--text-4)" : "var(--text)" }}>{subs != null ? fmtNum(subs) : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>subscriptions · since router start</div>
        </div>
        <div>
          <div className="gw-mono gw-tnum" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: errRate != null ? errColor(errRate) : "var(--text-4)" }}>{errRate != null ? errRate.toFixed(2) + "%" : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>subscription error rate{errs != null ? <> · {fmtComma(Math.round(errs))} failed</> : null}</div>
        </div>
      </div>

      {/* per-chain breakdown */}
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-3)", marginBottom: 12 }}>
        By chain <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: "var(--text-4)" }}>— WebSocket-enabled routes</span>
      </div>
      <table className="gw-table">
        <thead>
          <tr>
            <ThCol>Chain</ThCol>
            <ThCol align="right">Active connections</ThCol>
            <ThCol align="right">Subscriptions</ThCol>
            <ThCol align="right">Sub error rate</ThCol>
          </tr>
        </thead>
        <tbody>
          {(ws?.byChain ?? []).map((c) => {
            const meta = buildChainMetaByIndex(c.spec);
            const rate = c.subscriptions > 0 ? (c.errors / c.subscriptions) * 100 : 0;
            return (
              <tr key={c.spec}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.color || "#888", flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>{meta.name}</span>
                  </div>
                </td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: c.active > 0 ? "var(--text-2)" : "var(--text-4)" }}>{fmtNum(c.active)}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--text-2)" }}>{fmtNum(c.subscriptions)}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12.5, fontWeight: 700, color: errColor(rate) }}>{rate.toFixed(2)}%</span></td>
              </tr>
            );
          })}
          {ws && ws.byChain.length === 0 && (
            <tr><td colSpan={4} style={{ padding: "20px 12px", textAlign: "center", color: "var(--text-4)", fontSize: 12.5 }}>
              {ws.emitted ? "No WebSocket subscriptions yet." : "ws_* counters appear once a subscription is opened on this build."}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
