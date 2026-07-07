"use client";

/* Port of SR_Dashboard/magma/page-overview.jsx — Overview: KPI strip +
 * 2×2 chart grid, no-scroll at 1440×900. Inline styles are verbatim from the
 * prototype (load-bearing pixel values). Data is live: /api/metrics/overview.
 * Unbacked values render the design's own honest states, never inventions. */

import { useMemo, useState } from "react";
import {
  buildChainMetaByIndex,
  type MetricWindow,
  type OverviewData,
  type TimePoint,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { RouterHeader } from "@/components/gateway/RouterHeader";
import {
  ChartLegend,
  ColumnChart,
  LineChart,
  SparkLine,
  StackedAreaChart,
} from "@/components/gateway/charts";
import { CHAIN_CLR } from "@/lib/colors";
import { fmtComma } from "@/lib/format";

/** Palette for per-upstream series (the prototype's PROV_META is mock-only). */
const UPSTREAM_PALETTE = ["#60a5fa", "#22c55e", "#f59e0b", "#a78bfa", "#f472b6", "#2dd4bf"];

const nums = (pts: TimePoint[] | undefined): number[] => (pts ?? []).map((p) => p.v ?? 0);

/* ── KPI card — base ────────────────────────────────────────────────── */
function KPICard({
  label,
  value,
  deltaStr,
  deltaGood,
  sub,
  spark,
  children,
}: {
  label: string;
  value: string;
  deltaStr?: string | null;
  deltaGood?: boolean | null;
  sub: string;
  spark?: number[];
  children?: React.ReactNode;
}) {
  const dc = deltaGood == null ? "var(--text-3)" : deltaGood ? "var(--ok)" : "var(--err)";
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 600, color: "var(--text-3)" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 8, gap: 6 }}>
        <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1 }}>{value}</div>
        {spark && spark.length > 1 && <SparkLine values={spark} color="var(--brand)" width={56} height={22} />}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7, gap: 6 }}>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>{sub}</div>
        {deltaStr && <div className="gw-mono" style={{ fontSize: 11, color: dc, flexShrink: 0 }}>{deltaStr}</div>}
      </div>
      {children}
    </div>
  );
}

/* ── Latency KPI card — with percentile selector ────────────────────── */
function LatencyCard({ data }: { data: OverviewData | undefined }) {
  const [pct, setPct] = useState<"p50" | "p95" | "p99">("p95");
  const kpi = data ? { p50: data.p50Ms, p95: data.p95Ms, p99: data.p99Ms }[pct] : undefined;
  const val = kpi?.value ?? null;
  const d = val !== null && kpi?.prior != null ? val - kpi.prior : null;
  const good = d !== null && d < 0; // ↓ latency = good
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 600, color: "var(--text-3)" }}>Latency</div>
        <div className="gw-segctl" style={{ transform: "scale(0.8)", transformOrigin: "right center" }}>
          {(["p50", "p95", "p99"] as const).map((p) => (
            <button key={p} className={pct === p ? "on" : ""} onClick={() => setPct(p)} style={{ padding: "3px 7px" }}>{p}</button>
          ))}
        </div>
      </div>
      <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, marginTop: 8 }}>
        {val === null ? "—" : `${Math.round(val)} ms`}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7 }}>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>tail latency · {pct}</div>
        {d !== null && (
          <div className="gw-mono" style={{ fontSize: 11, color: good ? "var(--ok)" : "var(--err)" }}>
            {d < 0 ? "↓" : "↑"} {Math.abs(Math.round(d))} ms
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Errors card — with breakdown flyout ────────────────────────────── */
function ErrorsCard({ data }: { data: OverviewData | undefined }) {
  const [open, setOpen] = useState(false);
  const total = data?.errors.value ?? null;
  const prior = data?.errors.prior ?? null;
  const delta = total !== null && prior !== null ? total - prior : null;
  // Real error layers only (a single "unclassified" layer until the router
  // emits labelled error counters) — the design's mock breakdown is invented.
  const brEntries = (data?.errorLayers ?? []).map((l) => [l.layer, l.count] as const);
  const brTotal = brEntries.reduce((a, [, v]) => a + v, 0);
  const LAYER_CLR = ["var(--err)", "var(--warn)", "var(--info)", "var(--text-3)"];
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 0, position: "relative" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 600, color: "var(--text-3)" }}>Errors</div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 8, gap: 6 }}>
        <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1 }}>
          {total === null ? "—" : fmtComma(Math.round(total))}
        </div>
        <button onClick={() => setOpen((o) => !o)} style={{ fontSize: 10, color: "var(--brand)", background: "rgba(255,57,0,0.08)", border: "1px solid rgba(255,57,0,0.2)", borderRadius: 5, padding: "2px 7px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
          {open ? "close ×" : "breakdown"}
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7 }}>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>failed requests</div>
        {delta !== null && (
          <div className="gw-mono" style={{ fontSize: 11, color: delta <= 0 ? "var(--ok)" : "var(--err)" }}>
            {delta <= 0 ? "↓" : "↑"} {fmtComma(Math.abs(Math.round(delta)))}
          </div>
        )}
      </div>
      {/* Mini stacked bar */}
      <div style={{ height: 3, borderRadius: 999, overflow: "hidden", display: "flex", marginTop: 8 }}>
        {brEntries.length ? (
          brEntries.map(([k, v], i) => (
            <div key={k} style={{ flex: v, background: LAYER_CLR[i % LAYER_CLR.length], opacity: 0.85 }} />
          ))
        ) : (
          <div style={{ flex: 1, background: "var(--bg-2)" }} />
        )}
      </div>
      {/* Breakdown flyout */}
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 20, background: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: "var(--card-radius)", padding: 14, boxShadow: "0 8px 32px rgba(0,0,0,0.45)" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, color: "var(--text-3)", marginBottom: 10 }}>Breakdown</div>
          {brEntries.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>No errors in this window.</div>
          )}
          {brEntries.map(([k, v], i) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: LAYER_CLR[i % LAYER_CLR.length], flexShrink: 0 }} />
              <span style={{ fontSize: 12, flex: 1, color: "var(--text-2)" }}>{k}</span>
              <span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtComma(Math.round(v))}</span>
              <span style={{ fontSize: 10, color: "var(--text-4)", minWidth: 28, textAlign: "right" }}>
                {brTotal > 0 ? Math.round((v / brTotal) * 100) : 0}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── SCU card — quota is not metered on self-hosted (honest state) ──── */
function ScuCard() {
  const [hov, setHov] = useState(false);
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 0 }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 600, color: "var(--text-3)" }}>Compute units</div>
      <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, marginTop: 8 }}>—</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7 }}>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>not metered on self-hosted</div>
      </div>
      <div style={{ height: 3, background: "var(--bg-2)", borderRadius: 999, marginTop: 8, overflow: "visible", position: "relative" }} />
      {hov && (
        <div style={{ marginTop: 8, padding: "5px 8px", borderRadius: 6, background: "rgba(255,255,255,0.04)", border: "1px solid var(--line)", fontSize: 11, color: "var(--text-3)", lineHeight: 1.5 }}>
          Compute-unit metering is a Magma Cloud feature.
        </div>
      )}
    </div>
  );
}

/* ── Chart card wrapper ─────────────────────────────────────────────── */
function ChCard({ title, controls, footer, children }: {
  title: string;
  controls?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
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

/* ── Overview page ──────────────────────────────────────────────────── */
export function OverviewView() {
  const { timeWindow, setTimeWindow } = useFilters();
  const [chainFilter, setChainFilter] = useState("all");
  const [showStack, setShowStack] = useState(false);
  const [latMode, setLatMode] = useState<"overall" | "per-upstream">("overall");
  const [latPct, setLatPct] = useState<"p50" | "p95" | "p99">("p95");

  const specQ = chainFilter !== "all" ? `&spec=${chainFilter}` : "";
  const { data } = useApi<OverviewData>(`/api/metrics/overview?window=${timeWindow}${specQ}`);
  const specsRes = useApi<{ specs: string[] }>("/api/metrics/specs", 60000);

  const chainOptions = useMemo(
    () =>
      (specsRes.data?.specs ?? []).map((spec) => {
        const meta = buildChainMetaByIndex(spec);
        return { spec, name: meta.name, color: meta.color };
      }),
    [specsRes.data],
  );

  /* chart series (live) */
  const throughputVals = nums(data?.throughput);
  const errStacks = [
    {
      name: "errors",
      color: "var(--err)",
      values: nums(data?.errorsSeries),
    },
  ];

  const baselineP95 = 85; // approximate probe-derived baseline (design constant)
  const latBgBands = [
    { lo: 0, hi: baselineP95, fill: "var(--ok)" },
    { lo: baselineP95, hi: baselineP95 * 1.5, fill: "var(--warn)" },
    { lo: baselineP95 * 1.5, hi: 9999, fill: "var(--err)" },
  ];
  const latSeries = [
    {
      values: nums(data?.latencySeries[latPct]),
      color: "var(--info)",
      width: 2,
    },
  ];

  // The prototype's `normalized` StackedArea expects per-bucket PERCENT
  // shares (its mock chain data is percentages) — normalize at the call site.
  const chainLayers = useMemo(() => {
    const raw = (data?.perChainSeries ?? []).map((c) => ({
      name: c.name,
      values: nums(c.points),
      color: CHAIN_CLR[c.name] ?? c.color,
    }));
    const buckets = Math.max(0, ...raw.map((l) => l.values.length));
    const totals = Array.from({ length: buckets }, (_, i) =>
      raw.reduce((s, l) => s + (l.values[i] ?? 0), 0),
    );
    return raw.map((l) => ({
      ...l,
      values: l.values.map((v, i) => (totals[i] ? (v / totals[i]!) * 100 : 0)),
    }));
  }, [data?.perChainSeries]);

  const provLayers = (data?.perUpstreamSeries ?? []).map((p, i) => ({
    name: p.upstream,
    values: nums(p.points),
    color: UPSTREAM_PALETTE[i % UPSTREAM_PALETTE.length]!,
  }));

  const kpiDelta = (value: number | null | undefined, prior: number | null | undefined) =>
    value != null && prior != null ? value - prior : null;

  const srPts = kpiDelta(data?.successRate.value, data?.successRate.prior);
  const rpsDelta = kpiDelta(data?.throughputRps.value, data?.throughputRps.prior);

  const toggleBtn = (label: string, active: boolean, onClick: () => void) => (
    <button onClick={onClick} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 5, border: "1px solid var(--line)", background: active ? "var(--brand)" : "transparent", color: active ? "#fff" : "var(--text-3)", cursor: "pointer", fontFamily: "inherit" }}>
      {label}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "calc(100vh - 56px)", padding: "14px 28px", boxSizing: "border-box", overflow: "hidden" }}>

      {/* ── Shared header ── */}
      <RouterHeader
        chains={chainOptions}
        chainFilter={chainFilter}
        setChainFilter={setChainFilter}
        timeWindow={timeWindow}
        setTimeWindow={setTimeWindow}
      />

      {/* ── KPI strip (5 equal cards) ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, flexShrink: 0 }}>
        <KPICard
          label="Success Rate"
          value={data?.successRate.value != null ? `${(data.successRate.value * 100).toFixed(2)}%` : "—"}
          deltaStr={srPts !== null ? `${srPts > 0 ? "↑ " : "↓ "}${Math.abs(srPts * 100).toFixed(2)} pts` : null}
          deltaGood={srPts !== null ? srPts >= 0 : null}
          sub={`vs prior ${timeWindow}`}
        />
        <LatencyCard data={data} />
        <ErrorsCard data={data} />
        <KPICard
          label="RPC Traffic"
          value={data?.throughputRps.value != null ? `${fmtComma(Math.round(data.throughputRps.value))} req/s` : "—"}
          deltaStr={rpsDelta !== null ? `${rpsDelta > 0 ? "↑ " : "↓ "}${fmtComma(Math.abs(Math.round(rpsDelta)))} req/s` : null}
          deltaGood={null}
          sub="current throughput"
          spark={throughputVals}
        />
        <ScuCard />
      </div>

      {/* ── 2×2 chart grid ── */}
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 10 }}>

        {/* A — Throughput */}
        <ChCard
          title="Throughput · req/s"
          controls={toggleBtn("Stack by upstream", showStack, () => setShowStack((s) => !s))}
          footer={showStack
            ? <ChartLegend items={provLayers.map((l) => ({ label: l.name, color: l.color, square: true }))} />
            : null}
        >
          {showStack
            ? <StackedAreaChart layers={provLayers} id="tp-stack" />
            : <LineChart series={[{ values: throughputVals, color: "var(--brand)", width: 2 }]} id="tp-line" yFmt={(v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v)))} />
          }
        </ChCard>

        {/* B — Errors */}
        <ChCard
          title="Errors over time"
          controls={<ChartLegend items={errStacks.map((s) => ({ label: s.name, color: s.color, square: true }))} />}
        >
          <ColumnChart stacks={errStacks} highlightSpikes id="err-col" />
        </ChCard>

        {/* C — Latency */}
        <ChCard
          title="Latency · ms"
          controls={
            <div style={{ display: "flex", gap: 6 }}>
              <div className="gw-segctl" style={{ transform: "scale(0.82)", transformOrigin: "right center" }}>
                {(["p50", "p95", "p99"] as const).map((p) => (
                  <button key={p}
                    className={latPct === p && latMode === "overall" ? "on" : ""}
                    onClick={() => { setLatPct(p); setLatMode("overall"); }}
                    style={{ padding: "3px 7px" }}>{p}</button>
                ))}
              </div>
              <div className="gw-segctl" style={{ transform: "scale(0.82)", transformOrigin: "right center" }}>
                {([["overall", "Overall"], ["per-upstream", "Upstreams"]] as const).map(([v, lbl]) => (
                  <button key={v} className={latMode === v ? "on" : ""} onClick={() => setLatMode(v)} style={{ padding: "3px 8px" }}>{lbl}</button>
                ))}
              </div>
            </div>
          }
        >
          {latMode === "overall" ? (
            <LineChart series={latSeries} id="lat-line" bgBands={latBgBands} yFmt={(v) => Math.round(v) + "ms"} />
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-3)" }}>
              Per-upstream latency lives in Metrics → Upstreams.
            </div>
          )}
        </ChCard>

        {/* D — Chain traffic */}
        <ChCard
          title="Requests per chain"
          controls={<button style={{ fontSize: 10, color: "var(--brand)", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit" }}>View all chains →</button>}
          footer={<ChartLegend items={chainLayers.map((l) => ({ label: l.name, color: l.color, square: true }))} />}
        >
          <StackedAreaChart layers={chainLayers} normalized id="chain-area" />
        </ChCard>

      </div>
    </div>
  );
}
