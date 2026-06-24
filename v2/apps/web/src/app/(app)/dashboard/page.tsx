"use client";

import { useState } from "react";
import { DEFAULT_WINDOW, type MetricWindow, type OverviewData, type TimePoint } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { WindowSelector } from "@/components/gateway/WindowSelector";
import { Sparkline } from "@/components/gateway/Sparkline";
import { MiniSpark } from "@/components/gateway/MiniSpark";
import { fmtMs, fmtNum, fmtPct } from "@/lib/format";

/** Vertical bar chart for the "Total errors" panel. */
function BarChart({ points, height = 200 }: { points: TimePoint[]; height?: number }) {
  const vals = points.map((p) => p.v ?? 0);
  if (vals.length < 2) return <div className="muted" style={{ height, display: "grid", placeItems: "center", fontSize: 13 }}>No data yet</div>;
  const max = Math.max(...vals, 0.0001);
  const w = 600;
  const bw = w / vals.length;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      {vals.map((v, i) => {
        const h = Math.max(1, (v / max) * (height - 4));
        return <rect key={i} x={i * bw + 1} y={height - h} width={bw - 2} height={h} fill="var(--text-3)" opacity={0.5} />;
      })}
    </svg>
  );
}

/** Stacked area for "requests per chain". */
function StackedArea({ series, height = 200 }: { series: OverviewData["perChainSeries"]; height?: number }) {
  if (!series.length || !series[0]?.points.length) {
    return <div className="muted" style={{ height, display: "grid", placeItems: "center", fontSize: 13 }}>No data yet</div>;
  }
  const n = series[0].points.length;
  const w = 600;
  const stepX = w / Math.max(1, n - 1);
  // cumulative stack per time index
  const stackTop = new Array(n).fill(0) as number[];
  const totals = new Array(n).fill(0) as number[];
  for (const s of series) for (let i = 0; i < n; i++) totals[i]! += s.points[i]?.v ?? 0;
  const max = Math.max(...totals, 0.0001);
  const yOf = (v: number) => height - (v / max) * (height - 4) - 2;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      {series.map((s) => {
        const lower: string[] = [];
        const upper: string[] = [];
        for (let i = 0; i < n; i++) {
          const x = i * stepX;
          const base = stackTop[i]!;
          const top = base + (s.points[i]?.v ?? 0);
          lower.push(`${x},${yOf(base)}`);
          upper.push(`${x},${yOf(top)}`);
          stackTop[i] = top;
        }
        const poly = [...upper, ...lower.reverse()].join(" ");
        return <polygon key={s.spec} points={poly} fill={s.color} opacity={0.85} />;
      })}
    </svg>
  );
}

function KpiCard({
  label,
  value,
  unit,
  sub,
  delta,
  spark,
  color = "var(--text)",
  children,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  sub?: React.ReactNode;
  delta?: React.ReactNode;
  spark?: { points: TimePoint[]; color?: string };
  color?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="gw-card">
      <p className="kpi__label">{label}</p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div className="kpi__value" style={{ color }}>
          {value}{unit && <span style={{ fontSize: 16 }} className="muted"> {unit}</span>}
        </div>
        {spark && <MiniSpark points={spark.points} color={spark.color ?? "var(--brand)"} width={70} />}
      </div>
      {delta && <div className="kpi__delta">{delta}</div>}
      {sub && <div className="kpi__sub">{sub}</div>}
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const [window, setWindow] = useState<MetricWindow>(DEFAULT_WINDOW);
  const [pctile, setPctile] = useState<"p50" | "p95" | "p99">("p95");
  const { data } = useApi<OverviewData>(`/api/metrics/overview?window=${window}`);

  const lat = data ? (pctile === "p50" ? data.p50Ms : pctile === "p99" ? data.p99Ms : data.p95Ms) : undefined;
  const top5 = (data?.perChainSeries ?? []).slice(0, 5);

  return (
    <div className="gw-page" style={{ maxWidth: 1280 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Smart Router</div>
            <div className="muted" style={{ fontSize: 11 }}>live deployment</div>
          </div>
          <WindowSelector value={window} onChange={setWindow} />
        </div>
        <button className="gw-btn gw-btn--primary">Export report</button>
      </div>

      {/* 5 KPI cards */}
      <div className="gw-grid" style={{ gridTemplateColumns: "repeat(5, 1fr)", marginBottom: 16 }}>
        <KpiCard
          label="Success rate"
          value={fmtPct(data?.successRate.value)}
          color="var(--ok)"
          spark={{ points: data?.throughput ?? [], color: "var(--ok)" }}
        />
        <KpiCard label="P95 latency" value={fmtMs(lat?.value).replace(" ms", "")} unit="ms" color="var(--text)">
          <div className="gw-seg gw-seg--sm" style={{ marginTop: 10 }}>
            {(["p50", "p95", "p99"] as const).map((p) => (
              <button key={p} className={p === pctile ? "active" : ""} onClick={() => setPctile(p)}>{p}</button>
            ))}
          </div>
        </KpiCard>
        <KpiCard label="Errors handled" value={fmtNum(data?.errors.value)} sub={`${fmtPct(data?.errorRate)} error rate`} />
        <KpiCard
          label="RPC traffic"
          value={<span>{fmtNum(data?.throughputRps.value)}<br /><span style={{ fontSize: 22 }} className="muted">req/s</span></span>}
          color="var(--info)"
          spark={{ points: data?.throughput ?? [], color: "var(--info)" }}
        />
        <KpiCard
          label="SCUs"
          value={fmtNum(data?.totalRequests.value)}
          sub={data?.computeUnits.limit == null ? "monthly quota not tracked" : "of monthly quota"}
        />
      </div>

      {/* Throughput + Total errors */}
      <div className="gw-grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}>
        <div className="gw-card">
          <p className="kpi__label">Throughput <span className="muted" style={{ textTransform: "none" }}>· {fmtNum(data?.throughputRps.value)} req/s</span></p>
          <Sparkline points={data?.throughput ?? []} height={200} />
        </div>
        <div className="gw-card">
          <p className="kpi__label">Total errors</p>
          <BarChart points={data?.errorsSeries ?? []} />
        </div>
      </div>

      {/* Latency + Requests per chain */}
      <div className="gw-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="gw-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <p className="kpi__label" style={{ margin: 0 }}>Latency · ms</p>
            <div className="gw-seg gw-seg--sm">
              {(["p50", "p95", "p99"] as const).map((p) => (
                <button key={p} className={p === pctile ? "active" : ""} onClick={() => setPctile(p)}>{p}</button>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <Sparkline points={data?.latencySeries ?? []} height={200} color="var(--text-2)" />
          </div>
        </div>
        <div className="gw-card">
          <p className="kpi__label">Requests per chain <span className="muted" style={{ textTransform: "none" }}>· top 5</span></p>
          <StackedArea series={top5} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
            {top5.map((s) => (
              <span key={s.spec} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11 }} className="muted">
                <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
                {s.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
