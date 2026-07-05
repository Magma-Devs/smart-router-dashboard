"use client";

/* MethodBreakdown — method-level table with Read/Write/Batch class tabs.
 * Ported verbatim from the design prototype (page-metrics.jsx
 * MethodBreakdown). Live data: /api/metrics/methods. write/batch counters are
 * absent until the router emits them — those tabs render the design's empty
 * state (with the reason). Per-method p95 is null on this build (the latency
 * histogram has no `method` label) ⇒ "—". The design's sheet hardcoded three
 * fake "recent failure samples"; live there is no per-method sample source,
 * so that section states the gap instead. */

import { useState } from "react";
import type { MethodClassTotals, MethodUsage, MetricWindow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ThCol } from "@/components/gateway/SortTable";
import { SideSheet, SheetStat } from "@/components/gateway/SideSheet";
import { fmtNum } from "@/lib/format";
import { labelStyle } from "@/lib/styles";

const CLS = ["all", "reads", "writes", "batch"] as const;
type Cls = (typeof CLS)[number];
const CLS_TO_CLASS: Record<Exclude<Cls, "all">, MethodUsage["class"]> = { reads: "read", writes: "write", batch: "batch" };

export function MethodBreakdown({ win, chainFilter }: { win: MetricWindow; chainFilter: string | null }) {
  const PER_PAGE = 10;
  const pagerBtn = (disabled: boolean): React.CSSProperties => ({ padding: "4px 12px", fontSize: 11.5, fontFamily: "inherit", borderRadius: 7, border: "1px solid var(--line)", background: "var(--bg-2)", color: disabled ? "var(--text-4)" : "var(--text-2)", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 });
  const [cls, setCls] = useState<Cls>("all");
  const [sheet, setSheet] = useState<MethodUsage | null>(null);
  const [page, setPage] = useState(0);

  const specQ = chainFilter ? `&spec=${encodeURIComponent(chainFilter)}` : "";
  const { data } = useApi<{ methods: MethodUsage[]; classTotals: MethodClassTotals }>(`/api/metrics/methods?window=${win}${specQ}`);

  const rows = [...(data?.methods ?? [])]
    .filter((m) => cls === "all" || m.class === CLS_TO_CLASS[cls])
    .sort((a, b) => (b.errorRate ?? -1) - (a.errorRate ?? -1));
  const pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(curPage * PER_PAGE, (curPage + 1) * PER_PAGE);

  const emptyMsg =
    cls === "writes" && data && !data.classTotals.emitted.write
      ? "Write counters (requests_write_total) are not emitted by this router build yet."
      : cls === "batch" && data && !data.classTotals.emitted.batch
        ? "Batch counters (requests_batch_total) are not emitted by this router build yet."
        : `No ${cls === "all" ? "" : cls + " "}methods recorded this window.`;

  const errPct = (m: MethodUsage) => (m.errorRate != null ? m.errorRate * 100 : null);

  return (
    <>
      <div className="gw-card" style={{ padding: 0, overflow: "hidden", marginBottom: 14 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>Method-level breakdown</div>
          <div className="gw-segctl">
            {CLS.map((c) => (
              <button key={c} className={cls === c ? "on" : ""} onClick={() => { setCls(c); setPage(0); }} style={{ padding: "4px 8px", fontSize: 11, textTransform: "capitalize" }}>{c}</button>
            ))}
          </div>
        </div>
        <table className="gw-table">
          <thead>
            <tr>
              <ThCol>Method</ThCol><ThCol>Class</ThCol>
              <ThCol align="right">Requests</ThCol>
              <ThCol align="right">P95</ThCol>
              <ThCol align="right">Error rate</ThCol>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((m) => {
              const ep = errPct(m);
              return (
                <tr key={m.method} style={{ cursor: "pointer" }} onClick={() => setSheet(m)}>
                  <td><span className="gw-mono" style={{ fontSize: 12 }}>{m.method}</span></td>
                  <td><span className="gw-tag" style={{ fontSize: 10 }}>{m.class}</span></td>
                  <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtNum(m.requests)}</span></td>
                  <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{m.p95Ms != null ? Math.round(m.p95Ms) + " ms" : "—"}</span></td>
                  <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: ep == null ? "var(--text-4)" : ep > 0.5 ? "var(--err)" : ep > 0.1 ? "var(--warn)" : "var(--text-3)" }}>{ep != null ? ep.toFixed(2) + "%" : "—"}</span></td>
                </tr>
              );
            })}
            {data && rows.length === 0 && (
              <tr><td colSpan={5} style={{ padding: "20px 12px", textAlign: "center", color: "var(--text-4)", fontSize: 12.5 }}>{emptyMsg}</td></tr>
            )}
          </tbody>
        </table>
        {pageCount > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 16px", borderTop: "1px solid var(--line)" }}>
            <span style={{ fontSize: 11.5, color: "var(--text-4)" }}>
              {curPage * PER_PAGE + 1}–{Math.min((curPage + 1) * PER_PAGE, rows.length)} of {rows.length} methods
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setPage(Math.max(0, curPage - 1))} disabled={curPage === 0} style={pagerBtn(curPage === 0)}>Prev</button>
              <span style={{ fontSize: 11.5, color: "var(--text-3)", alignSelf: "center", minWidth: 54, textAlign: "center" }}>Page {curPage + 1} / {pageCount}</span>
              <button onClick={() => setPage(Math.min(pageCount - 1, curPage + 1))} disabled={curPage === pageCount - 1} style={pagerBtn(curPage === pageCount - 1)}>Next</button>
            </div>
          </div>
        )}
      </div>

      {sheet && (
        <SideSheet
          open
          onClose={() => setSheet(null)}
          title={<span style={{ fontFamily: "var(--font-mono)" }}>{sheet.method}</span>}
          sub={sheet.class}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
            <SheetStat label="Request count" value={fmtNum(sheet.requests)} />
            <SheetStat label="P95 latency" value={sheet.p95Ms != null ? Math.round(sheet.p95Ms) + " ms" : "—"} />
            <SheetStat label="Error rate" value={errPct(sheet) != null ? errPct(sheet)!.toFixed(2) + "%" : "—"} color={errPct(sheet) == null ? undefined : errPct(sheet)! > 0.5 ? "var(--err)" : errPct(sheet)! > 0.1 ? "var(--warn)" : "var(--ok)"} />
          </div>
          <div>
            <div style={labelStyle}>Recent failure samples</div>
            <div style={{ fontSize: 12, color: "var(--text-4)", padding: "8px 0" }}>
              No per-method failure samples on this build — an error log with method labels is needed first.
            </div>
          </div>
        </SideSheet>
      )}
    </>
  );
}
