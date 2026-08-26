"use client";

/* PMRoster — every upstream matching the filters, key health at a glance.
 * Ported verbatim from the design prototype (page-provider-metrics.jsx
 * PMRoster); rows are live /api/metrics/upstreams. Sorting uses the ported
 * useSort/ThCol with a hidden `natural` key so the initial order matches the
 * API's (requests desc), like the design's unsorted default. */

import { useEffect, useState } from "react";
import { buildChainMetaByIndex, type MetricWindow, type UpstreamMetrics } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { uptimeColor } from "@/lib/colors";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { ExplorerBlockLink, ExplorerHomeLink } from "@/components/gateway/ExplorerLink";
import { HealthDot } from "@/components/gateway/HealthTag";
import { Tip } from "@/components/gateway/Tip";
import { ThCol, useSort } from "@/components/gateway/SortTable";
import { Refreshing, Skel, SkelRows } from "@/components/gateway/Skel";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { pollColor, pollSummary, qosHint, qosIsStale, qosValue } from "@/lib/upstream-signals";
import { useRouterFilter } from "@/hooks/use-router-options";

const BLOCK_TIP = "**The head this upstream reports** — `rpc_endpoint_latest_block`, its own tip rather than the router's.\n\n**Click a height** to open it on the chain\u2019s block explorer and check it against the public chain. Chains with no verified block page show the number plain — the chain name still opens their explorer.";

interface RosterRow {
  pm: UpstreamMetrics;
  name: string;
  chainName: string;
  chainColor: string;
  hasData: boolean;
  qosVal: number | null;
  /** Config routers declaring this upstream — several ⇒ one shared series. */
  routerIds: string[];
  /* flat sort accessors (design SV semantics) */
  natural: number;
  upstream: string;
  router: string;
  chain: string;
  block: number;
  requests: number;
  uptime: number;
  latency: number;
  err: number;
  qos: number;
}

export function PMRoster({ rows, activeName, onSelect, timeWindow, loading = false, refreshing = false }: {
  rows: UpstreamMetrics[];
  activeName: string | null;
  onSelect: (name: string) => void;
  timeWindow: MetricWindow;
  /** Revalidating with rows already on screen — a cue, never a ghost. */
  refreshing?: boolean;
  /** First load only — see `Skel.tsx`. Without it an in-flight roster reads
   *  as "No upstreams configured yet.", which is a claim about the mounted
   *  values file rather than about the fetch. */
  loading?: boolean;
}) {
  /* Which router the Router column leads with: the filtered-on one when there
     is one, else the first the config names. A shared row under an
     `eth-staging` filter that led with `eth-prod` read as the wrong router's. */
  const { routerId: filteredRouter } = useRouterFilter();
  const leadRouter = (ids: string[]) =>
    (filteredRouter && ids.includes(filteredRouter) ? filteredRouter : ids[0]) ?? null;
  const fmtReq = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : Math.round(n).toString());
  const fmtBlock = (n: number) => n.toLocaleString("en-US");
  const PAGE = 8;
  const [page, setPage] = useState(0);

  const built: RosterRow[] = rows.map((v, i) => {
    const meta = buildChainMetaByIndex(v.spec);
    const qosVal = qosValue(v);
    return {
      pm: v,
      name: v.endpointId,
      chainName: meta.name,
      chainColor: meta.color,
      hasData: v.requests > 0,
      qosVal,
      routerIds: v.routerIds,
      natural: i,
      upstream: v.endpointId.toLowerCase(),
      router: (leadRouter(v.routerIds) ?? "").toLowerCase(),
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
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>All upstreams</span>
        <Tip text="Every upstream × chain you've configured. Uptime reflects the time window selected above. Click a row to drill into its full metrics below." />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--text-3)", display: "inline-flex", alignItems: "center", gap: 7 }}>
          {loading ? <Skel w={168} h={9} /> : <>{rows.length} upstream{rows.length === 1 ? "" : "s"} · uptime over {timeWindow}</>}
          <Refreshing show={!loading && refreshing} label="Refreshing upstreams" />
        </span>
      </div>
      <table className="gw-table">
        <thead>
          <tr>
            <ThCol sortKey="upstream" sort={sort} onSort={onSort}>Upstream</ThCol>
            <ThCol sortKey="router" sort={sort} onSort={onSort}>Router</ThCol>
            <ThCol sortKey="chain" sort={sort} onSort={onSort}>Chain</ThCol>
            <ThCol align="right" tip={BLOCK_TIP} sortKey="block" sort={sort} onSort={onSort}>Latest block</ThCol>
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
                    <HealthDot health={v.health} />
                    <span style={{ fontSize: 13, fontWeight: on ? 700 : 500 }}>{r.name}</span>
                    {v.role && <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "1px 6px", borderRadius: 4, color: v.role === "primary" ? "#60a5fa" : "#fb923c", background: v.role === "primary" ? "rgba(96,165,250,0.1)" : "rgba(251,146,60,0.1)" }}>{v.role === "primary" ? "Primary" : "Backup"}</span>}
                  </div>
                </td>
                {/* Which config router declares this upstream. The series
                    itself carries no router, so this is the values file
                    talking. Several routers can declare one upstream name,
                    and then there is still only one series — the cell leads
                    with the filtered-on router and names the rest on hover
                    rather than badging every row that shares. */}
                <td>
                  {r.routerIds.length === 0 ? (
                    <span style={{ fontSize: 12, color: "var(--text-4)" }} title="Traffic under a name the mounted config doesn't declare">—</span>
                  ) : (
                    <span
                      className="gw-mono"
                      style={{ fontSize: 11, color: "var(--text-2)" }}
                      title={r.routerIds.length > 1 ? `Declared by ${r.routerIds.join(", ")} — one upstream name, so one series: these numbers are those routers' traffic together` : undefined}
                    >
                      {leadRouter(r.routerIds)}
                    </span>
                  )}
                </td>
                <td>
                  <ExplorerHomeLink spec={r.pm.spec}>
                    <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <ChainBadge spec={r.pm.spec} size={16} />
                      <span style={{ fontSize: 12, color: "var(--text-2)" }}>{r.chainName}</span>
                    </span>
                  </ExplorerHomeLink>
                </td>
                <td style={{ textAlign: "right" }}>
                  {v.latestBlock != null ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                      <ExplorerBlockLink spec={v.spec} block={v.latestBlock}>
                        <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--text)" }}>{fmtBlock(v.latestBlock)}</span>
                      </ExplorerBlockLink>
                    </span>
                  ) : <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>}
                </td>
                {/* The four TRAFFIC-derived columns. With no relays there is
                    honestly nothing to put in them, so they collapse into one
                    sentence — and that sentence now names what the router DID
                    do instead, from its own polls. QoS is deliberately NOT in
                    here: the router scores every upstream whether or not it
                    routes to it, so folding the score into "no traffic" threw
                    away a live number. */}
                {muted ? (
                  <td colSpan={4} style={{ textAlign: "right", fontSize: 12, fontStyle: "italic", opacity: 0.9 }}>
                    <span style={{ color: "var(--warn)" }}>
                      {v.role === "backup" ? "No requests routed here — standing by as backup" : "No requests routed here in this window"}
                    </span>
                    {(() => {
                      const polls = pollSummary(v.polls);
                      if (polls === null) return null;
                      return (
                        <span style={{ color: pollColor(v.polls), fontStyle: "normal" }}
                          title="The router polls every configured upstream for its latest block, whether or not it routes requests to it. Zero polls means the poll gate suppressed them — served traffic or a peer's poll already refreshed the tip — not that the upstream failed.">
                          {" · "}{polls}
                        </span>
                      );
                    })()}
                  </td>
                ) : (
                  <>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--text)" }}>{fmtReq(v.requests)}</span></td>
                    <td style={{ textAlign: "right" }}>{(() => { const a = v.uptime != null ? v.uptime * 100 : null; return a != null ? <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: uptimeColor(a) }}>{a.toFixed(2)}%</span> : <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>; })()}</td>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{v.p95Ms != null ? Math.round(v.p95Ms) + " ms" : "—"}</span></td>
                    <td style={{ textAlign: "right" }}>{(() => { const e = v.errorRate != null ? v.errorRate * 100 : null; return e != null ? <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: e < 0.5 ? "var(--text-3)" : e < 1.5 ? "var(--warn)" : "var(--err)" }}>{e.toFixed(2)}%</span> : <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>; })()}</td>
                  </>
                )}
                {/* QoS — outside the collapse above, on every row. A stale
                    score (the routing gauge on an idle row) is MARKED, not
                    hidden: "we last measured this a while ago" is information,
                    "—" is not. */}
                <td style={{ textAlign: "right" }} title={qosHint(v)}>
                  {r.qosVal != null ? (
                    <span className="gw-mono gw-tnum" style={{ fontSize: 13, fontWeight: 700, color: r.qosVal > 97 ? "var(--ok)" : r.qosVal > 90 ? "var(--warn)" : "var(--err)", opacity: qosIsStale(v) ? 0.55 : 1 }}>
                      {Math.round(r.qosVal)}
                      {qosIsStale(v) && <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-4)" }}>{" "}old</span>}
                    </span>
                  ) : <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>}
                </td>
              </tr>
            );
          })}
          {loading && <SkelRows rows={6} cols={[
            { w: 156 }, { w: 96 }, { w: 110 }, { w: 84, align: "right" }, { w: 62, align: "right" },
            { w: 64, align: "right" }, { w: 56, align: "right" }, { w: 58, align: "right" }, { w: 36, align: "right" },
          ]} />}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={9} style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-4)", fontSize: 13 }}>No upstreams configured yet.</td></tr>
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
  // Both router axes: `scopeQ` narrows the PromQL when the collector can split
  // targets, `routerIdQ` filters rows by what the config router declares.
  const { scopeQ } = useFilters();
  const { routerIdQ } = useRouterFilter();
  return useApi<{ upstreams: UpstreamMetrics[] }>(
    `/api/metrics/upstreams?window=${timeWindow}${specQ}${routerIdQ}${scopeQ}`,
  );
}
