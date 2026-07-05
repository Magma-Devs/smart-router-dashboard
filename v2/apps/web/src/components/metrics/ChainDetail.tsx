"use client";

/* ChainDetail — per-chain health drill-down inside the RouterOverview table.
 * Ported verbatim from the design prototype (page-metrics.jsx ChainDetail);
 * the mock's synthetic series are replaced by /api/metrics/chain-series,
 * fetched only while the row is expanded (this component only mounts then).
 * qos / backupShare = null ⇒ the design's own no-data option states. */

import { useState } from "react";
import { WINDOWS, type ChainSeries, type MetricWindow, type TimePoint } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { InteractiveChart, roFmtTime, roTimes } from "@/components/metrics/InteractiveChart";
import { fmtNum } from "@/lib/format";
import { seriesXY } from "./bits";

/** The already-loaded roster row backing the expanded chain. */
export interface ChainDetailRow {
  spec: string;
  /** Availability over the window, percent 0–100 (null = no traffic). */
  availPct: number | null;
  p95Ms: number | null;
  /** Error rate over the window, percent 0–100. */
  errPct: number | null;
  /** Composite QoS 0–100 (null = score not emitted). */
  qos: number | null;
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
}

const pct = (pts: TimePoint[] | null | undefined) => {
  const { values, times } = seriesXY(pts);
  return { values: values.map((v) => v * 100), times };
};

export function ChainDetail({ r, onChainClick, win }: { r: ChainDetailRow; onChainClick: (spec: string) => void; win: MetricWindow }) {
  const [selKey, setSelKey] = useState<string | null>(null);
  const { data } = useApi<ChainSeries>(`/api/metrics/chain-series?spec=${encodeURIComponent(r.spec)}&window=${win}`);

  if (!data) {
    return (
      <td colSpan={8} style={{ padding: 0, background: "var(--bg-2)", borderBottom: "1px solid var(--line)" }}>
        <div style={{ padding: "14px 16px", fontSize: 12, color: "var(--text-3)" }}>Loading chain health…</div>
      </td>
    );
  }

  const avail = pct(data.availability);
  const p95 = seriesXY(data.p95Ms);
  const err = pct(data.errorRate);
  const rps = seriesXY(data.rps);
  const qos = data.qos ? pct(data.qos) : null;
  const buShare = data.backupShare ? pct(data.backupShare) : null;
  const curBU = buShare && buShare.values.length ? buShare.values[buShare.values.length - 1]! : 0;
  const avgRps = r.requests / WINDOWS[win].rangeSeconds;
  const zeroTimes = rps.times.length ? rps.times : roTimes(win, 24);

  const metrics: Metric[] = [
    ...(r.availPct != null ? [{ key: "avail", label: "Availability", cur: r.availPct.toFixed(2) + "%", color: "#22c55e", values: avail.values, times: avail.times, yFmt: (v: number) => v.toFixed(2) + "%", target: { value: 99.9, label: "99.9%" } }] : []),
    ...(r.p95Ms != null ? [{ key: "p95", label: "P95 latency", cur: Math.round(r.p95Ms) + " ms", color: "#3b82f6", values: p95.values, times: p95.times, yFmt: (v: number) => Math.round(v) + " ms" }] : []),
    ...(r.errPct != null ? [{ key: "err", label: "Error rate", cur: r.errPct.toFixed(2) + "%", color: "#f97316", values: err.values, times: err.times, yFmt: (v: number) => v.toFixed(2) + "%" }] : []),
    { key: "rps", label: "Requests / sec", cur: fmtNum(Math.round(avgRps)), color: "var(--brand)", values: rps.values, times: rps.times, yFmt: (v: number) => fmtNum(Math.round(v)) },
    qos
      ? { key: "qos", label: "QoS", cur: r.qos != null ? String(Math.round(r.qos)) : "—", note: "composite", color: "#a78bfa", values: qos.values, times: qos.times, yFmt: (v: number) => v.toFixed(0), target: { value: 90, label: "admit ≥ 90" } }
      : { key: "qos", label: "QoS", cur: "—", note: "no data", color: "#a78bfa", values: [], times: [], yFmt: (v: number) => v.toFixed(0) },
    buShare
      ? { key: "routing", label: "Primary vs backup", cur: Math.round(curBU) + "% backup", color: "#fb923c", values: buShare.values, times: buShare.times, yFmt: (v: number) => v.toFixed(0) + "%", yDomain: [0, 100], caption: "share of traffic on backup — 0% = all primary" }
      : { key: "routing", label: "Primary vs backup", cur: "100% primary", note: "no backup", color: "#fb923c", values: zeroTimes.map(() => 0), times: zeroTimes, yFmt: (v: number) => v.toFixed(0) + "%", yDomain: [0, 100], caption: r.hasBackup ? "backup share unavailable for this window" : "single provider — no backup configured" },
  ];

  const m = metrics.find((x) => x.key === selKey) || metrics[0]!;
  const from = m.times.length ? roFmtTime(m.times[0]!, win) : roFmtTime(roTimes(win, 2)[0]!, win);

  return (
    <td colSpan={8} style={{ padding: 0, background: "var(--bg-2)", borderBottom: "1px solid var(--line)" }}>
      <div style={{ padding: "14px 16px" }}>
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
          {m.values.length ? (
            <InteractiveChart key={m.key} values={m.values} color={m.color} yFmt={m.yFmt} target={m.target} yDomain={m.yDomain} times={m.times} win={win} />
          ) : (
            <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-4)" }}>No samples in this window.</div>
          )}
        </div>
        <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
          <button onClick={(e) => { e.stopPropagation(); onChainClick(r.spec); }} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit", padding: 0 }}>View providers →</button>
        </div>
      </div>
    </td>
  );
}
