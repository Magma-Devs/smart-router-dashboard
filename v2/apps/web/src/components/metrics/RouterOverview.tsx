"use client";

/* RouterOverview — one row per chain router, aggregating its providers.
 * Ported verbatim from the design prototype (page-metrics.jsx RouterOverview);
 * rows are live /api/metrics/chains and the network / primary-provider /
 * P·B sub-lines come from the mounted config (/api/config/routers). Where the
 * topology is unknown those sub-lines are omitted rather than invented.
 * Sorting uses the ported useSort/ThCol; a hidden `natural` key preserves the
 * design's initial order (down chains first, then by volume). */

import { Fragment } from "react";
import type { ChainMetrics, MetricWindow, RouterTopology } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { Tip } from "@/components/gateway/Tip";
import { ThCol, useSort } from "@/components/gateway/SortTable";
import { TT } from "@/lib/tooltips";
import { fmtNum } from "@/lib/format";
import { ChainDetail, type ChainDetailRow } from "./ChainDetail";
import { useState } from "react";

const ROUTER_SR_TIP = "**Chain-level availability** — successful requests ÷ total, **rolled up across every provider** on the chain (what your apps actually got).\n\nSame definition as per-provider Availability in the Providers tab.";

type RoStatus = "up" | "down" | "unknown";

interface RoRow {
  spec: string;
  name: string;
  color: string;
  network: string | null;
  provCount: number;
  nPrimary: number | null;
  nBackup: number | null;
  primaryName: string | null;
  otherCount: number;
  availPct: number | null;
  p95Ms: number | null;
  errPct: number | null;
  qosVal: number | null;
  reqCount: number;
  statusKind: RoStatus;
  detail: ChainDetailRow;
  /* flat sort accessors (design SORT_VAL semantics) */
  natural: number;
  router: string;
  providers: number;
  requests: number;
  avail: number;
  p95: number;
  err: number;
  qos: number;
  status: number;
}

const STATUS_RANK: Record<RoStatus, number> = { down: 0, up: 1, unknown: 2 };

export function RouterOverview({ onChainClick, chainFilter, timeWindow }: {
  onChainClick: (spec: string) => void;
  chainFilter: string | null;
  timeWindow: MetricWindow;
}) {
  const [net, setNet] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const { data } = useApi<{ chains: ChainMetrics[] }>(`/api/metrics/chains?window=${timeWindow}`);
  const topo = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);

  const base: RoRow[] = (data?.chains ?? []).map((c) => {
    const t = (topo.data?.routers ?? []).find((r) => r.spec === c.spec);
    const nPrimary = t ? t.nodes.filter((n) => !n.isBackup).length : null;
    const nBackup = t ? t.nodes.filter((n) => n.isBackup).length : null;
    const primaryName = t ? ((t.nodes.find((n) => !n.isBackup) ?? t.nodes[0])?.name ?? null) : null;
    const statusKind: RoStatus = c.health === "unhealthy" ? "down" : c.health === "operational" ? "up" : "unknown";
    const availPct = c.availability != null ? c.availability * 100 : null;
    const errPct = c.errorRate != null ? c.errorRate * 100 : null;
    const qosVal = c.qos != null ? c.qos * 100 : null;
    return {
      spec: c.spec, name: c.name, color: c.color,
      network: t?.network ?? null,
      provCount: c.providerCount, nPrimary, nBackup, primaryName,
      otherCount: Math.max(0, c.providerCount - 1),
      availPct, p95Ms: c.p95Ms, errPct, qosVal, reqCount: c.requests, statusKind,
      detail: { spec: c.spec, availPct, p95Ms: c.p95Ms, errPct, qos: qosVal, requests: c.requests, hasBackup: (nBackup ?? 0) > 0 },
      natural: 0,
      router: c.name.toLowerCase(),
      providers: c.providerCount,
      requests: c.requests,
      avail: availPct ?? -1,
      p95: c.p95Ms ?? Infinity,
      err: errPct ?? -1,
      qos: qosVal ?? -1,
      status: STATUS_RANK[statusKind],
    };
  })
    .sort((a, b) => (a.status - b.status) || (b.requests - a.requests))
    .map((r, i) => ({ ...r, natural: i }));

  const routers = base.filter((r) => (net === "all" || r.network === net) && (!chainFilter || r.spec === chainFilter));
  const { sorted: sortedRouters, sort, onSort } = useSort<RoRow>(routers, { key: "natural", dir: "asc" });

  const srColor = (v: number | null) => v == null ? "var(--text-4)" : v >= 99.9 ? "var(--ok)" : v >= 99 ? "var(--warn)" : "var(--err)";
  const statusMeta: Record<RoStatus, [string, string]> = { up: ["var(--ok)", "Operational"], down: ["var(--err)", "Unhealthy"], unknown: ["var(--text-4)", "—"] };

  return (
    <div className="gw-card" style={{ padding: 0, overflow: "hidden", marginBottom: 14 }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)", flex: 1, display: "inline-flex", alignItems: "center" }}>
          Routers · how each chain performs<Tip text="**One router per chain × network.** Each aggregates the providers serving it.\n\n**Click a row** to expand its chain-health graphs over the selected window." />
        </div>
        <span style={{ fontSize: 11, color: "var(--text-3)" }}>{routers.length} router{routers.length === 1 ? "" : "s"}</span>
        <div className="gw-segctl">
          {([["all", "All"], ["mainnet", "Mainnet"], ["testnet", "Testnet"]] as const).map(([f, lbl]) => (
            <button key={f} className={net === f ? "on" : ""} onClick={() => setNet(f)} style={{ padding: "4px 10px" }}>{lbl}</button>
          ))}
        </div>
      </div>
      <table className="gw-table">
        <thead>
          <tr>
            <ThCol sortKey="router" sort={sort} onSort={onSort}>Router</ThCol>
            <ThCol align="right" sortKey="providers" sort={sort} onSort={onSort}>Providers</ThCol>
            <ThCol align="right" sortKey="requests" sort={sort} onSort={onSort}>Requests · {timeWindow}</ThCol>
            <ThCol align="right" tip={ROUTER_SR_TIP} sortKey="avail" sort={sort} onSort={onSort}>Availability</ThCol>
            <ThCol align="right" tip={TT.p95} sortKey="p95" sort={sort} onSort={onSort}>P95</ThCol>
            <ThCol align="right" sortKey="err" sort={sort} onSort={onSort}>Error rate</ThCol>
            <ThCol align="right" tip={TT.qosScore} sortKey="qos" sort={sort} onSort={onSort}>QoS</ThCol>
            <ThCol sortKey="status" sort={sort} onSort={onSort}>Status</ThCol>
          </tr>
        </thead>
        <tbody>
          {sortedRouters.map((r) => {
            const sm = statusMeta[r.statusKind];
            const rowKey = r.spec + (r.network ?? "");
            const isOpen = open === rowKey;
            return (
              <Fragment key={rowKey}>
              <tr style={{ cursor: "pointer", background: isOpen ? "var(--hover)" : undefined }} onClick={() => setOpen(isOpen ? null : rowKey)}
                title={r.name + " — click for chain health"}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: r.color || "#888", flexShrink: 0 }} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
                        {r.network && (
                          <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "1px 6px", borderRadius: 4, color: r.network === "mainnet" ? "var(--text-3)" : "#a78bfa", background: r.network === "mainnet" ? "var(--hover)" : "rgba(167,139,250,0.12)" }}>{r.network}</span>
                        )}
                      </div>
                      {r.primaryName && <span style={{ fontSize: 11, color: "var(--text-3)" }}>via {r.primaryName}{r.otherCount > 0 ? " + " + r.otherCount : ""}</span>}
                    </div>
                  </div>
                </td>
                <td style={{ textAlign: "right" }}>
                  <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end" }}>
                    <span className="gw-mono gw-tnum" style={{ fontSize: 13, fontWeight: 600 }}>{r.provCount}</span>
                    {r.nPrimary != null && <span style={{ fontSize: 10, color: "var(--text-4)" }}>{r.nPrimary}P{r.nBackup ? " · " + r.nBackup + "B" : ""}</span>}
                  </div>
                </td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtNum(r.reqCount)}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 13, fontWeight: 700, color: srColor(r.availPct) }}>{r.availPct != null ? r.availPct.toFixed(2) + "%" : "—"}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{r.p95Ms != null ? Math.round(r.p95Ms) + " ms" : "—"}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: r.errPct == null ? "var(--text-4)" : r.errPct < 0.5 ? "var(--text-2)" : r.errPct < 1.5 ? "var(--warn)" : "var(--err)" }}>{r.errPct != null ? r.errPct.toFixed(2) + "%" : "—"}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 13, fontWeight: 700, color: r.qosVal == null ? "var(--text-4)" : r.qosVal > 97 ? "var(--ok)" : r.qosVal > 90 ? "var(--warn)" : "var(--err)" }}>{r.qosVal == null ? "—" : Math.round(r.qosVal)}</span></td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: sm[0], boxShadow: "0 0 6px " + sm[0], flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: "var(--text-2)" }}>{sm[1]}</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-4)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><polyline points="6 9 12 15 18 9"/></svg>
                  </span>
                </td>
              </tr>
              {isOpen && <tr><ChainDetail r={r.detail} onChainClick={onChainClick} win={timeWindow} /></tr>}
              </Fragment>
            );
          })}
          {data && sortedRouters.length === 0 && (
            <tr><td colSpan={8} style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-4)", fontSize: 13 }}>No routers match this filter.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
