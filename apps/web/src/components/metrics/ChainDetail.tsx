"use client";

/* ChainDetail — per-chain health drill-down inside the RouterOverview table.
 * Ported verbatim from the design prototype (page-metrics.jsx ChainDetail);
 * the mock's synthetic series are replaced by /api/metrics/chain-series,
 * fetched only while the row is expanded (this component only mounts then).
 * The design's QoS option is gone: a selection score isn't something to act
 * on here. The "Primary vs backup" tile is gone too: its series is part 2 of
 * the Availability view (AvailabilityBreakdown), beside the chain's line and
 * its upstreams on one time axis. */

import { WINDOWS, type ChainSeries, type MetricWindow, type TimePoint } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { InteractiveChart, roFmtTime, roTimes } from "@/components/metrics/InteractiveChart";
import { AvailabilityBreakdown } from "./AvailabilityBreakdown";
import { fmtNum } from "@/lib/format";
import { seriesXY } from "./bits";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { Skel } from "@/components/gateway/Skel";

/** The already-loaded roster row backing the expanded chain. */
export interface ChainDetailRow {
  spec: string;
  /** The config router the row is; null when no values file names it. */
  routerId: string | null;
  /** Availability over the window, percent 0–100 (null = no traffic). */
  availPct: number | null;
  p95Ms: number | null;
  /** Error rate over the window, percent 0–100. */
  errPct: number | null;
  /** Requests over the selected window. */
  requests: number;
  /** True when the mounted config marks at least one backup for this chain. */
  hasBackup: boolean;
}

interface Metric {
  key: string;
  label: string;
  cur: string;
  note?: string;
  caption?: string;
  color: string;
  values: number[];
  times: Date[];
  yFmt: (v: number) => string;
  target?: { value: number; label: string };
  yDomain?: [number, number];
  yMaxCap?: number;
}

const pct = (pts: TimePoint[] | null | undefined) => {
  const { values, times } = seriesXY(pts);
  return { values: values.map((v) => v * 100), times };
};

/** `tile` is the picked tile's key (null = the first), held in the page's URL (`?tile=`). */
export function ChainDetail({ r, onChainClick, win, tile: selKey, onTile: setSelKey }: {
  r: ChainDetailRow;
  onChainClick: (spec: string) => void;
  win: MetricWindow;
  tile: string | null;
  onTile: (key: string) => void;
}) {
  const { scopeQ } = useFilters();
  const { data } = useApi<ChainSeries>(`/api/metrics/chain-series?spec=${encodeURIComponent(r.spec)}&window=${win}${scopeQ}`);

  // Ghosted rather than "Loading chain health…": the row expands inline, and a
  // line of text collapses to a different height than the chart that replaces
  // it, so the whole table jumped when the series landed.
  if (!data) {
    return (
      <td colSpan={8} style={{ padding: 0, background: "var(--bg-2)", borderBottom: "1px solid var(--line)" }}>
        <div style={{ padding: "16px", display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {[0, 1, 2, 3].map((i) => <Skel key={i} w={78} h={22} r={999} />)}
          </div>
          <Skel w="100%" h={132} r={8} />
        </div>
      </td>
    );
  }

  const avail = pct(data.availability);
  const p95 = seriesXY(data.p95Ms);
  const err = pct(data.errorRate);
  const rps = seriesXY(data.rps);
  const avgRps = r.requests / WINDOWS[win].rangeSeconds;

  // Percentage charts cap the auto y-domain at 100 — padding above the data
  // must never fabricate a ">100%" axis. Sub-1 RPS keeps decimals.
  const rpsFmt = (v: number) => (v > 0 && v < 1 ? v.toFixed(2) : fmtNum(Math.round(v)));
  const metrics: Metric[] = [
    ...(r.availPct != null ? [{ key: "avail", label: "Availability", cur: r.availPct.toFixed(2) + "%", color: "#22c55e", values: avail.values, times: avail.times, yFmt: (v: number) => v.toFixed(2) + "%", target: { value: 99.9, label: "99.9%" }, yMaxCap: 100 }] : []),
    ...(r.p95Ms != null ? [{ key: "p95", label: "P95 latency", cur: Math.round(r.p95Ms) + " ms", color: "#3b82f6", values: p95.values, times: p95.times, yFmt: (v: number) => Math.round(v) + " ms" }] : []),
    ...(r.errPct != null ? [{ key: "err", label: "Error rate", cur: r.errPct.toFixed(2) + "%", color: "#f97316", values: err.values, times: err.times, yFmt: (v: number) => v.toFixed(2) + "%", yMaxCap: 100 }] : []),
    { key: "rps", label: "Requests / sec", cur: avgRps > 0 && avgRps < 1 ? avgRps.toFixed(2) : fmtNum(Math.round(avgRps)), color: "var(--brand)", values: rps.values, times: rps.times, yFmt: rpsFmt },
  ];

  const m = metrics.find((x) => x.key === selKey) || metrics[0]!;
  // A link's tile this row doesn't draw in this window.
  const tileGone = selKey !== null && m.key !== selKey;
  const from = m.times.length ? roFmtTime(m.times[0]!, win) : roFmtTime(roTimes(win, 2)[0]!, win);

  return (
    <td colSpan={8} style={{ padding: 0, background: "var(--bg-2)", borderBottom: "1px solid var(--line)" }}>
      <div style={{ padding: "14px 16px" }}>
        {tileGone && (
          <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 10 }}>The chart in this link isn&apos;t available for this router in this window. Showing {m.label}.</div>
        )}
        {/* metric switcher */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          {metrics.map((x) => {
            const on = x.key === m.key;
            return (
              <button key={x.key} onClick={() => setSelKey(x.key)} style={{
                display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, minWidth: 104,
                padding: "7px 11px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                border: "1px solid " + (on ? x.color : "var(--line)"), background: on ? x.color + "1a" : "var(--bg)",
              }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, color: on ? "var(--text-2)" : "var(--text-3)" }}>
                  <span style={{ width: 7, height: 7, borderRadius: 2, background: x.color }} />{x.label}
                </span>
                <span className="gw-mono gw-tnum" style={{ fontSize: 15, fontWeight: 700, color: on ? "var(--text)" : "var(--text-2)" }}>
                  {x.cur}{x.note && <span style={{ fontSize: 9, fontWeight: 500, color: "var(--text-4)", marginLeft: 4 }}>{x.note}</span>}
                </span>
              </button>
            );
          })}
        </div>
        {/* focused interactive chart */}
        <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 8, padding: "12px 14px 8px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-2)" }}>{m.label}{m.caption && <span style={{ fontWeight: 400, color: "var(--text-4)", marginLeft: 7 }}>{m.caption}</span>}</span>
            <span style={{ fontSize: 10.5, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{from} → now</span>
          </div>
          {m.key === "avail" ? (
            // Availability, backup share and the upstreams, on one time axis.
            // backupShare null with backups configured is "no data", never 0%.
            <AvailabilityBreakdown spec={r.spec} routerId={r.routerId} win={win} color={m.color} availability={data.availability} backupShare={data.backupShare?.length ? data.backupShare : null} hasBackup={r.hasBackup} />
          ) : m.values.length ? (
            <InteractiveChart key={m.key} values={m.values} color={m.color} yFmt={m.yFmt} target={m.target} yDomain={m.yDomain} yMaxCap={m.yMaxCap} times={m.times} win={win} />
          ) : (
            <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-4)" }}>No samples in this window.</div>
          )}
        </div>
        <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
          <button onClick={(e) => { e.stopPropagation(); onChainClick(r.spec); }} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit", padding: 0 }}>View upstreams →</button>
        </div>
      </div>
    </td>
  );
}
