"use client";

/* TrafficUsage — aggregate throughput chart + searchable, paginated per-chain
 * table. Ported verbatim from the design prototype (page-metrics.jsx
 * TrafficUsage); series come live from /api/metrics/traffic (the mock's
 * synthetic diurnal curves are replaced by real rate() series, so the x-axis
 * labels are computed from the actual sample timestamps). */

import { useEffect, useMemo, useState } from "react";
import type { MetricWindow, TrafficSummary } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { Tip } from "@/components/gateway/Tip";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { LineChart, SparkLine } from "@/components/gateway/charts";
import { roFmtTime } from "@/components/metrics/InteractiveChart";
import { fmtNum } from "@/lib/format";
import { nums } from "./bits";

export function TrafficUsage({ win, chainFilter }: { win: MetricWindow; chainFilter: string | null }) {
  const { data } = useApi<TrafficSummary>(`/api/metrics/traffic?window=${win}`);

  const perChain = useMemo(
    () =>
      (data?.chains ?? [])
        .map((c) => ({
          id: c.spec,
          key: c.spec,
          name: c.name,
          net: null as string | null,
          color: c.color,
          values: nums(c.trend),
          cur: c.rpsNow,
          requests: c.requests,
          share: c.share,
        }))
        .sort((a, b) => b.requests - a.requests),
    [data],
  );

  const total = nums(data?.aggregate);
  const aggTimes = (data?.aggregate ?? []).map((p) => new Date(p.t * 1000));

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [localFocus, setLocalFocus] = useState<string | null>(null);
  useEffect(() => { setLocalFocus(null); setQuery(""); }, [chainFilter]);

  // focus = a single chain to spotlight (global selector wins; else a clicked row)
  const focus = chainFilter || localFocus;            // spec, or null
  const focusRows = focus ? perChain.filter((c) => c.id === focus) : [];
  const focusSeries = focus ? (focusRows[0]?.values ?? []) : total;
  const focusName = focus ? (focusRows[0]?.name ?? focus) : null;
  const focusColor = focus ? (focusRows[0]?.color ?? "var(--brand)") : "var(--brand)";
  const curShown = focus
    ? (focusRows[0]?.cur ?? null)
    : (data?.rpsNow ?? null);

  const n = focus ? focusSeries.length : aggTimes.length;
  const tickIdx = n > 1 ? [0, Math.round((n - 1) * 0.25), Math.round((n - 1) * 0.5), Math.round((n - 1) * 0.75), n - 1] : [];
  const xLabels = tickIdx.map((i) => (aggTimes[i] ? roFmtTime(aggTimes[i]!, win) : ""));

  // table: restrict to the globally-selected chain when one is active
  const tableSource = chainFilter ? perChain.filter((c) => c.id === chainFilter) : perChain;
  const PER = 10;
  const filtered = query.trim()
    ? tableSource.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()))
    : tableSource;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PER));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(curPage * PER, curPage * PER + PER);
  useEffect(() => { setPage(0); }, [query]);

  const rpsFmt = (v: number) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v).toString());
  const sel: React.CSSProperties = { height: 28, padding: "0 10px", borderRadius: 7, border: "1px solid var(--line-2)", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "inherit", outline: "none" };

  return (
    <div className="gw-card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>Requests / sec</span>
        {focus && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, color: "var(--text-2)", padding: "2px 8px", borderRadius: 999, background: "var(--bg-2)", border: "1px solid var(--line)", marginLeft: 8 }}><span style={{ width: 7, height: 7, borderRadius: 2, background: focusColor }} />{focusName}</span>}
        {focus && !chainFilter && <button onClick={() => setLocalFocus(null)} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", fontSize: 11.5, fontWeight: 600, fontFamily: "inherit", padding: 0, marginLeft: 8 }}>← All chains</button>}
        <Tip text={"Total throughput across every chain over the **selected time window**, with a per-chain breakdown below.\n\nThe chart sums all chains; the table ranks them by volume — search to find a specific chain."} />
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "baseline", gap: 6 }}>
          <span className="gw-mono gw-tnum" style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{curShown != null ? rpsFmt(Math.round(curShown)) : "—"}</span>
          <span style={{ fontSize: 11, color: "var(--text-4)" }}>rps now{focus ? "" : " · " + perChain.length + " chain" + (perChain.length === 1 ? "" : "s")}</span>
        </span>
      </div>
      <div style={{ height: 180 }}>
        <LineChart series={[{ values: focusSeries, color: focusColor, width: 2 }]} id={"trafrps" + (focus || "all")} padX={46} padY={10} xLabels={xLabels} yFmt={rpsFmt} gridCount={4} />
      </div>

      <div style={{ height: 1, background: "var(--line)", margin: "4px 0 12px" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-3)" }}>By chain</span>
        <span style={{ fontSize: 10.5, color: "var(--text-4)" }}>— ranked by volume</span>
        <div style={{ flex: 1 }} />
        {!chainFilter && <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chain…" style={{ ...sel, width: 160 }} />}
      </div>
      <table className="gw-table">
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Chain</th>
            <th style={{ textAlign: "left", width: 160 }}>Trend</th>
            <th style={{ textAlign: "right" }}>RPS now</th>
            <th style={{ textAlign: "right" }}>Requests</th>
            <th style={{ textAlign: "right" }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((c) => {
            const sharePct = c.share != null ? c.share * 100 : null;
            const on = c.id === focus;
            return (
              <tr key={c.key} onClick={() => setLocalFocus(localFocus === c.id ? null : c.id)}
                style={{ cursor: "pointer", background: on ? "rgba(255,57,0,0.06)" : undefined, boxShadow: on ? "inset 2px 0 0 var(--brand)" : undefined }}>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <ChainBadge spec={c.key} size={16} />
                    <span style={{ fontSize: 12.5, color: "var(--text-2)", fontWeight: on ? 700 : 400 }}>{c.name}</span>
                    {c.net === "testnet" && <span style={{ fontSize: 9, color: "var(--text-4)" }}>testnet</span>}
                  </span>
                </td>
                <td><span style={{ display: "flex" }}><SparkLine values={c.values} color={c.color} width={140} height={20} /></span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{c.cur != null ? rpsFmt(Math.round(c.cur)) : "—"}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--text-2)" }}>{fmtNum(c.requests)}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--text-3)" }}>{sharePct == null ? "—" : (sharePct < 0.1 ? "<0.1" : sharePct.toFixed(1)) + "%"}</span></td>
              </tr>
            );
          })}
          {filtered.length === 0 && (
            <tr><td colSpan={5} style={{ padding: "20px 12px", textAlign: "center", color: "var(--text-4)", fontSize: 12.5 }}>{query ? `No chains match "${query}".` : "No traffic in this window."}</td></tr>
          )}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, paddingTop: 10 }}>
          <span style={{ fontSize: 11, color: "var(--text-4)" }}>{curPage * PER + 1}–{Math.min(filtered.length, curPage * PER + PER)} of {filtered.length}</span>
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={curPage === 0} className="gw-btn gw-btn--ghost" style={{ padding: "3px 9px", fontSize: 12, opacity: curPage === 0 ? 0.4 : 1, cursor: curPage === 0 ? "default" : "pointer" }}>Prev</button>
          <span style={{ fontSize: 11, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>{curPage + 1} / {pageCount}</span>
          <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={curPage >= pageCount - 1} className="gw-btn gw-btn--ghost" style={{ padding: "3px 9px", fontSize: 12, opacity: curPage >= pageCount - 1 ? 0.4 : 1, cursor: curPage >= pageCount - 1 ? "default" : "pointer" }}>Next</button>
        </div>
      )}
    </div>
  );
}
