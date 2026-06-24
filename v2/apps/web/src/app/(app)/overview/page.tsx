"use client";

import { useState } from "react";
import { type MetricWindow, type OverviewData, type TimePoint } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { LineChart } from "@/components/gateway/charts";
import { MiniBars } from "@/components/gateway/MiniSpark";
import { fmtMs, fmtNum, fmtPct } from "@/lib/format";

const vals = (pts: TimePoint[] | undefined) => (pts ?? []).map((p) => p.v ?? 0);

/** 3-button window toggle (1h / 24h / 7d) — the design's selector. */
function WinToggle({ value, onChange }: { value: MetricWindow; onChange: (w: MetricWindow) => void }) {
  const opts: [MetricWindow, string][] = [["1h", "1h"], ["1d", "24h"], ["7d", "7d"]];
  return (
    <div className="gw-segctl">
      {opts.map(([w, label]) => (
        <button key={w} className={value === w ? "on" : ""} onClick={() => onChange(w)}>{label}</button>
      ))}
    </div>
  );
}

/** KPI card — label, value (+ optional sparkline), sub. */
function KpiCard({ label, value, sub, spark }: { label: string; value: React.ReactNode; sub: string; spark?: number[] }) {
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column" }}>
      <div className="kpi-label">{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 8, gap: 6 }}>
        <div className="gw-mono gw-tnum kpi-num">{value}</div>
        {spark && spark.length > 1 && (
          <svg width={56} height={22} style={{ display: "block", flexShrink: 0, opacity: 0.75 }}>
            <polyline
              points={spark.map((v, i) => {
                const mn = Math.min(...spark);
                const rng = Math.max(...spark) - mn || 1;
                return `${((i / (spark.length - 1)) * 56).toFixed(1)},${(22 - 2 - ((v - mn) / rng) * 18).toFixed(1)}`;
              }).join(" ")}
              fill="none" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 7 }}>{sub}</div>
    </div>
  );
}

export default function OverviewPage() {
  const [window, setWindow] = useState<MetricWindow>("1d");
  const { data } = useApi<OverviewData>(`/api/metrics/overview?window=${window}`);
  const winLabel = window === "1h" ? "1h" : window === "7d" ? "7d" : "24h";

  const cu = data?.computeUnits;
  const cuPct = cu && cu.used != null && cu.limit ? (cu.used / cu.limit) * 100 : null;

  return (
    <div className="gw-page" style={{ maxWidth: 968, padding: "28px 32px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>Overview</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-3)", fontSize: 13 }}>Live metrics across all routes</p>
        </div>
        <WinToggle value={window} onChange={setWindow} />
      </div>

      {/* KPI strip — 4 cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 16 }}>
        <KpiCard label="Total Requests" value={fmtNum(data?.totalRequests.value)} sub={`${winLabel} window · all routes`} spark={vals(data?.throughput)} />
        <KpiCard
          label="Throughput"
          value={<span style={{ color: "var(--info)" }}>{fmtNum(data?.throughputRps.value)}<span style={{ fontSize: 16, color: "var(--text-3)", marginLeft: 6 }}>rps</span></span>}
          sub={data?.rpsCap ? `of ${data.rpsCap} rps cap` : "rps cap not tracked"}
          spark={vals(data?.throughput)}
        />
        <KpiCard label="Errors" value={fmtNum(data?.errors.value)} sub={`${fmtPct(data?.errorRate)} error rate`} />
        <KpiCard
          label="Uptime"
          value={<span style={{ color: "var(--ok)" }}>{fmtPct(data?.uptime)}</span>}
          sub={`reachability · ${data?.health === "operational" ? "100% now" : "degraded"}`}
        />
      </div>

      {/* Row 2 — 638 / 298 two-column, fixed heights matching the design */}
      <div style={{ display: "grid", gridTemplateColumns: "2.14fr 1fr", gap: 16 }}>
        {/* Left column — Compute units (173px) + Throughput·RPS (323px) */}
        <div style={{ display: "grid", gridTemplateRows: "173px 323px", gap: 16 }}>
          {/* Compute units */}
          <div className="gw-card gw-card--accent">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div className="kpi-label">Compute units</div>
                <div className="gw-mono gw-tnum" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 10 }}>
                  {cu?.used == null ? "—" : cu.used.toLocaleString()}
                  {cu?.limit != null && <span style={{ color: "var(--text-3)", fontWeight: 400 }}> / {cu.limit.toLocaleString()}</span>}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                {cuPct != null ? (
                  <span className="tag tag--ok" style={{ fontSize: 11 }}>{cuPct.toFixed(1)}% used</span>
                ) : (
                  <span className="tag tag--muted" style={{ fontSize: 11 }}>not tracked</span>
                )}
                <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>
                  {cu?.resetsAt ? `Resets ${cu.resetsAt}` : "no quota meter"}
                </div>
              </div>
            </div>
            <div className="gw-bar" style={{ marginTop: 16, height: 8 }}>
              <span style={{ width: `${Math.min(cuPct ?? 0, 100)}%` }} />
            </div>
          </div>

          {/* Throughput · RPS chart */}
          <div className="gw-card" style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-2)" }}>Throughput · RPS</span>
                <span style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 8 }}>{data?.rpsCap ? `Cap ${data.rpsCap} req/s` : "no cap"}</span>
              </div>
              <WinToggle value={window} onChange={setWindow} />
            </div>
            <div style={{ flex: 1, minHeight: 240 }}>
              <LineChart
                series={[{ values: vals(data?.throughput), color: "var(--brand)", width: 2, fill: true }]}
                height={250}
                yFmt={(v) => {
                  if (data?.rpsCap) return Math.round((v / data.rpsCap) * 100) + "%";
                  return v >= 1 ? Math.round(v).toString() : v.toFixed(2);
                }}
              />
            </div>
            <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
              {[["RPS", "var(--brand)"], ["Cap", "var(--text-3)"], ["Throttled", "var(--err)"]].map(([l, c]) => (
                <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-3)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: c, opacity: 0.85 }} />{l}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Right column — p50 latency (flex-grows) + Active routes (215px) */}
        <div style={{ display: "grid", gridTemplateRows: "1fr 215px", gap: 16 }}>
          {/* p50 latency · ms */}
          <div className="gw-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span className="kpi-label">p50 latency · ms</span>
              <WinToggle value={window} onChange={setWindow} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {(data?.perChainLatency ?? []).map((c) => (
                <div key={c.spec} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 13 }}>
                    {c.name}
                    {c.degraded && <span className="tag tag--err" style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px" }}>degraded</span>}
                  </span>
                  <span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtMs(c.p50Ms)}</span>
                  <MiniBars points={c.trend} color={c.color} />
                </div>
              ))}
              {data && data.perChainLatency.length === 0 && <span style={{ fontSize: 13, color: "var(--text-3)" }}>No latency data yet.</span>}
            </div>
          </div>

          {/* Active routes · requests today */}
          <div className="gw-card">
            <div className="kpi-label" style={{ marginBottom: 12 }}>Active routes · requests</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {(data?.activeRoutes ?? []).map((rt) => (
                <div key={`${rt.spec}-${rt.endpointId}`}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: rt.color }} />
                      {rt.endpointId}
                    </span>
                    <span className="gw-mono gw-tnum" style={{ color: "var(--text-3)" }}>{fmtNum(rt.requests)}</span>
                  </div>
                  <div className="gw-bar" style={{ height: 4 }}><span style={{ width: `${Math.round(rt.share * 100)}%`, background: rt.color }} /></div>
                </div>
              ))}
              {data && data.activeRoutes.length === 0 && <span style={{ fontSize: 13, color: "var(--text-3)" }}>No routes with traffic yet.</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
