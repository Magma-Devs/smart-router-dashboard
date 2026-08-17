"use client";

/* RouterOverview — one row per chain router, aggregating its upstreams.
 * Ported verbatim from the design prototype (page-metrics.jsx RouterOverview);
 * rows are live /api/metrics/chains and the network / primary-upstream /
 * P·B sub-lines come from the mounted config (/api/config/routers). Where the
 * topology is unknown those sub-lines are omitted rather than invented.
 * Sorting uses the ported useSort/ThCol; a hidden `natural` key preserves the
 * design's initial order (down chains first, then by volume). */

import { Fragment } from "react";
import { buildChainMetaByIndex, type BlockHeights, type ChainMetrics, type ChainTips, type MetricWindow, type RouterTopology } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { Tip } from "@/components/gateway/Tip";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { ThCol, useSort } from "@/components/gateway/SortTable";
import { TT } from "@/lib/tooltips";
import { fmtComma, fmtLag, fmtNum } from "@/lib/format";
import { routerTipColor, uptimeColor } from "@/lib/colors";
import { healthColor, healthLabel } from "@/lib/health";
import { ChainDetail, type ChainDetailRow } from "./ChainDetail";
import { useState } from "react";
import { useFilters } from "@/components/gateway/FiltersProvider";

const BLOCK_TIP = "**The head this router serves** — `smartrouter_latest_block`, the tip it has accepted, per api interface (the number shown is the furthest-ahead interface).\n\nThe sub-line is how far that sits behind the best upstream on the chain, **in seconds**: blocks behind ÷ the chain's own block rate. Seconds are the only unit comparable across chains — the same block count is a moment on Aptos and a century on Bitcoin.\n\nThe router gauge only advances on accepted tip observations, so it trails by about one **refresh** interval however healthy the router is. The colour is judged against that measured cadence — grey within 2×, amber to 4×, red beyond — not against the wall clock.";

const ROUTER_SR_TIP = "**Chain-level availability** — successful requests ÷ total, **rolled up across every upstream** on the chain (what your apps actually got).\n\nSame definition as per-upstream Availability in the Upstreams tab.";

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
  /** Furthest-ahead router tip across this chain's interfaces. */
  tipBlock: number | null;
  /** Worst per-interface lag behind the best upstream, in seconds. */
  tipBehindSec: number | null;
  /** Interfaces this chain's router serves (>1 ⇒ the tips can disagree). */
  tipIfaceCount: number;
  /** Observed refresh cadence of the worst interface's gauge, in seconds. */
  tipRefreshSec: number | null;
  detail: ChainDetailRow;
  /* flat sort accessors (design SORT_VAL semantics) */
  natural: number;
  router: string;
  upstreams: number;
  requests: number;
  avail: number;
  p95: number;
  err: number;
  qos: number;
  status: number;
  block: number;
}

const STATUS_RANK: Record<RoStatus, number> = { down: 0, up: 1, unknown: 2 };

export function RouterOverview({ onChainClick, chainFilter, timeWindow }: {
  onChainClick: (spec: string) => void;
  chainFilter: string | null;
  timeWindow: MetricWindow;
}) {
  const [net, setNet] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const { scopeQ, withScope } = useFilters();
  const { data } = useApi<{ chains: ChainMetrics[] }>(`/api/metrics/chains?window=${timeWindow}${scopeQ}`);
  const topo = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  // Instant gauges — no window in the key; polled on the default cadence.
  const tips = useApi<BlockHeights>(withScope("/api/metrics/block-heights"));
  const tipBySpec = new Map<string, ChainTips>(
    (tips.data?.chains ?? []).map((c) => [c.spec, c]),
  );

  const base: RoRow[] = (data?.chains ?? []).map((c) => {
    const t = (topo.data?.routers ?? []).find((r) => r.spec === c.spec);
    const nPrimary = t ? t.nodes.filter((n) => !n.isBackup).length : null;
    const nBackup = t ? t.nodes.filter((n) => n.isBackup).length : null;
    const primaryName = t ? ((t.nodes.find((n) => !n.isBackup) ?? t.nodes[0])?.name ?? null) : null;
    const statusKind: RoStatus = c.health === "unhealthy" ? "down" : c.health === "operational" ? "up" : "unknown";
    // The router's own tips, one per interface. The number leads with the
    // furthest-ahead interface; the lag leads with the WORST, so a single
    // lagging interface can't hide behind a healthy sibling.
    const tip = tipBySpec.get(c.spec);
    const ifaceTips = tip?.routers ?? [];
    const tipBlock = ifaceTips.reduce<number | null>(
      (max, t) => (t.block !== null && (max === null || t.block > max) ? t.block : max), null);
    const worstTip = ifaceTips.reduce<(typeof ifaceTips)[number] | null>(
      (worst, t) =>
        t.behindSec !== null && (worst === null || t.behindSec > (worst.behindSec ?? -1)) ? t : worst,
      null);
    const tipBehindSec = worstTip?.behindSec ?? null;
    const availPct = c.availability != null ? c.availability * 100 : null;
    const errPct = c.errorRate != null ? c.errorRate * 100 : null;
    const qosVal = c.qos != null ? c.qos * 100 : null;
    return {
      spec: c.spec, name: c.name, color: c.color,
      network: t?.network ?? null,
      provCount: c.upstreamCount, nPrimary, nBackup, primaryName,
      otherCount: Math.max(0, c.upstreamCount - 1),
      availPct, p95Ms: c.p95Ms, errPct, qosVal, reqCount: c.requests, statusKind,
      tipBlock: tipBlock ?? c.latestBlock, tipBehindSec, tipIfaceCount: ifaceTips.length,
      tipRefreshSec: worstTip?.refreshSec ?? null,
      detail: { spec: c.spec, availPct, p95Ms: c.p95Ms, errPct, qos: qosVal, requests: c.requests, hasBackup: (nBackup ?? 0) > 0 },
      natural: 0,
      router: c.name.toLowerCase(),
      upstreams: c.upstreamCount,
      requests: c.requests,
      avail: availPct ?? -1,
      p95: c.p95Ms ?? Infinity,
      err: errPct ?? -1,
      qos: qosVal ?? -1,
      status: STATUS_RANK[statusKind],
      block: tipBehindSec ?? -1,
    };
  })
    .sort((a, b) => (a.status - b.status) || (b.requests - a.requests))
    .map((r, i) => ({ ...r, natural: i }));

  // Classify mainnet/testnet from the SPEC metadata — r.network is the chain
  // slug (eth1/solana/…), never "mainnet"/"testnet", so comparing against it
  // matched zero rows.
  const routers = base.filter((r) => {
    if (net !== "all") {
      const isMainnet = buildChainMetaByIndex(r.spec).mainnet;
      if (net === "mainnet" ? !isMainnet : isMainnet) return false;
    }
    return !chainFilter || r.spec === chainFilter;
  });
  const { sorted: sortedRouters, sort, onSort } = useSort<RoRow>(routers, { key: "natural", dir: "asc" });

  const srColor = uptimeColor;
  /* Labels + colours from the shared vocabulary (`lib/health.ts`), which took
     its wording from this table. */
  const statusMeta: Record<RoStatus, [string, string]> = {
    up: [healthColor("operational"), healthLabel("operational")],
    down: [healthColor("unhealthy"), healthLabel("unhealthy")],
    unknown: [healthColor("unknown"), healthLabel("unknown")],
  };

  return (
    <div className="gw-card" style={{ padding: 0, overflow: "hidden", marginBottom: 14 }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)", flex: 1, display: "inline-flex", alignItems: "center" }}>
          Routers · how each chain performs<Tip text="**One router per chain × network.** Each aggregates the upstreams serving it.\n\n**Click a row** to expand its chain-health graphs over the selected window." />
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
            <ThCol align="right" sortKey="upstreams" sort={sort} onSort={onSort}>Upstreams</ThCol>
            <ThCol align="right" tip={BLOCK_TIP} sortKey="block" sort={sort} onSort={onSort}>Latest block</ThCol>
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
                    <ChainBadge spec={r.spec} size={22} />
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
                <td style={{ textAlign: "right" }}>
                  {r.tipBlock != null ? (
                    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end" }}>
                      <span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtComma(r.tipBlock)}</span>
                      {r.tipBehindSec != null && (
                        <span className="gw-tnum" style={{ fontSize: 10, color: routerTipColor(r.tipBehindSec, r.tipRefreshSec) }}>
                          {r.tipBehindSec < 1 ? "in sync" : fmtLag(r.tipBehindSec) + " behind"}
                          {r.tipRefreshSec != null ? ` · refresh ${fmtLag(r.tipRefreshSec)}` : ""}
                          {r.tipIfaceCount > 1 ? ` · ${r.tipIfaceCount} ifaces` : ""}
                        </span>
                      )}
                    </div>
                  ) : <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>}
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
            <tr><td colSpan={9} style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-4)", fontSize: 13 }}>No routers match this filter.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
