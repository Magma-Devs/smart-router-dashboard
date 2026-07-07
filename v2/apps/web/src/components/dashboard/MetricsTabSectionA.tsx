"use client";

/* MetricsTabSectionA — "A · Customer SLO over time", port of the design
   prototype's DSHMetrics section A (SR_Dashboard/magma/page-dashboard.jsx
   ~1307-1525). Per-chain SR / latency / the derived error-rate stack are
   live; per-upstream availability (§11) and per-region latency (§10) are
   null-gated families that render the design's muted "—" state. */

import { useMemo, useState } from "react";
import type { DashboardData } from "@sr/shared";
import { DSHLine, DSHStack, type DSHSeries, type DSHStackLayer } from "./dsh-charts";
import { DSHCard, DSHChip, DSHNoData, DSHSection, meanOf, toNums, toNumsGap, useChartWidth } from "./bits";

/** The design's ghost-compare button (chrome; ghost series need a prior-window
 *  series family the API doesn't expose yet). */
function CompareBtn({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--line)",
      background: on ? "rgba(255,57,0,0.08)" : "transparent",
      color: on ? "var(--brand)" : "var(--text-3)",
      cursor: "pointer", fontFamily: "var(--font-ui)", fontWeight: 500,
    }}>Compare to last week</button>
  );
}

export function MetricsTabSectionA({
  win,
  data,
  chains,
}: {
  win: string;
  data: DashboardData | undefined;
  chains: string[];
}) {
  const [srIsolate, setSrIso] = useState<string | null>(null);
  const [srCompare, setSrCmp] = useState(false);
  const [latPm, setLatPm] = useState("p95");
  const [latIsolate, setLatIso] = useState<string | null>(null);
  const [latCompare, setLatCmp] = useState(false);
  const [errIsolate, setErrIso] = useState<string | null>(null);
  const [provCompare, setProvCmp] = useState(false);
  const [provSort, setProvSort] = useState<{ col: string; dir: number }>({ col: "fail", dir: -1 });
  const [regionP, setRegionP] = useState("p95");
  const [regionIso, setRegionIso] = useState<string | null>(null);

  const sortProv = (col: string) =>
    setProvSort((prev) => ({ col, dir: prev.col === col ? -prev.dir : -1 }));

  const inChainFilter = (spec: string) => chains.length === 0 || chains.includes(spec);

  /* SR per chain — availability ratio × 100. Gap-preserving so a chain with
     no data in a bucket breaks the line rather than dropping to 0. */
  const srChains = useMemo(
    () =>
      (data?.series.perChainSuccessRate ?? [])
        .filter((c) => inChainFilter(c.spec))
        .map((c) => ({ id: c.spec, name: c.name, color: c.color, label: c.name, data: toNumsGap(c.points, 100) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, chains],
  );

  /* Latency per chain for the selected percentile, coloured by the design's
     ratio thresholds against the overall p95 mean of the same window. */
  const latChains = useMemo(() => {
    const src = data?.series.perChainLatency;
    const list = !src ? [] : latPm === "p50" ? src.p50 : latPm === "p99" ? src.p99 : src.p95;
    const refMean = meanOf(toNums(data?.series.latency.p95));
    return list
      .filter((c) => inChainFilter(c.spec))
      .map((c) => {
        // Chart data keeps gaps (null); the mean is over real samples only.
        const d = toNumsGap(c.points).map((v) => (v == null ? null : Math.round(v)));
        const present = d.filter((v): v is number => v != null);
        const mean = meanOf(present) ?? 0;
        const ratio = refMean && refMean > 0 ? mean / refMean : null;
        const color = ratio == null ? c.color : ratio < 1 ? "var(--ok)" : ratio < 1.5 ? "var(--warn)" : "var(--err)";
        return { id: c.spec, name: c.name, data: d, color, label: c.name + " · " + Math.round(mean) + "ms", ratio };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, chains, latPm]);

  /* Error rate by class — labelled classes are a null-gated family; the one
     honest layer is the derived "unclassified" error-rate series. */
  const errStk = useMemo<(DSHStackLayer & { label: string })[]>(() => {
    if (data?.errorClasses) {
      return data.errorClasses.map((c) => ({ label: c.label, color: c.color, data: toNums(c.points, 100) }));
    }
    const d = toNums(data?.series.errorRate, 100);
    return d.length ? [{ label: "unclassified", color: "#94a3b8", data: d }] : [];
  }, [data]);

  const sortedProvAvail = useMemo(() => {
    const rows = data?.upstreamAvailability ?? [];
    return rows.slice().sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[provSort.col];
      const bv = (b as unknown as Record<string, unknown>)[provSort.col];
      return provSort.dir * ((Number(bv) || 0) - (Number(av) || 0));
    });
  }, [data, provSort]);

  const [r_sa1, w_sa1] = useChartWidth();
  const [r_sa2, w_sa2] = useChartWidth();
  const [r_sa3, w_sa3] = useChartWidth();
  const [r_sa4, w_sa4] = useChartWidth();

  const srSeries: DSHSeries[] = srChains.filter((s) => s.data.length > 0);
  const latSeries: DSHSeries[] = latChains.filter((s) => s.data.length > 0);

  return (
    <section>
      <DSHSection letter="A" title="Customer SLO over time" />
      {/* SR per chain ─ full row */}
      <DSHCard title="Success Rate per chain"
        style={{ marginBottom: 14 }}
        controls={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <CompareBtn on={srCompare} onClick={() => setSrCmp(!srCompare)} />
          </div>
        }>
        <div ref={r_sa1}>
          {srSeries.length ? (
            <DSHLine
              series={srSeries}
              width={w_sa1} height={300} win={win}
              yFmt={(v) => v.toFixed(2) + "%"}
              yDomain={[99.0, 100]}
              thresholds={[{ value: 99.9, label: "99.9%", color: "rgba(255,255,255,0.22)" }]}
            />
          ) : (
            <DSHNoData height={300} />
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {srChains.map((c) => {
            const iso = srIsolate === c.id;
            return (
              <button key={c.id} onClick={() => setSrIso(iso ? null : c.id)} style={{
                display: "flex", alignItems: "center", gap: 5, background: "none", border: "none",
                cursor: "pointer", padding: "2px 5px", opacity: srIsolate && !iso ? 0.3 : 1, transition: "opacity 0.15s",
              }}>
                <span style={{ width: 10, height: 3, background: c.color, borderRadius: 2, display: "inline-block" }} />
                <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--font-ui)" }}>{c.name}</span>
              </button>
            );
          })}
          {srIsolate && <button onClick={() => setSrIso(null)} style={{ fontSize: 10, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-ui)", padding: "2px 5px" }}>Show all</button>}
        </div>
      </DSHCard>
      {/* Latency per chain ─ full row */}
      <DSHCard title="Latency per chain"
        style={{ marginBottom: 14 }}
        controls={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <DSHChip options={["p50", "p95", "p99"]} value={latPm} onChange={setLatPm} />
            <div style={{ width: 1, height: 14, background: "var(--line)" }} />
            <CompareBtn on={latCompare} onClick={() => setLatCmp(!latCompare)} />
          </div>
        }>
        <div ref={r_sa3}>
          {latSeries.length ? (
            <DSHLine
              series={latSeries}
              width={w_sa3} height={280} win={win}
              yFmt={(v) => Math.round(v) + " ms"}
            />
          ) : (
            <DSHNoData height={280} />
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {latChains.map((c) => {
            const iso = latIsolate === c.id;
            const ratioStr = c.ratio == null ? "—" : c.ratio < 1 ? "<1×" : c.ratio.toFixed(1) + "×";
            return (
              <button key={c.id} onClick={() => setLatIso(iso ? null : c.id)} style={{
                display: "flex", alignItems: "center", gap: 5, background: "none", border: "none",
                cursor: "pointer", padding: "2px 5px", opacity: latIsolate && !iso ? 0.3 : 1, transition: "opacity 0.15s",
              }}>
                <span style={{ width: 10, height: 3, background: c.color, borderRadius: 2, display: "inline-block" }} />
                <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--font-ui)" }}>{c.name}</span>
                <span style={{ fontSize: 9, color: c.color, fontFamily: "var(--font-mono)" }}>{ratioStr}</span>
              </button>
            );
          })}
          {latIsolate && <button onClick={() => setLatIso(null)} style={{ fontSize: 10, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-ui)", padding: "2px 5px" }}>Show all</button>}
        </div>
      </DSHCard>
      {/* Error rate by class ─ full row */}
      <DSHCard title="Error rate over time" sub="by class" style={{ marginBottom: 14 }}>
        <div ref={r_sa2}>
          {errStk.length ? (
            <DSHStack
              stacks={errStk}
              width={w_sa2} height={260}
              yFmt={(v) => v.toFixed(1) + "%"}
            />
          ) : (
            <DSHNoData height={260} />
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {errStk.slice().reverse().map((s) => {
            const iso = errIsolate === s.label;
            const last = s.data[s.data.length - 1] ?? 0;
            return (
              <button key={s.label} onClick={() => setErrIso(iso ? null : s.label)} style={{
                display: "flex", alignItems: "center", gap: 5, background: "none", border: "none",
                cursor: "pointer", padding: "2px 5px",
                opacity: errIsolate && !iso ? 0.3 : 1, transition: "opacity 0.15s",
              }}>
                <span style={{ width: 10, height: 3, background: s.color, borderRadius: 2, display: "inline-block" }} />
                <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--font-ui)" }}>{s.label}</span>
                <span style={{ fontSize: 9, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{last.toFixed(2)}%</span>
              </button>
            );
          })}
          {errIsolate && <button onClick={() => setErrIso(null)} style={{ fontSize: 10, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-ui)", padding: "2px 5px" }}>Show all</button>}
        </div>
      </DSHCard>
      {/* §11 — Per-upstream availability */}
      <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>Per-upstream availability</span>
          <div style={{ flex: 1 }} />
          <CompareBtn on={provCompare} onClick={() => setProvCmp(!provCompare)} />
        </div>
        {data?.upstreamAvailability == null || sortedProvAvail.length === 0 ? (
          /* Degraded/incident columns need probe families this build doesn't emit. */
          <DSHNoData height={72} />
        ) : (
          <table className="gw-table">
            <thead>
              <tr>
                <th>Upstream</th>
                <th style={{ textAlign: "right", cursor: "pointer" }} onClick={() => sortProv("ok")}>Successful {provSort.col === "ok" ? (provSort.dir > 0 ? "↑" : "↓") : ""}</th>
                <th style={{ textAlign: "right", cursor: "pointer" }} onClick={() => sortProv("deg")}>Degraded {provSort.col === "deg" ? (provSort.dir > 0 ? "↑" : "↓") : ""}</th>
                <th style={{ textAlign: "right", cursor: "pointer" }} onClick={() => sortProv("fail")}>Failed {provSort.col === "fail" ? (provSort.dir > 0 ? "↑" : "↓") : ""}</th>
                <th>Last incident</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {sortedProvAvail.map((p) => {
                const ok = p.ok;
                const dot = ok == null ? "var(--text-4)" : ok >= 99.9 ? "var(--ok)" : ok >= 99 ? "var(--warn)" : "var(--err)";
                return (
                  <tr key={p.name}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, flexShrink: 0 }} />
                        <div><div style={{ fontSize: 12, fontWeight: 500 }}>{p.name}</div><div style={{ fontSize: 10, color: "var(--text-3)" }}>{p.chain ?? "—"}</div></div>
                      </div>
                    </td>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 11, color: dot }}>{ok != null ? ok.toFixed(2) + "%" : "—"}</span></td>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 11, color: "var(--text-3)" }}>{p.deg != null ? p.deg.toFixed(2) + "%" : "—"}</span></td>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 11, color: p.fail != null && p.fail > 0.5 ? "var(--err)" : "var(--text-3)" }}>{p.fail != null ? p.fail.toFixed(2) + "%" : "—"}</span></td>
                    <td><span style={{ fontSize: 11, color: p.incident == null || p.incident === "none" ? "var(--ok)" : "var(--warn)" }}>{p.incident == null || p.incident === "none" ? "None in window" : p.incident}</span></td>
                    <td>
                      {p.internal == null
                        ? <span style={{ fontSize: 10, color: "var(--text-4)" }}>—</span>
                        : <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, fontWeight: 600, background: p.internal ? "rgba(96,165,250,0.12)" : "rgba(251,146,60,0.12)", color: p.internal ? "#60a5fa" : "#fb923c" }}>{p.internal ? "Internal" : "Fallback"}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {/* §10 — Per-region latency */}
      <DSHCard title="Per-region latency" controls={<DSHChip options={["p50", "p95", "p99"]} value={regionP} onChange={setRegionP} />}>
        <div ref={r_sa4}>
          {data?.regions == null || data.regions.length === 0 ? (
            /* No region label on any router series — null-gated. */
            <DSHNoData height={240} />
          ) : (
            <DSHLine
              series={data.regions.map((s) => ({ data: toNums(s.points), color: s.color, label: s.label }))}
              width={w_sa4} height={240} win={win} yFmt={(v) => Math.round(v) + " ms"}
            />
          )}
        </div>
        {data?.regions != null && data.regions.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {data.regions.map((r) => {
              const iso = regionIso === r.id;
              return (
                <button key={r.id} onClick={() => setRegionIso(iso ? null : r.id)} style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", padding: "2px 4px", opacity: regionIso && !iso ? 0.3 : 1, transition: "opacity 0.15s" }}>
                  <span style={{ width: 10, height: 3, background: r.color, borderRadius: 2, display: "inline-block" }} />
                  <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--font-ui)" }}>{r.label}</span>
                </button>
              );
            })}
            {regionIso && <button onClick={() => setRegionIso(null)} style={{ fontSize: 10, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-ui)", padding: "2px 4px" }}>Show all</button>}
          </div>
        )}
      </DSHCard>
    </section>
  );
}
