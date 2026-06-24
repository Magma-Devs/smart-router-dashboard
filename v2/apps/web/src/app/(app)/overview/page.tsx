"use client";

import { useState } from "react";
import { DEFAULT_WINDOW, type MetricWindow, type OverviewData, type TimePoint } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { WindowSelector } from "@/components/gateway/WindowSelector";
import { ChartLegend, LineChart, StackedAreaChart, type Layer } from "@/components/gateway/charts";
import { fmtNum, fmtPct } from "@/lib/format";

const vals = (pts: TimePoint[] | undefined) => (pts ?? []).map((p) => p.v ?? 0);

/** KPI card — base. */
function KPICard({
  label,
  value,
  deltaNode,
  sub,
  spark,
  children,
}: {
  label: string;
  value: React.ReactNode;
  deltaNode?: React.ReactNode;
  sub?: React.ReactNode;
  spark?: number[];
  children?: React.ReactNode;
}) {
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
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
              fill="none"
              stroke="var(--brand)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7, gap: 6 }}>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>{sub}</div>
        {deltaNode}
      </div>
      {children}
    </div>
  );
}

function deltaNode(value: number | null | undefined, prior: number | null | undefined, opts?: { lowerIsBetter?: boolean; suffix?: string }) {
  if (value == null || prior == null || prior === 0) return null;
  const diff = value - prior;
  if (Math.abs(diff) < 1e-9) return null;
  const better = opts?.lowerIsBetter ? diff < 0 : diff > 0;
  return (
    <div className="gw-mono" style={{ fontSize: 11, color: better ? "var(--ok)" : "var(--err)", flexShrink: 0 }}>
      {diff > 0 ? "↑" : "↓"} {fmtNum(Math.abs(diff))}{opts?.suffix ?? ""}
    </div>
  );
}

/** Latency KPI card with p50/p95/p99 selector. */
function LatencyCard({ data, pctile, setPctile }: { data?: OverviewData; pctile: "p50" | "p95" | "p99"; setPctile: (p: "p50" | "p95" | "p99") => void }) {
  const k = data ? (pctile === "p50" ? data.p50Ms : pctile === "p99" ? data.p99Ms : data.p95Ms) : undefined;
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="kpi-label">Latency</div>
        <div className="gw-segctl" style={{ transform: "scale(0.8)", transformOrigin: "right center" }}>
          {(["p50", "p95", "p99"] as const).map((p) => (
            <button key={p} className={pctile === p ? "on" : ""} onClick={() => setPctile(p)} style={{ padding: "3px 7px" }}>{p}</button>
          ))}
        </div>
      </div>
      <div className="gw-mono gw-tnum kpi-num" style={{ marginTop: 8 }}>{k?.value == null ? "—" : `${Math.round(k.value)} ms`}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7 }}>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>tail latency · {pctile}</div>
        {deltaNode(k?.value, k?.prior, { lowerIsBetter: true, suffix: " ms" })}
      </div>
    </div>
  );
}

/** Compute units — gated (not a router metric). */
function SCUCard({ data }: { data?: OverviewData }) {
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div className="kpi-label">Compute units</div>
      {data?.computeUnits.limit == null ? (
        <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 10, lineHeight: 1.5 }}>
          Not tracked — the Smart Router doesn&apos;t meter compute units.
        </div>
      ) : (
        <>
          <div className="gw-mono gw-tnum kpi-num" style={{ marginTop: 8 }}>{fmtNum(data.computeUnits.used)}</div>
          <div className="gw-bar" style={{ marginTop: 14 }}><span style={{ width: "62%" }} /></div>
        </>
      )}
    </div>
  );
}

function ChCard({ title, controls, footer, children }: { title: string; controls?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 0, minHeight: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-2)" }}>{title}</div>
        {controls && <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{controls}</div>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
      {footer && <div style={{ marginTop: 8, flexShrink: 0 }}>{footer}</div>}
    </div>
  );
}

export default function OverviewPage() {
  const [window, setWindow] = useState<MetricWindow>(DEFAULT_WINDOW);
  const [pctile, setPctile] = useState<"p50" | "p95" | "p99">("p95");
  const [stackByChain, setStackByChain] = useState(false);
  const { data } = useApi<OverviewData>(`/api/metrics/overview?window=${window}`);

  const chainLayers: Layer[] = (data?.perChainSeries ?? []).map((s) => ({ name: s.name, color: s.color, values: vals(s.points) }));
  const latVals = data ? vals(data.latencySeries[pctile]) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "14px 28px", boxSizing: "border-box" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button className="gw-btn" style={{ height: 32, fontSize: 12, padding: "0 10px" }}>
          <span style={{ display: "inline-flex", gap: 2 }}>
            <span style={{ width: 4, height: 9, borderRadius: 1, background: "#627EEA" }} />
            <span style={{ width: 4, height: 9, borderRadius: 1, background: "#14F195" }} />
            <span style={{ width: 4, height: 9, borderRadius: 1, background: "#0052FF" }} />
          </span>
          All chains ▾
        </button>
        <div style={{ flex: 1 }} />
        <WindowSelector value={window} onChange={setWindow} />
        <button className="gw-btn gw-btn--primary" style={{ fontSize: 12, padding: "5px 12px" }}>View full logs ↗</button>
      </div>

      {/* KPI strip (5 cards) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
        <KPICard
          label="Success Rate"
          value={fmtPct(data?.successRate.value)}
          sub={`vs prior ${window}`}
          deltaNode={deltaNode(data?.successRate.value, data?.successRate.prior, { suffix: "" })}
        />
        <LatencyCard data={data} pctile={pctile} setPctile={setPctile} />
        <KPICard
          label="Errors Handled"
          value={fmtNum(data?.errors.value)}
          sub={`${fmtPct(data?.errorRate)} error rate`}
        />
        <KPICard
          label="RPC Traffic"
          value={<span>{fmtNum(data?.throughputRps.value)} <span style={{ fontSize: 15 }} className="muted">req/s</span></span>}
          sub="current throughput"
          spark={vals(data?.throughput)}
          deltaNode={deltaNode(data?.throughputRps.value, data?.throughputRps.prior, { suffix: " req/s" })}
        />
        <SCUCard data={data} />
      </div>

      {/* 2×2 chart grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "300px 300px", gap: 10 }}>
        {/* A — Throughput */}
        <ChCard
          title="Throughput · req/s"
          controls={
            <button
              onClick={() => setStackByChain((s) => !s)}
              style={{ fontSize: 10, padding: "3px 8px", borderRadius: 5, border: "1px solid var(--line)", background: stackByChain ? "var(--brand)" : "transparent", color: stackByChain ? "#fff" : "var(--text-3)", cursor: "pointer", fontFamily: "inherit" }}
            >
              Stack by chain
            </button>
          }
          footer={stackByChain ? <ChartLegend items={chainLayers.map((l) => ({ label: l.name, color: l.color, square: true }))} /> : undefined}
        >
          {stackByChain
            ? <StackedAreaChart layers={chainLayers} height={230} />
            : <LineChart series={[{ values: vals(data?.throughput), color: "var(--brand)", width: 2 }]} height={230} />}
        </ChCard>

        {/* B — Errors over time */}
        <ChCard title="Errors over time">
          <LineChart series={[{ values: vals(data?.errorsSeries), color: "var(--err)", width: 2, fill: true }]} height={230} />
        </ChCard>

        {/* C — Latency */}
        <ChCard
          title="Latency · ms"
          controls={
            <div className="gw-segctl" style={{ transform: "scale(0.82)", transformOrigin: "right center" }}>
              {(["p50", "p95", "p99"] as const).map((p) => (
                <button key={p} className={pctile === p ? "on" : ""} onClick={() => setPctile(p)} style={{ padding: "3px 7px" }}>{p}</button>
              ))}
            </div>
          }
        >
          <LineChart series={[{ values: latVals, color: "var(--info)", width: 2 }]} height={230} yFmt={(v) => Math.round(v) + "ms"} />
        </ChCard>

        {/* D — Requests per chain */}
        <ChCard
          title="Requests per chain"
          footer={<ChartLegend items={chainLayers.map((l) => ({ label: l.name, color: l.color, square: true }))} />}
        >
          <StackedAreaChart layers={chainLayers} normalized height={230} />
        </ChCard>
      </div>
    </div>
  );
}
