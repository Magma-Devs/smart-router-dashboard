"use client";

/* PMRoster — every provider matching the filters, key health at a glance.
 * Ported verbatim from the design prototype (page-provider-metrics.jsx
 * PMRoster); rows are live /api/metrics/providers. Sorting uses the ported
 * useSort/ThCol with a hidden `natural` key so the initial order matches the
 * API's (requests desc), like the design's unsorted default. */

import { useEffect, useState } from "react";
import { buildChainMetaByIndex, type MetricWindow, type ProviderMetrics } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { Tip } from "@/components/gateway/Tip";
import { ThCol, useSort } from "@/components/gateway/SortTable";

interface RosterRow {
  pm: ProviderMetrics;
  name: string;
  chainName: string;
  chainColor: string;
  hasData: boolean;
  qosVal: number | null;
  /* flat sort accessors (design SV semantics) */
  natural: number;
  provider: string;
  chain: string;
  block: number;
  requests: number;
  uptime: number;
  latency: number;
  err: number;
  qos: number;
}

export function PMRoster({ rows, activeName, onSelect, timeWindow }: {
  rows: ProviderMetrics[];
  activeName: string | null;
  onSelect: (name: string) => void;
  timeWindow: MetricWindow;
}) {
  const statusDot = (h: ProviderMetrics["health"]) => ({ operational: "var(--ok)", unhealthy: "var(--err)", unknown: "var(--text-4)" }[h] || "var(--ok)");
  const fmtReq = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : Math.round(n).toString());
  const fmtBlock = (n: number) => n.toLocaleString("en-US");
  const PAGE = 8;
  const [page, setPage] = useState(0);

  const built: RosterRow[] = rows.map((v, i) => {
    const meta = buildChainMetaByIndex(v.spec);
    const qosVal = v.scores.composite != null ? v.scores.composite * 100 : null;
    return {
      pm: v,
      name: v.endpointId,
      chainName: meta.name,
      chainColor: meta.color,
      hasData: v.requests > 0,
      qosVal,
      natural: i,
      provider: v.endpointId.toLowerCase(),
      chain: meta.name.toLowerCase(),
      block: v.latestBlock ?? -1,
      requests: v.requests || 0,
      uptime: v.uptime ?? -1,
      latency: v.p95Ms ?? Infinity,
      err: v.errorRate ?? -1,
      qos: qosVal ?? -1,
    };
  });

  const { sorted, sort, onSort } = useSort<RosterRow>(built, { key: "natural", dir: "asc" });
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE));
  const curPage = Math.min(page, pageCount - 1);
  useEffect(() => { setPage(0); }, [rows.length, sort.key, sort.dir]);
  const pageRows = sorted.slice(curPage * PAGE, curPage * PAGE + PAGE);

  return (
    <div className="gw-card" style={{ padding: 0, overflow: "hidden", marginBottom: 18 }}>
      <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>All providers</span>
        <Tip text="Every provider × chain you've configured. Uptime reflects the time window selected above. Click a row to drill into its full metrics below." />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--text-3)" }}>{rows.length} provider{rows.length === 1 ? "" : "s"} · uptime over {timeWindow}</span>
      </div>
      <table className="gw-table">
        <thead>
          <tr>
            <ThCol sortKey="provider" sort={sort} onSort={onSort}>Provider</ThCol>
            <ThCol sortKey="chain" sort={sort} onSort={onSort}>Chain</ThCol>
            <ThCol align="right" sortKey="block" sort={sort} onSort={onSort}>Latest block</ThCol>
            <ThCol align="right" sortKey="requests" sort={sort} onSort={onSort}>Total requests</ThCol>
            <ThCol align="right" sortKey="uptime" sort={sort} onSort={onSort}>Uptime</ThCol>
            <ThCol align="right" sortKey="latency" sort={sort} onSort={onSort}>Latency</ThCol>
            <ThCol align="right" sortKey="err" sort={sort} onSort={onSort}>Error rate</ThCol>
            <ThCol align="right" sortKey="qos" sort={sort} onSort={onSort}>QoS</ThCol>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((r) => {
            const v = r.pm;
            const on = r.name === activeName;
            const muted = !r.hasData;
            return (
              <tr key={r.name} onClick={() => onSelect(r.name)} style={{ cursor: "pointer", background: on ? "rgba(255,57,0,0.06)" : undefined, boxShadow: on ? "inset 2px 0 0 var(--brand)" : undefined }}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: statusDot(v.health), flexShrink: 0 }} title={v.health} />
                    <span style={{ fontSize: 13, fontWeight: on ? 700 : 500 }}>{r.name}</span>
                    {v.role && <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "1px 6px", borderRadius: 4, color: v.role === "primary" ? "#60a5fa" : "#fb923c", background: v.role === "primary" ? "rgba(96,165,250,0.1)" : "rgba(251,146,60,0.1)" }}>{v.role === "primary" ? "Primary" : "Backup"}</span>}
                  </div>
                </td>
                <td>
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 2, background: r.chainColor || "#888", flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: "var(--text-2)" }}>{r.chainName}</span>
                  </span>
                </td>
                <td style={{ textAlign: "right" }}>
                  {v.latestBlock != null ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                      <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--text)" }}>{fmtBlock(v.latestBlock)}</span>
                    </span>
                  ) : <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>}
                </td>
                {muted ? (
                  <td colSpan={5} style={{ textAlign: "right", color: "var(--warn)", fontSize: 12, fontStyle: "italic", opacity: 0.9 }}>
                    {v.role === "backup" ? "No recent traffic — standing by as backup" : "No recent traffic in this window"}
                  </td>
                ) : (
                  <>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--text)" }}>{fmtReq(v.requests)}</span></td>
                    <td style={{ textAlign: "right" }}>{(() => { const a = v.uptime != null ? v.uptime * 100 : null; return a != null ? <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: a >= 99.9 ? "var(--ok)" : a >= 99 ? "var(--warn)" : "var(--err)" }}>{a.toFixed(2)}%</span> : <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>; })()}</td>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{v.p95Ms != null ? Math.round(v.p95Ms) + " ms" : "—"}</span></td>
                    <td style={{ textAlign: "right" }}>{(() => { const e = v.errorRate != null ? v.errorRate * 100 : null; return e != null ? <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: e < 0.5 ? "var(--text-3)" : e < 1.5 ? "var(--warn)" : "var(--err)" }}>{e.toFixed(2)}%</span> : <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>; })()}</td>
                    <td style={{ textAlign: "right" }}>{r.qosVal != null ? <span className="gw-mono gw-tnum" style={{ fontSize: 13, fontWeight: 700, color: r.qosVal > 97 ? "var(--ok)" : r.qosVal > 90 ? "var(--warn)" : "var(--err)" }}>{Math.round(r.qosVal)}</span> : <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>}</td>
                  </>
                )}
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={8} style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-4)", fontSize: 13 }}>No providers configured yet.</td></tr>
          )}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "9px 14px", borderTop: "1px solid var(--line)" }}>
          <span style={{ fontSize: 11, color: "var(--text-4)" }}>{curPage * PAGE + 1}–{Math.min(rows.length, curPage * PAGE + PAGE)} of {rows.length}</span>
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={curPage === 0} className="gw-btn gw-btn--ghost" style={{ padding: "3px 9px", fontSize: 12, opacity: curPage === 0 ? 0.4 : 1, cursor: curPage === 0 ? "default" : "pointer" }}>Prev</button>
          <span style={{ fontSize: 11, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>{curPage + 1} / {pageCount}</span>
          <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={curPage >= pageCount - 1} className="gw-btn gw-btn--ghost" style={{ padding: "3px 9px", fontSize: 12, opacity: curPage >= pageCount - 1 ? 0.4 : 1, cursor: curPage >= pageCount - 1 ? "default" : "pointer" }}>Next</button>
        </div>
      )}
    </div>
  );
}

/** Keep the roster reusable without its own fetch; the tab supplies rows. */
export function usePMRosterData(timeWindow: MetricWindow, chainFilter: string | null) {
  const specQ = chainFilter ? `&spec=${encodeURIComponent(chainFilter)}` : "";
  return useApi<{ providers: ProviderMetrics[] }>(`/api/metrics/providers?window=${timeWindow}${specQ}`);
}
