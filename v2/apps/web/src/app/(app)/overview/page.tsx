"use client";

import { useState } from "react";
import { DEFAULT_WINDOW, type MetricWindow, type OverviewData, type TimePoint } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { WindowSelector } from "@/components/gateway/WindowSelector";
import { Sparkline } from "@/components/gateway/Sparkline";
import { MiniBars, MiniSpark } from "@/components/gateway/MiniSpark";
import { fmtMs, fmtNum, fmtPct } from "@/lib/format";

function delta(value: number | null, prior: number | null, opts?: { lowerIsBetter?: boolean; suffix?: string }) {
  if (value === null || prior === null || prior === 0) return null;
  const diff = value - prior;
  if (Math.abs(diff) < 1e-9) return null;
  const better = opts?.lowerIsBetter ? diff < 0 : diff > 0;
  const arrow = diff > 0 ? "↑" : "↓";
  return (
    <span className={better ? "up" : "down"}>
      {arrow} {fmtNum(Math.abs(diff))}{opts?.suffix ?? ""} vs prior
    </span>
  );
}

function HeroCard({
  label,
  value,
  sub,
  spark,
  color = "var(--brand)",
  deltaNode,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  spark?: { points: TimePoint[] };
  color?: string;
  deltaNode?: React.ReactNode;
}) {
  return (
    <div className="gw-card">
      <p className="kpi__label">{label}</p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="kpi__value" style={{ color }}>{value}</div>
        {spark && <MiniSpark points={spark.points} color={color} width={80} />}
      </div>
      {sub && <div className="kpi__sub">{sub}</div>}
      {deltaNode && <div className="kpi__delta">{deltaNode}</div>}
    </div>
  );
}

export default function OverviewPage() {
  const [window, setWindow] = useState<MetricWindow>(DEFAULT_WINDOW);
  const { data } = useApi<OverviewData>(`/api/metrics/overview?window=${window}`);

  return (
    <div className="gw-page" style={{ maxWidth: 1280 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Overview</h1>
          <p className="lede">Live metrics across all routes</p>
        </div>
        <WindowSelector value={window} onChange={setWindow} />
      </div>

      {/* 4 hero KPI cards */}
      <div className="gw-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 16 }}>
        <HeroCard
          label="Total requests"
          value={fmtNum(data?.totalRequests.value)}
          sub={`${window} window · all routes`}
          spark={{ points: data?.throughput ?? [] }}
          deltaNode={delta(data?.totalRequests.value ?? null, data?.totalRequests.prior ?? null)}
        />
        <HeroCard
          label="Throughput"
          value={<span>{fmtNum(data?.throughputRps.value)} <span style={{ fontSize: 16 }} className="muted">rps</span></span>}
          sub={data?.rpsCap ? `of ${data.rpsCap} rps cap` : "rps cap not tracked"}
          color="var(--info)"
          spark={{ points: data?.throughput ?? [] }}
        />
        <HeroCard
          label="Errors"
          value={fmtNum(data?.errors.value)}
          sub={`${fmtPct(data?.errorRate)} error rate`}
          color="var(--text)"
        />
        <HeroCard
          label="Uptime"
          value={fmtPct(data?.uptime)}
          sub={`reachability · ${data?.health === "operational" ? "100% now" : "degraded"}`}
          color="var(--ok)"
        />
      </div>

      {/* Compute Units (gated — not a router metric) + P50 latency */}
      <div className="gw-grid" style={{ gridTemplateColumns: "2fr 1fr", marginBottom: 16 }}>
        <div className="gw-card gw-card--accent">
          <p className="kpi__label">Compute units</p>
          {data?.computeUnits.limit == null ? (
            <div className="muted" style={{ padding: "12px 0", fontSize: 13 }}>
              Compute-unit quota isn&apos;t emitted by the Smart Router (it&apos;s a Lava-consumer
              billing concept). Set a limit per-deployment to track usage here.
            </div>
          ) : (
            <>
              <div className="kpi__value">
                {fmtNum(data.computeUnits.used)} <span className="muted" style={{ fontSize: 16 }}>/ {fmtNum(data.computeUnits.limit)}</span>
              </div>
              <div className="gw-bar" style={{ marginTop: 14 }}><span style={{ width: "62%" }} /></div>
            </>
          )}
        </div>
        <div className="gw-card">
          <p className="kpi__label">P50 latency · ms</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            {(data?.perChainLatency ?? []).map((c) => (
              <div key={c.spec} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.color }} />
                <span style={{ flex: 1, fontSize: 13 }}>
                  {c.name}
                  {c.degraded && <span className="tag tag--err" style={{ marginLeft: 6, fontSize: 9 }}>degraded</span>}
                </span>
                <span className="mono" style={{ fontSize: 12 }}>{fmtMs(c.p50Ms)}</span>
                <MiniBars points={c.trend} color={c.color} />
              </div>
            ))}
            {data && data.perChainLatency.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No latency data yet.</span>}
          </div>
        </div>
      </div>

      {/* Throughput chart + Active routes */}
      <div className="gw-grid" style={{ gridTemplateColumns: "2fr 1fr" }}>
        <div className="gw-card">
          <p className="kpi__label">Throughput · rps</p>
          <Sparkline points={data?.throughput ?? []} height={200} />
        </div>
        <div className="gw-card">
          <p className="kpi__label">Active routes · requests</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
            {(data?.activeRoutes ?? []).map((rt) => (
              <div key={`${rt.spec}-${rt.endpointId}`}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                  <span>{rt.endpointId}</span>
                  <span className="muted">{fmtNum(rt.requests)}</span>
                </div>
                <div className="gw-bar"><span style={{ width: `${Math.round(rt.share * 100)}%`, background: rt.color }} /></div>
              </div>
            ))}
            {data && data.activeRoutes.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No routes with traffic yet.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
