"use client";

/* OverviewTab — port of the design prototype's DSHOverview
   (SR_Dashboard/magma/page-dashboard.jsx ~828-1074), wired to the live
   /api/metrics/dashboard payload. Inline styles are verbatim. Null-gated
   families (Errors Handled, SCU quota, error-class breakdowns) render the
   design's own empty states (muted "—"), never synthetic numbers. */

import { useMemo, useState } from "react";
import type { DashboardData } from "@sr/shared";
import { DSHBar, DSHLine, DSHStack, type DSHSeries, type DSHStackLayer } from "./dsh-charts";
import { DSHCard, DSHChip, DSHKpi, DSHLgnd, dshFmtComma, dshFmtNum, meanOf, toNums, useChartWidth } from "./bits";
import { PCTL_CLR, SERIES_OTHER, upstreamSlot } from "@/lib/colors";

export function OverviewTab({
  win,
  data,
  setTab,
  chains,
  setChains,
}: {
  win: string;
  data: DashboardData | undefined;
  setTab: (t: "overview" | "metrics") => void;
  chains: string[];
  setChains: (ids: string[]) => void;
}) {
  const [latMode, setLatMode] = useState("Overall");
  const [hiddenProvs, setHiddenP] = useState<string[]>([]);
  const [latP, setLatP] = useState("p95");
  const [ehOpen, setEhOpen] = useState(false);
  const [stackByProv, setStackByProv] = useState(false);

  const kpis = data?.kpis;
  const srVal = kpis?.successRate.value ?? null;
  const srDelta = srVal != null && kpis?.successRate.prior != null ? (srVal - kpis.successRate.prior) * 100 : null;
  const p95Val = kpis?.p95Ms.value ?? null;
  const p95Delta = p95Val != null && kpis?.p95Ms.prior != null ? p95Val - kpis.p95Ms.prior : null;
  const rpsVal = kpis?.rps.value ?? null;
  const rpsDelta = rpsVal != null && kpis?.rps.prior != null ? rpsVal - kpis.rps.prior : null;

  const thrData = useMemo(() => toNums(data?.series.throughput), [data]);
  const errData = useMemo(() => toNums(data?.series.errors).map((v) => Math.round(v)), [data]);
  const srSpark = useMemo(() => toNums(data?.series.successRate, 100), [data]);
  const rpsSpark = thrData;

  /* Per-upstream throughput stack (real: provider_address label). Fixed slot
     per upstream NAME (stable across filters/windows), never cycled — a 9th+
     upstream folds into "Other". */
  const thrStk = useMemo<(DSHStackLayer & { label: string })[]>(() => {
    const raw = (data?.series.upstreamMix ?? []).map((p) => ({ label: p.upstream, data: toNums(p.points) }));
    const layers = raw.slice(0, 8).map((p) => ({ ...p, color: upstreamSlot(p.label) }));
    const rest = raw.slice(8);
    if (rest.length) {
      const n = Math.max(...rest.map((l) => l.data.length));
      layers.push({
        label: `Other (${rest.length})`,
        color: SERIES_OTHER,
        data: Array.from({ length: n }, (_, i) => rest.reduce((s, l) => s + (l.data[i] ?? 0), 0)),
      });
    }
    return layers;
  }, [data]);

  /* Overall latency series for the selected percentile. */
  const latSeries = useMemo<DSHSeries[]>(() => {
    const src = data?.series.latency;
    if (!src) return [];
    const d = toNums(latP === "p50" ? src.p50 : latP === "p99" ? src.p99 : src.p95);
    // percentile ramp step for the selected percentile (ordinal encoding)
    const c = PCTL_CLR[latP as keyof typeof PCTL_CLR] ?? PCTL_CLR.p95;
    return d.length ? [{ data: d, color: c, label: latP }] : [];
  }, [data, latP]);

  /* Per-upstream p95 vs the overall p95 mean of the SAME window (real data).
     The line keeps its per-NAME slot color — color follows the entity, never
     its value — and the "runs hot" state moves to an icon + label in the
     legend (status is never carried by color alone, never repaints identity).
     Lines cap at the 8 slots: gray is not an identity, so a 9th+ upstream is
     dropped with a visible "+N more" note instead of an ambiguous gray line. */
  const provLatAll = data?.series.perUpstreamLatencyP95 ?? [];
  const provLatSeries = useMemo(() => {
    const refMean = meanOf(toNums(data?.series.latency.p95));
    return provLatAll.slice(0, 8).map((p) => {
      const d = toNums(p.points).map((v) => Math.round(v));
      const mean = meanOf(d);
      const ratio = refMean && refMean > 0 && mean != null ? mean / refMean : null;
      const slow: "warn" | "err" | null = ratio == null || ratio < 1 ? null : ratio < 1.5 ? "warn" : "err";
      return { name: p.upstream, data: d, color: upstreamSlot(p.upstream), label: p.upstream, slow };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const provLatOverflow = Math.max(0, provLatAll.length - 8);

  /* Latency status band: current p95 vs the prior window's p95 (real prior). */
  const latBandStatus = useMemo<"ok" | "warn" | "err" | undefined>(() => {
    if (p95Val == null || kpis?.p95Ms.prior == null || kpis.p95Ms.prior <= 0) return undefined;
    const ratio = p95Val / kpis.p95Ms.prior;
    return ratio < 1 ? "ok" : ratio < 1.5 ? "warn" : "err";
  }, [p95Val, kpis]);

  /* Requests-per-chain stack: top 5 by volume + aggregated "Other", filtered
     by the header's chain multiselect (client-side, per the design). */
  const chainStk = useMemo(() => {
    const all = (data?.series.perChain ?? []).filter(
      (c) => chains.length === 0 || chains.includes(c.spec),
    );
    const rows = all
      .map((c) => ({ id: c.spec, name: c.name, label: c.name, color: c.color, data: toNums(c.points) }))
      .map((c) => ({ ...c, total: c.data.reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total);
    const top = rows.slice(0, 5);
    const rest = rows.slice(5);
    const stacks: (DSHStackLayer & { id: string; name: string; label: string })[] = top.map(
      ({ id, name, label, color, data: d }) => ({ id, name, label, color, data: d }),
    );
    if (rest.length) {
      const n = Math.max(...rest.map((c) => c.data.length));
      const other = Array.from({ length: n }, (_, i) => rest.reduce((s, c) => s + (c.data[i] ?? 0), 0));
      stacks.push({ id: "other", name: "Other", label: "Other (" + rest.length + " chains)", color: SERIES_OTHER, data: other });
    }
    stacks.sort((a, b) => a.data.reduce((s, v) => s + v, 0) - b.data.reduce((s, v) => s + v, 0));
    return stacks;
  }, [data, chains]);

  const [rThr, wThr] = useChartWidth();
  const [rErr, wErr] = useChartWidth();
  const [rLat, wLat] = useChartWidth();
  const [rChn, wChn] = useChartWidth();

  const hasChainData = chainStk.some((s) => s.data.length > 0);

  return (
    <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>

      {/* KPI strip */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <DSHKpi label="Success Rate" value={srVal != null ? (srVal * 100).toFixed(2) + "%" : "—"} delta={srDelta} deltaUnit=" pp" spark={srSpark} sparkColor="var(--ok)"
          onClick={() => setTab("metrics")} />

        <DSHKpi label="P95 Latency" value={p95Val != null ? Math.round(p95Val) + " ms" : "—"} delta={p95Delta} deltaUnit=" ms" inv
          onClick={() => setTab("metrics")}>
          <div style={{ marginTop: 8 }}><DSHChip options={["p50", "p95", "p99"]} value={latP} onChange={setLatP} /></div>
        </DSHKpi>

        <DSHKpi label="Errors Handled" value={kpis?.errorsHandled.value != null ? dshFmtComma(kpis.errorsHandled.value) : "—"} delta={null}
          tooltip="Requests that would have failed without Smart Router and succeeded because of it."
          onClick={() => setTab("metrics")}>
          <button onClick={(e) => { e.stopPropagation(); setEhOpen(!ehOpen); }}
            style={{ fontSize: 10, color: "var(--text-3)", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline", marginTop: 6, display: "block" }}>
            {ehOpen ? "hide breakdown" : "show breakdown"}
          </button>
          {ehOpen && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
              {/* Intervention counters aren't emitted by this build — honest "—". */}
              <span style={{ fontSize: 10, color: "var(--text-4)" }}>—</span>
            </div>
          )}
        </DSHKpi>

        <DSHKpi label="RPC Traffic" value={rpsVal != null ? dshFmtComma(Math.round(rpsVal)) + " req/s" : "—"} delta={rpsDelta} spark={rpsSpark} sparkColor="var(--info)" />

        <DSHKpi label="Compute units" value={data?.scu ? dshFmtNum(data.scu.used) : "—"}>
          <div style={{ fontSize: 10, color: "var(--text-3)", margin: "5px 0 4px" }}>
            {data?.scu
              ? (data.scu.quotaPct <= 100 ? data.scu.quotaPct + "% of monthly quota" : data.scu.quotaPct + "% — over plan")
              : "—"}
          </div>
          <div style={{ height: 4, background: "var(--hover)", borderRadius: 999 }}>
            <div style={{ width: (data?.scu ? Math.min(data.scu.quotaPct, 100) : 0) + "%", height: "100%", borderRadius: 999, background: data?.scu && data.scu.quotaPct >= 100 ? "var(--err)" : data?.scu && data.scu.quotaPct >= 80 ? "var(--warn)" : "var(--ok)", transition: "width 0.5s ease" }} />
          </div>
        </DSHKpi>
      </div>

      {/* 4 charts 2×2 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <DSHCard title="Throughput" sub={rpsVal != null ? dshFmtComma(Math.round(rpsVal)) + " req/s" : "—"}
          controls={
            <button onClick={() => setStackByProv(!stackByProv)} style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--line)",
              background: stackByProv ? "rgba(255,57,0,0.08)" : "transparent",
              color: stackByProv ? "var(--brand)" : "var(--text-3)",
              cursor: "pointer", fontFamily: "var(--font-ui)", fontWeight: 500,
            }}>Stack by upstream</button>
          }>
          <div ref={rThr}>
            {stackByProv
              ? (thrStk.some((s) => s.data.length > 0)
                ? <DSHStack stacks={thrStk} width={wThr} height={200} yFmt={dshFmtNum} />
                : <div style={{ height: 200 }} />)
              : (thrData.length
                ? <DSHLine series={[{ data: thrData, color: "var(--brand)", label: "req/s" }]} width={wThr} height={200} showArea win={win} yFmt={dshFmtNum} />
                : <div style={{ height: 200 }} />)}
          </div>
          {stackByProv && <DSHLgnd items={thrStk.map((s) => ({ label: s.label, color: s.color }))} />}
        </DSHCard>

        <DSHCard title="Total errors" sub="click spike to drill down">
          <div ref={rErr}>
            {data
              ? <DSHBar data={errData} width={wErr} height={200} win={win}
                onClickBar={() => setTab("metrics")} />
              : <div style={{ height: 200 }} />}
          </div>
        </DSHCard>

        <DSHCard title="Latency"
          controls={
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <DSHChip options={["p50", "p95", "p99"]} value={latP} onChange={setLatP} />
              <div style={{ width: 1, height: 14, background: "var(--line)", flexShrink: 0 }} />
              <DSHChip options={["Overall", "Per upstream"]} value={latMode} onChange={setLatMode} />
            </div>
          }>
          <div ref={rLat}>
            <DSHLine
              series={latMode === "Per upstream"
                ? provLatSeries.filter((s) => !hiddenProvs.includes(s.name))
                : latSeries}
              width={wLat} height={240} win={win}
              bgBand={latMode === "Overall" ? latBandStatus : undefined}
              yFmt={(v) => Math.round(v) + " ms"}
              onClick={() => setTab("metrics")}
            />
          </div>
          {latMode === "Per upstream" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {provLatSeries.map((s) => {
                const hidden = hiddenProvs.includes(s.name);
                return (
                  <button key={s.name} onClick={(e) => {
                    e.stopPropagation();
                    setHiddenP(hidden
                      ? hiddenProvs.filter((n) => n !== s.name)
                      : hiddenProvs.concat([s.name]));
                  }} style={{
                    display: "flex", alignItems: "center", gap: 5,
                    background: "none", border: "none", cursor: "pointer", padding: "2px 4px",
                    opacity: hidden ? 0.3 : 1, transition: "opacity 0.15s",
                  }}>
                    <span style={{ width: 10, height: 3, background: s.color, borderRadius: 2, display: "inline-block" }} />
                    <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--font-ui)" }}>{s.name}</span>
                    {s.slow && (
                      <span title={s.slow === "err" ? "p95 well above the overall baseline (≥1.5×)" : "p95 above the overall baseline"}
                        style={{ fontSize: 9, color: s.slow === "err" ? "var(--err)" : "var(--warn)", fontFamily: "var(--font-ui)" }}>
                        ▲ slow
                      </span>
                    )}
                  </button>
                );
              })}
              {provLatOverflow > 0 && (
                <span style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-ui)", padding: "2px 4px" }}>
                  +{provLatOverflow} more — see Metrics → Upstreams
                </span>
              )}
            </div>
          )}
        </DSHCard>

        <DSHCard title="Requests per chain" sub="top 5">
          <div ref={rChn}>
            {hasChainData
              ? <DSHStack stacks={chainStk} width={wChn} height={200} yFmt={dshFmtNum} />
              : <div style={{ height: 200 }} />}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {chainStk.slice().reverse().map((c) => (
              <button key={c.id} onClick={() => { if (c.id === "other") setTab("metrics"); else setChains([c.id]); }}
                style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}>
                <span style={{ width: 10, height: 3, background: c.color, borderRadius: 2, display: "inline-block" }} />
                <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--font-ui)" }}>{c.label}</span>
              </button>
            ))}
            <button onClick={() => setTab("metrics")} style={{ marginLeft: "auto", fontSize: 10, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-ui)", padding: "2px 4px" }}>View all chains →</button>
          </div>
        </DSHCard>
      </div>
    </div>
  );
}
