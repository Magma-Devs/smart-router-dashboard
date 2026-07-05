"use client";

/* MetricsTabSectionC — "C · Root cause", port of the design prototype's
   DSHMetrics section C (SR_Dashboard/magma/page-dashboard.jsx ~1673-1827).
   Trouble pairs stay empty until labelled error counters exist (design's ✓
   empty state); the provider scorecard is null-gated; the method-level table
   reads the REAL /api/metrics/methods endpoint (calls + error rate live,
   p95/baseline honest "—" — the histogram has no method label). */

import { useMemo, useState } from "react";
import {
  buildChainMetaByIndex,
  type DashboardData,
  type DashboardTroubleRow,
  type MethodClassTotals,
  type MethodUsage,
  type MetricWindow,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { TroubleDetail } from "./TroubleDetail";
import { DSHChip, DSHNoData, DSHSection, dshFmtComma, dshFmtNum } from "./bits";

/** Method-class chips — the design's vocabulary mapped onto the REAL
 *  read/write/batch/unknown classes the router emits. */
const METHOD_CLASSES: [string, MethodUsage["class"] | null][] = [
  ["All", null],
  ["reads", "read"],
  ["writes", "write"],
  ["batch", "batch"],
  ["Uncategorized", "unknown"],
];

export function MetricsTabSectionC({
  win,
  apiWindow,
  data,
}: {
  win: string;
  apiWindow: MetricWindow;
  data: DashboardData | undefined;
}) {
  const [trSort, setTrSort] = useState<{ col: string; dir: number }>({ col: "failoverPct", dir: -1 });
  const [trExp, setTrExp] = useState<DashboardTroubleRow | null>(null);
  const [scSort, setScSort] = useState<{ col: string; dir: number }>({ col: "qos", dir: -1 });
  const [mCls, setMCls] = useState("All");
  const [sortBy, setSort] = useState("errRate");

  const sortTr = (col: string) => setTrSort((prev) => ({ col, dir: prev.col === col ? -prev.dir : -1 }));
  const sortSc = (col: string) => setScSort((prev) => ({ col, dir: prev.col === col ? -prev.dir : -1 }));

  const sortedTrouble = useMemo(() => {
    const rows = data?.trouble ?? [];
    return rows.slice().sort((a, b) => {
      const av = Number((a as unknown as Record<string, unknown>)[trSort.col]) || 0;
      const bv = Number((b as unknown as Record<string, unknown>)[trSort.col]) || 0;
      return trSort.dir * (bv - av);
    });
  }, [data, trSort]);

  const sortedScorecard = useMemo(() => {
    const rows = data?.scorecard ?? [];
    return rows.slice().sort((a, b) => {
      const av = Number((a as unknown as Record<string, unknown>)[scSort.col]) || 0;
      const bv = Number((b as unknown as Record<string, unknown>)[scSort.col]) || 0;
      return scSort.dir * (bv - av);
    });
  }, [data, scSort]);

  /* Method-level table — live rows from the methods endpoint. */
  const methodsRes = useApi<{ methods: MethodUsage[]; classTotals: MethodClassTotals }>(
    `/api/metrics/methods?window=${apiWindow}`,
    60000,
  );
  const methods = useMemo(() => {
    const rows = methodsRes.data?.methods ?? [];
    return rows.slice().sort((a, b) =>
      sortBy === "errRate" ? (b.errorRate ?? 0) - (a.errorRate ?? 0) : b.requests - a.requests,
    );
  }, [methodsRes.data, sortBy]);
  const clsFilter = METHOD_CLASSES.find(([label]) => label === mCls)?.[1] ?? null;
  const visibleMethods = methods.filter((m) => clsFilter === null || m.class === clsFilter);
  const uncatCount = methods.filter((m) => m.class === "unknown").length;

  const ratioColor = (r: number | null) =>
    r == null ? "var(--text-4)" : r < 1 ? "var(--ok)" : r < 1.5 ? "var(--warn)" : "var(--err)";

  return (
    <section>
      <DSHSection letter="C" title="Root cause" />
      {trExp && <TroubleDetail item={trExp} win={win} onClose={() => setTrExp(null)} />}
      {/* §17 Troublesome (chain, client) pairs */}
      <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>Troublesome (chain, client) pairs</span>
          <span style={{ fontSize: 10, color: "var(--text-4)" }}>failover &gt; 25% · SR &lt; 99% · p95 &gt; 1.5× baseline</span>
        </div>
        {sortedTrouble.length === 0 ? (
          <div style={{ padding: "18px 16px", fontSize: 12, color: "var(--ok)", textAlign: "center" }}>All (chain, client) combinations are within thresholds. ✓</div>
        ) : (
          <table className="gw-table">
            <thead>
              <tr>
                {([["Chain", "chain"], ["Client", "client"], ["Failover %", "failoverPct"], ["SR %", "sr"], ["P95 latency", "p95"], ["Top error", "topErr"], ["Top provider", "topProv"]] as [string, string][]).map((h) => (
                  <th key={h[0]} style={{ cursor: "pointer", textAlign: ["failoverPct", "sr", "p95"].includes(h[1]) ? "right" : undefined }} onClick={() => sortTr(h[1])}>{h[0]}{trSort.col === h[1] ? (trSort.dir > 0 ? " ↑" : " ↓") : ""}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedTrouble.map((t, i) => {
                const ch = buildChainMetaByIndex(t.chain);
                const flags = ((t.failoverPct ?? 0) > 25 ? 1 : 0) + ((t.sr ?? 100) < 99 ? 1 : 0) + ((t.baselineRatio ?? 0) > 1.5 ? 1 : 0);
                const pillC = flags >= 2 ? "var(--err)" : "var(--warn)";
                const rc = t.baselineRatio == null ? "var(--text-4)" : t.baselineRatio < 1 ? "var(--ok)" : t.baselineRatio < 1.5 ? "var(--warn)" : "var(--err)";
                return (
                  <tr key={i} style={{ cursor: "pointer" }} onClick={() => setTrExp(t)}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: pillC, flexShrink: 0 }} />
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: ch.color || "#888", flexShrink: 0 }} />
                        <span style={{ fontSize: 12 }}>{ch.name || t.chain}</span>
                      </div>
                    </td>
                    <td><span style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>{t.client}</span></td>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: (t.failoverPct ?? 0) > 25 ? "var(--warn)" : "var(--text-3)" }} title={t.failoverCount != null ? dshFmtComma(t.failoverCount) + " failover events" : undefined}>{t.failoverPct != null ? t.failoverPct + "%" : "—"}</span></td>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: t.sr == null ? "var(--text-4)" : t.sr < 99 ? "var(--err)" : "var(--ok)" }}>{t.sr != null ? t.sr.toFixed(2) + "%" : "—"}</span></td>
                    <td style={{ textAlign: "right" }}>
                      <span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{t.p95 != null ? t.p95 + " ms " : "— "}</span>
                      <span className="gw-mono" style={{ fontSize: 10, color: rc }}>({t.baselineRatio != null ? t.baselineRatio.toFixed(2) + "×" : "—"})</span>
                    </td>
                    <td>{t.topErr ? <span className="gw-tag gw-tag--warn" style={{ fontSize: 10 }}>{t.topErr}</span> : <span style={{ fontSize: 10, color: "var(--text-4)" }}>—</span>}</td>
                    <td><span style={{ fontSize: 12, color: "var(--text-2)" }}>{t.topProv ?? "—"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* §18 Provider scorecard */}
      <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>Provider scorecard</div>
        {data?.scorecard == null || sortedScorecard.length === 0 ? (
          /* Sync-lag/incident/QoS scorecard families aren't emitted — null-gated. */
          <DSHNoData height={72} />
        ) : (
          <table className="gw-table">
            <thead>
              <tr>
                {([["Provider", "name"], ["Availability", "avail"], ["P95 latency", "p95"], ["Sync lag", "syncLagBlocks"], ["QoS", "qos"], ["Last incident", "incident"]] as [string, string][]).map((h) => (
                  <th key={h[0]} style={{ cursor: "pointer", textAlign: ["avail", "p95", "qos"].includes(h[1]) ? "right" : undefined }} onClick={() => sortSc(h[1])}>{h[0]}{scSort.col === h[1] ? (scSort.dir > 0 ? " ↑" : " ↓") : ""}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedScorecard.map((s) => {
                const ac = s.avail == null ? "var(--text-4)" : s.avail >= 99.9 ? "var(--ok)" : s.avail >= 99 ? "var(--warn)" : "var(--err)";
                const lagC = s.syncLagBlocks == null ? "var(--text-4)" : s.syncLagBlocks <= 1 ? "var(--ok)" : s.syncLagBlocks <= 5 ? "var(--warn)" : "var(--err)";
                return (
                  <tr key={s.name}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: ac, flexShrink: 0 }} />
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{s.name}</div>
                      </div>
                    </td>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: ac }}>{s.avail != null ? s.avail.toFixed(2) + "%" : "—"}</span></td>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{s.p95 != null ? s.p95 + " ms" : "—"}</span></td>
                    <td><span style={{ fontSize: 11, color: lagC }}>{s.syncLagBlocks != null ? (s.syncLagBlocks < 1 ? "< 1 block" : s.syncLagBlocks + " blocks") : "—"}</span></td>
                    <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: s.qos == null ? "var(--text-4)" : s.qos >= 97 ? "var(--ok)" : s.qos >= 90 ? "var(--warn)" : "var(--err)" }}>{s.qos ?? "—"}</span></td>
                    <td><span style={{ fontSize: 11, color: s.incident == null || s.incident === "none" ? "var(--ok)" : "var(--warn)" }}>{s.incident == null || s.incident === "none" ? "None in window" : s.incident}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* §19 Method-level P95 */}
      <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>Method-level P95</span>
          <div style={{ display: "flex", gap: 4, flex: 1 }}>
            {METHOD_CLASSES.map(([cls]) => (
              <button key={cls} onClick={() => setMCls(cls)} style={{
                padding: "2px 7px", borderRadius: 4, border: "none", cursor: "pointer",
                fontSize: 10, fontFamily: "var(--font-ui)", fontWeight: 500,
                background: mCls === cls ? "var(--brand)" : "var(--hover)",
                color: mCls === cls ? "white" : "var(--text-3)",
              }}>{cls}</button>
            ))}
          </div>
          <span style={{ fontSize: 10, color: "var(--text-3)" }}>Sort by</span>
          <DSHChip options={["errRate", "count"]} value={sortBy} onChange={setSort} />
        </div>
        {visibleMethods.length === 0 ? (
          <DSHNoData height={72} note="No method traffic in this window" />
        ) : (
          <table className="gw-table">
            <thead><tr><th>Method</th><th>Class</th><th style={{ textAlign: "right" }}>Calls</th><th style={{ textAlign: "right" }}>P95</th><th style={{ textAlign: "right" }}>vs baseline</th><th style={{ textAlign: "right" }}>Error rate</th></tr></thead>
            <tbody>
              {visibleMethods.map((m, i) => (
                <tr key={i}>
                  <td><span className="gw-mono" style={{ fontSize: 11 }}>{m.method}</span></td>
                  <td><span style={{ fontSize: 10, color: "var(--text-3)" }}>{m.class === "unknown" ? "Uncategorized" : m.class}</span></td>
                  <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 11 }}>{dshFmtNum(m.requests)}</span></td>
                  <td style={{ textAlign: "right" }}>
                    {m.p95Ms != null
                      ? <span className="gw-mono gw-tnum" style={{ fontSize: 11 }}>{Math.round(m.p95Ms)} ms</span>
                      : <span style={{ fontSize: 10, color: "var(--text-4)" }}>—</span>}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {/* Per-method baseline ratio needs a method label on the
                        latency histogram — not on this build. */}
                    <span style={{ fontSize: 10, color: ratioColor(null) }}>—</span>
                  </td>
                  <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 11, color: m.errorRate != null && m.errorRate * 100 > 0.5 ? "var(--err)" : m.errorRate != null && m.errorRate * 100 > 0.1 ? "var(--warn)" : "var(--text-3)" }}>{m.errorRate != null ? (m.errorRate * 100).toFixed(2) + "%" : "—"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {uncatCount > 0 && (
          <div style={{ padding: "8px 16px", fontSize: 10, color: "var(--text-3)", borderTop: "1px solid var(--line)" }}>
            {uncatCount} method(s) Uncategorized — latency shown but not color-thresholded against a baseline.
          </div>
        )}
      </div>
    </section>
  );
}
