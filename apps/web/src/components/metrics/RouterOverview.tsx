"use client";

/* RouterOverview — ONE ROW PER CONFIG ROUTER (`/api/metrics/routers-rollup`),
 * aggregating its upstreams. It used to key on the chain, which folded every
 * router serving one chain into a single row wearing the first router's name
 * beside all of their traffic; the config is the only place they are
 * distinguishable, so it drives the rows now. A row says whether its numbers
 * are its own (the collector splits its scrape target) or the chain's, shared
 * with the siblings it names.
 * Ported verbatim from the design prototype (page-metrics.jsx RouterOverview);
 * rows are live /api/metrics/chains and the network / primary-upstream /
 * P·B sub-lines come from the mounted config (/api/config/routers). Where the
 * topology is unknown those sub-lines are omitted rather than invented.
 * Sorting uses the ported useSort/ThCol; a hidden `natural` key preserves the
 * design's initial order (down chains first, then by volume). */

import { Fragment } from "react";
import { buildChainMetaByIndex, type BlockHeights, type ChainTips, type MetricWindow, type RouterMetrics, type RouterTopology } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { Tip } from "@/components/gateway/Tip";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { ExplorerBlockLink, ExplorerHomeLink } from "@/components/gateway/ExplorerLink";
import { ThCol, useSort } from "@/components/gateway/SortTable";
import { TT } from "@/lib/tooltips";
import { fmtComma, fmtNum } from "@/lib/format";
import { uptimeColor } from "@/lib/colors";
import { healthColor, healthLabel } from "@/lib/health";
import { ChainDetail, type ChainDetailRow } from "./ChainDetail";
import { useState } from "react";
import { useFilters } from "@/components/gateway/FiltersProvider";

const BLOCK_TIP = "**The head this router serves** — `smartrouter_latest_block`, the tip it has accepted, leading with the furthest-ahead api interface.\n\nIt is a CHAIN-level series, so two routers on one chain read the same one. Per-upstream lag lives on the Upstreams tab.\n\n**Click a height** to open it on the chain\u2019s block explorer. Chains with no verified block page show the number plain \u2014 the chain icon still opens their explorer.";

const ROUTER_SR_TIP = "**Chain-level availability** — successful requests ÷ total, **rolled up across every upstream** on the chain (what your apps actually got).\n\nSame definition as per-upstream Availability in the Upstreams tab.";

type RoStatus = "up" | "down" | "unknown";

interface RoRow {
  /** The row's identity — a config router id, not a chain. */
  routerId: string;
  /** Whose traffic these numbers are (see `RouterMetrics.attribution`). */
  attribution: "own" | "shared";
  sharedWith: string[];
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
  /** Composite QoS — feeds the expanded ChainDetail only; the table itself
   *  carries no QoS column (MAG-2901). */
  qosVal: number | null;
  reqCount: number;
  statusKind: RoStatus;
  /** Furthest-ahead router tip across this chain's interfaces. The rollup shows
   *  the number alone — per-interface lag, cadence and staleness are the
   *  Upstreams roster's job and `/api/metrics/block-heights`'s detail. */
  tipBlock: number | null;
  detail: ChainDetailRow;
  /* flat sort accessors (design SORT_VAL semantics) */
  natural: number;
  router: string;
  upstreams: number;
  requests: number;
  avail: number;
  p95: number;
  err: number;
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
  const { data } = useApi<{ routers: RouterMetrics[] }>(`/api/metrics/routers-rollup?window=${timeWindow}${scopeQ}`);
  const topo = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  // Instant gauges — no window in the key; polled on the default cadence.
  const tips = useApi<BlockHeights>(withScope("/api/metrics/block-heights"));
  const tipBySpec = new Map<string, ChainTips>(
    (tips.data?.chains ?? []).map((c) => [c.spec, c]),
  );

  const base: RoRow[] = (data?.routers ?? []).map((c) => {
    // The config entry BY ID — `.find(r => r.spec === …)` was the bug: on a
    // chain with two routers it returned the first one for both.
    const t = (topo.data?.routers ?? []).find((r) => r.id === c.routerId);
    const nPrimary = t ? t.nodes.filter((n) => !n.isBackup).length : null;
    const nBackup = t ? t.nodes.filter((n) => n.isBackup).length : null;
    const primaryName = t ? ((t.nodes.find((n) => !n.isBackup) ?? t.nodes[0])?.name ?? null) : null;
    const statusKind: RoStatus = c.health === "unhealthy" ? "down" : c.health === "operational" ? "up" : "unknown";
    // Furthest-ahead interface tip; the chain rollup falls back to the router
    // gauge the api already read. Chain-level either way — two routers on one
    // chain read one series, which is what `attribution` states.
    const ifaceTips = tipBySpec.get(c.spec)?.routers ?? [];
    const tipBlock = ifaceTips.reduce<number | null>(
      (max, x) => (x.block !== null && (max === null || x.block > max) ? x.block : max), null);
    const availPct = c.availability != null ? c.availability * 100 : null;
    const errPct = c.errorRate != null ? c.errorRate * 100 : null;
    const qosVal = c.qos != null ? c.qos * 100 : null;
    return {
      routerId: c.routerId, attribution: c.attribution, sharedWith: c.sharedWith,
      spec: c.spec, name: c.name, color: c.color,
      network: t?.network ?? null,
      provCount: c.upstreamCount, nPrimary, nBackup, primaryName,
      otherCount: Math.max(0, c.upstreamCount - 1),
      availPct, p95Ms: c.p95Ms, errPct, qosVal, reqCount: c.requests, statusKind,
      tipBlock: tipBlock ?? c.latestBlock,
      detail: { spec: c.spec, availPct, p95Ms: c.p95Ms, errPct, qos: qosVal, requests: c.requests, hasBackup: (nBackup ?? 0) > 0 },
      natural: 0,
      router: c.routerId.toLowerCase(),
      upstreams: c.upstreamCount,
      requests: c.requests,
      avail: availPct ?? -1,
      p95: c.p95Ms ?? Infinity,
      err: errPct ?? -1,
      status: STATUS_RANK[statusKind],
      block: c.latestBlock ?? tipBlock ?? -1,
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
          Routers · how each router performs<Tip text="**One row per router in the mounted values file** — not per chain. A chain can be served by several routers, and the config is the only place they are distinguishable: no metric series carries a router.\n\nA **shared** row means the collector reports no per-router target label, so the chain-level figures cover every router on that chain. Two such rows carry the same numbers; adding them up would count that traffic twice. Upstream counts are always the router's own.\n\n**Click a row** to expand its chain-health graphs over the selected window." />
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
            <ThCol sortKey="status" sort={sort} onSort={onSort}>Status</ThCol>
          </tr>
        </thead>
        <tbody>
          {sortedRouters.map((r) => {
            const sm = statusMeta[r.statusKind];
            const rowKey = r.routerId;
            const isOpen = open === rowKey;
            return (
              <Fragment key={rowKey}>
              <tr style={{ cursor: "pointer", background: isOpen ? "var(--hover)" : undefined }} onClick={() => setOpen(isOpen ? null : rowKey)}
                title={`${r.routerId} on ${r.name} — click for chain health`}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <ExplorerHomeLink spec={r.spec}><ChainBadge spec={r.spec} size={22} /></ExplorerHomeLink>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{r.routerId}</span>
                        {r.attribution === "shared" && (
                          <span
                            className="gw-tag"
                            title={`${r.sharedWith.join(", ")} also serve${r.sharedWith.length === 1 ? "s" : ""} ${r.name}, and the collector reports no per-router target label — these numbers are all of them together. Adding the rows up would count that traffic twice.`}
                            style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "1px 6px" }}
                          >
                            shared
                          </span>
                        )}
                        {r.network && (
                          <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "1px 6px", borderRadius: 4, color: r.network === "mainnet" ? "var(--text-3)" : "#a78bfa", background: r.network === "mainnet" ? "var(--hover)" : "rgba(167,139,250,0.12)" }}>{r.network}</span>
                        )}
                      </div>
                      <span style={{ fontSize: 11, color: "var(--text-3)" }}>
                        {r.name}{r.primaryName ? ` · via ${r.primaryName}${r.otherCount > 0 ? " + " + r.otherCount : ""}` : ""}
                      </span>
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
                  {r.tipBlock != null
                    ? <ExplorerBlockLink spec={r.spec} block={r.tipBlock}>
                        <span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtComma(r.tipBlock)}</span>
                      </ExplorerBlockLink>
                    : <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>}
                </td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtNum(r.reqCount)}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 13, fontWeight: 700, color: srColor(r.availPct) }}>{r.availPct != null ? r.availPct.toFixed(2) + "%" : "—"}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{r.p95Ms != null ? Math.round(r.p95Ms) + " ms" : "—"}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: r.errPct == null ? "var(--text-4)" : r.errPct < 0.5 ? "var(--text-2)" : r.errPct < 1.5 ? "var(--warn)" : "var(--err)" }}>{r.errPct != null ? r.errPct.toFixed(2) + "%" : "—"}</span></td>
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
