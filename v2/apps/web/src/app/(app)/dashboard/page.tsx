"use client";

import { useState } from "react";
import { DEFAULT_WINDOW, type MetricWindow, type OverviewData, type TimePoint } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { WindowSelector } from "@/components/gateway/WindowSelector";
import { ChartLegend, ColumnChart, LineChart, StackedAreaChart, type Layer } from "@/components/gateway/charts";
import { fmtNum, fmtPct } from "@/lib/format";

const vals = (pts: TimePoint[] | undefined) => (pts ?? []).map((p) => p.v ?? 0);

function deltaNode(value: number | null | undefined, prior: number | null | undefined, opts?: { lowerIsBetter?: boolean; suffix?: string }) {
  if (value == null || prior == null || prior === 0) return null;
  const diff = value - prior;
  if (Math.abs(diff) < 1e-9) return null;
  const better = opts?.lowerIsBetter ? diff < 0 : diff > 0;
  return (
    <div className="gw-mono" style={{ fontSize: 11, color: better ? "var(--ok)" : "var(--err)", marginTop: 7 }}>
      {diff > 0 ? "↑" : "↓"} {fmtNum(Math.abs(diff))}{opts?.suffix ?? ""} vs prior
    </div>
  );
}

function KpiCard({
  label,
  value,
  delta,
  sub,
  children,
}: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  sub?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div className="kpi-label">{label}</div>
      <div className="gw-mono gw-tnum kpi-num" style={{ marginTop: 8, fontSize: 30 }}>{value}</div>
      {delta}
      {sub && <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 7 }}>{sub}</div>}
      {children}
    </div>
  );
}

function ChCard({ title, controls, footer, children }: { title: React.ReactNode; controls?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-2)" }}>{title}</div>
        {controls}
      </div>
      {children}
      {footer && <div style={{ marginTop: 8 }}>{footer}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const [window, setWindow] = useState<MetricWindow>(DEFAULT_WINDOW);
  const [pctile, setPctile] = useState<"p50" | "p95" | "p99">("p95");
  const { data } = useApi<OverviewData>(`/api/metrics/overview?window=${window}`);

  const lat = data ? (pctile === "p50" ? data.p50Ms : pctile === "p99" ? data.p99Ms : data.p95Ms) : undefined;
  const latVals = data ? vals(data.latencySeries[pctile]) : [];
  const chainLayers: Layer[] = (data?.perChainSeries ?? []).slice(0, 5).map((s) => ({ name: s.name, color: s.color, values: vals(s.points) }));

  const seg = (
    <div className="gw-segctl" style={{ transform: "scale(0.82)", transformOrigin: "right center" }}>
      {(["p50", "p95", "p99"] as const).map((p) => (
        <button key={p} className={pctile === p ? "on" : ""} onClick={() => setPctile(p)} style={{ padding: "3px 7px" }}>{p}</button>
      ))}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "14px 28px", boxSizing: "border-box" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>Smart Router</div>
          <div className="muted" style={{ fontSize: 11 }}>live deployment</div>
        </div>
        <WindowSelector value={window} onChange={setWindow} />
        <div style={{ flex: 1 }} />
        <button className="gw-btn gw-btn--primary" style={{ fontSize: 12, padding: "5px 12px" }}>Export report</button>
      </div>

      {/* 5 KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
        <KpiCard
          label="Success rate"
          value={<span style={{ color: "var(--ok)" }}>{fmtPct(data?.successRate.value)}</span>}
          delta={deltaNode(data?.successRate.value, data?.successRate.prior, { suffix: "" })}
        />
        <KpiCard label="P95 latency" value={lat?.value == null ? "—" : `${Math.round(lat.value)} ms`} delta={deltaNode(lat?.value, lat?.prior, { lowerIsBetter: true, suffix: " ms" })}>
          <div style={{ marginTop: 10 }}>{seg}</div>
        </KpiCard>
        <KpiCard label="Errors handled" value={fmtNum(data?.errors.value)} sub={`${fmtPct(data?.errorRate)} error rate`} />
        <KpiCard
          label="RPC traffic"
          value={<span style={{ color: "var(--info)" }}>{fmtNum(data?.throughputRps.value)} <span style={{ fontSize: 18 }} className="muted">req/s</span></span>}
          delta={deltaNode(data?.throughputRps.value, data?.throughputRps.prior, { suffix: " req/s" })}
        />
        <KpiCard label="SCUs" value={fmtNum(data?.totalRequests.value)} sub={data?.computeUnits.limit == null ? "monthly quota not tracked" : "of monthly quota"} />
      </div>

      {/* Throughput + Total errors */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <ChCard title={<span>Throughput <span className="muted" style={{ fontWeight: 400 }}>· {fmtNum(data?.throughputRps.value)} req/s</span></span>}>
          <LineChart series={[{ values: vals(data?.throughput), color: "var(--brand)", width: 2 }]} height={220} />
        </ChCard>
        <ChCard title={<span>Total errors <span className="muted" style={{ fontWeight: 400 }}>· over time</span></span>}>
          <ColumnChart stacks={[{ name: "errors", color: "var(--text-3)", values: vals(data?.errorsSeries) }]} height={220} highlightSpikes />
        </ChCard>
      </div>

      {/* Latency + Requests per chain */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <ChCard title="Latency · ms" controls={seg}>
          <LineChart series={[{ values: latVals, color: "var(--text-2)", width: 2 }]} height={220} yFmt={(v) => Math.round(v) + "ms"} />
        </ChCard>
        <ChCard
          title={<span>Requests per chain <span className="muted" style={{ fontWeight: 400 }}>· top 5</span></span>}
          footer={<ChartLegend items={chainLayers.map((l) => ({ label: l.name, color: l.color, square: true }))} />}
        >
          <StackedAreaChart layers={chainLayers} height={220} />
        </ChCard>
      </div>
    </div>
  );
}
