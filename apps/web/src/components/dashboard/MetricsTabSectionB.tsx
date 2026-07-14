"use client";

/* MetricsTabSectionB — "B · Resilience & operational economics", port of the
   design prototype's DSHMetrics section B (SR_Dashboard/magma/
   page-dashboard.jsx ~1527-1671). Upstream mix is live; failover ratio,
   internal availability, errors-handled interventions, SLO contribution and
   cache are null-gated families that render the design's muted "—" state. */

import { useMemo, useState } from "react";
import type { DashboardData } from "@sr/shared";
import { DSHLine, DSHStack, type DSHStackLayer } from "./dsh-charts";
import { DSHCard, DSHNoData, DSHSection, dshFmtNum, toNums, useChartWidth } from "./bits";
import { SERIES_OTHER, upstreamSlot } from "@/lib/colors";

const EH_DESCS: Record<string, string> = {
  "Failover": "Retried on different upstream after error/timeout; retry succeeded",
  "Hedge wins": "Parallel hedge returned faster than primary",
  "Consistency": "Stale upstream data rejected; fresher upstream responded",
  "Cache checks": "Cache served while revalidating in parallel",
};

export function MetricsTabSectionB({
  win,
  data,
}: {
  win: string;
  data: DashboardData | undefined;
}) {
  const [ehIsolate, setEhIso] = useState<string | null>(null);

  /* Upstream mix as per-bucket % shares (the design's mock is already %;
     the live payload is raw rps → normalise at the call site). Fixed slot per
     upstream NAME (stable across filters/windows), never cycled — a 9th+
     upstream folds into "Other". */
  const provMix = useMemo<(DSHStackLayer & { label: string })[]>(() => {
    const raw = (data?.series.upstreamMix ?? []).map((p) => ({ label: p.upstream, data: toNums(p.points) }));
    const layers = raw.slice(0, 8).map((p) => ({ ...p, color: upstreamSlot(p.label) }));
    const rest = raw.slice(8);
    if (rest.length) {
      const nr = Math.max(...rest.map((l) => l.data.length));
      layers.push({
        label: `Other (${rest.length})`,
        color: SERIES_OTHER,
        data: Array.from({ length: nr }, (_, i) => rest.reduce((s, l) => s + (l.data[i] ?? 0), 0)),
      });
    }
    const n = Math.max(0, ...layers.map((s) => s.data.length));
    const tots = Array.from({ length: n }, (_, i) => layers.reduce((sum, s) => sum + (s.data[i] ?? 0), 0));
    return layers.map((s) => ({
      ...s,
      data: s.data.map((v, i) => Math.round((v / (tots[i] || 1)) * 1000) / 10),
    }));
  }, [data]);

  const ehStk = useMemo<(DSHStackLayer & { label: string })[]>(
    () =>
      (data?.errorsHandledBreakdown ?? []).map((l) => ({
        label: l.label,
        color: l.color,
        data: toNums(l.points),
      })),
    [data],
  );
  const failoverD = toNums(data?.failoverRatio ?? undefined);
  const inAvailD = toNums(data?.internalAvailability ?? undefined);
  const cacheHitData = toNums(data?.cacheHitRate ?? undefined, 100);
  const contrib = data?.contribution ?? null;

  const [r_sb1, w_sb1] = useChartWidth();
  const [r_sb2, w_sb2] = useChartWidth();
  const [r_sb3, w_sb3] = useChartWidth();
  const [r_cache, w_cache] = useChartWidth();

  return (
    <section>
      <DSHSection letter="B" title="Resilience & operational economics" />
      {/* §12 Upstream mix */}
      <DSHCard title="Upstream mix" sub="% of traffic per upstream" style={{ marginBottom: 14 }}>
        <div ref={r_sb1}>
          {provMix.some((s) => s.data.length > 0)
            ? <DSHStack stacks={provMix} width={w_sb1} height={280} yMax={100} yFmt={(v) => v.toFixed(0) + "%"} />
            : <DSHNoData height={280} />}
        </div>
        {/* The design groups Internal vs Paid fallback via upstream metadata
            the router config doesn't classify — a flat legend stays honest. */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {provMix.map((s) => {
            const last = s.data[s.data.length - 1];
            return (
              <span key={s.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 10, height: 3, background: s.color, borderRadius: 2, display: "inline-block" }} />
                <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--font-ui)" }}>{s.label}</span>
                <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-4)" }}>{last != null ? last.toFixed(1) + "%" : "—"}</span>
              </span>
            );
          })}
        </div>
      </DSHCard>
      {/* §13 Failover ratio & internal availability — two measures of very
          different scale, so two stacked panels sharing the time axis, each
          with its own y-scale. Never a dual-axis chart. */}
      <DSHCard title="Failover ratio & internal availability" style={{ marginBottom: 14 }}>
        <div ref={r_sb3}>
          {failoverD.length && inAvailD.length ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                <span style={{ width: 10, height: 2, background: "var(--series-8)", borderRadius: 1, flexShrink: 0 }} />
                <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--font-ui)" }}>Failover ratio</span>
              </div>
              <DSHLine
                series={[{ data: failoverD, color: "var(--series-8)", label: "Failover ratio" }]}
                width={w_sb3} height={150} win={win} yFmt={(v) => v.toFixed(1) + "%"}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 5, margin: "10px 0 2px" }}>
                <span style={{ width: 10, height: 2, background: "var(--series-1)", borderRadius: 1, flexShrink: 0 }} />
                <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--font-ui)" }}>Internal availability</span>
              </div>
              <DSHLine
                series={[{ data: inAvailD, color: "var(--series-1)", label: "Internal availability" }]}
                width={w_sb3} height={150} win={win}
                yDomain={[Math.floor(Math.min(...inAvailD) * 0.996), 100]}
                yFmt={(v) => v.toFixed(2) + "%"}
              />
              <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 10, lineHeight: 1.6, fontStyle: "italic" }}>
                When internal upstreams degrade, failover engages. Together they keep your Success Rate up.
              </div>
            </>
          ) : (
            /* Needs a failover counter family the router doesn't emit. */
            <DSHNoData height={300} />
          )}
        </div>
      </DSHCard>
      {/* §14 Errors Handled breakdown */}
      <DSHCard title="Errors Handled" sub="by intervention category" style={{ marginBottom: 14 }}>
        <div ref={r_sb2}>
          {ehStk.some((s) => s.data.length > 0)
            ? <DSHStack stacks={ehStk} width={w_sb2} height={260} yFmt={dshFmtNum} />
            : <DSHNoData height={260} />}
        </div>
        {ehStk.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {ehStk.slice().reverse().map((s) => {
              const iso = ehIsolate === s.label;
              const tot = ehStk.reduce((sum, st) => sum + st.data.reduce((a, b) => a + b, 0), 0);
              const pct = tot > 0 ? Math.round((s.data.reduce((a, b) => a + b, 0) / tot) * 100) : 0;
              return (
                <button key={s.label} onClick={() => setEhIso(iso ? null : s.label)}
                  title={EH_DESCS[s.label] || s.label}
                  style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", padding: "2px 5px", opacity: ehIsolate && !iso ? 0.3 : 1, transition: "opacity 0.15s" }}>
                  <span style={{ width: 10, height: 3, background: s.color, borderRadius: 2, display: "inline-block" }} />
                  <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--font-ui)" }}>{s.label}</span>
                  <span style={{ fontSize: 9, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{pct}%</span>
                </button>
              );
            })}
            {ehIsolate && <button onClick={() => setEhIso(null)} style={{ fontSize: 10, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-ui)", padding: "2px 5px" }}>Show all</button>}
          </div>
        )}
      </DSHCard>
      {/* §15 Fallback's contribution to SLO — 2 cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "18px 20px" }}>
          <div style={{ fontSize: 10, color: "var(--text-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 14 }}>Fallback&apos;s contribution to your SLO</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-4)", marginBottom: 4 }}>without failover</div>
              <div style={{ fontSize: 28, fontWeight: 400, fontFamily: "var(--font-mono)", color: "var(--text-3)", letterSpacing: "-0.03em" }}>{contrib ? contrib.srWithout + "%" : "—"}</div>
            </div>
            <span style={{ color: "var(--ok)", fontSize: 20, marginBottom: 4 }}>→</span>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-4)", marginBottom: 4 }}>with Smart Router</div>
              <div style={{ fontSize: 28, fontWeight: 400, fontFamily: "var(--font-mono)", color: "var(--text)", letterSpacing: "-0.03em" }}>{contrib ? contrib.srWith + "%" : "—"}</div>
            </div>
          </div>
          <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, marginBottom: 12 }}>
            Failover saved <strong style={{ color: contrib ? "var(--ok)" : "var(--text-4)", fontFamily: "var(--font-mono)" }}>{contrib ? contrib.savedPts + " SR points" : "—"}</strong> this window.
          </div>
        </div>
        <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "18px 20px" }}>
          <div style={{ fontSize: 10, color: "var(--text-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 14 }}>Performance contribution</div>
          <div style={{ fontSize: 42, fontWeight: 400, fontFamily: "var(--font-mono)", color: contrib ? "var(--text)" : "var(--text-4)", marginBottom: 10, letterSpacing: "-0.04em" }}>{contrib ? contrib.perfPct + "%" : "—"}</div>
          <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, marginBottom: 12 }}>
            of requests delivered under P95 threshold <em>because</em> of failover or hedging — primary would have returned them above threshold.
          </div>
        </div>
      </div>
      {/* §16 Cache — hit rate line + latency improvement */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <DSHCard title="Cache hit rate" sub="eligible requests">
          <div ref={r_cache}>
            {cacheHitData.length ? (
              <DSHLine
                series={[{ data: cacheHitData, color: "var(--series-1)", label: "hit rate %" }]}
                width={w_cache} height={180} win={win}
                thresholds={[{ value: 40, label: "40% target", color: "var(--line-2)" }]}
                yFmt={(v) => Math.round(v) + "%"}
              />
            ) : (
              /* cache_total_hits/misses stay absent until the cache fires. */
              <DSHNoData height={180} />
            )}
          </div>
        </DSHCard>
        <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "18px 20px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div style={{ fontSize: 10, color: "var(--text-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Latency improvement</div>
          <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, marginBottom: 18 }}>
            Cache served <strong style={{ fontFamily: "var(--font-mono)", color: "var(--text-4)" }}>—</strong> of eligible requests. Median latency saved from cache is <strong style={{ fontFamily: "var(--font-mono)", color: "var(--text-4)" }}>—</strong> on this build.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[{ label: "With cache", color: "var(--ok)" }, { label: "Without cache", color: "var(--hover)" }].map((row) => (
              <div key={row.label}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ fontSize: 10, color: "var(--text-3)" }}>{row.label}</span>
                  <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-4)" }}>—</span>
                </div>
                <div style={{ height: 7, borderRadius: 999, background: "var(--hover)", overflow: "hidden" }}>
                  <div style={{ width: "0%", height: "100%", background: row.color, borderRadius: 999, opacity: row.color === "var(--ok)" ? 0.85 : 0.3 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
