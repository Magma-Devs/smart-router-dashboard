"use client";

/* PMBody — the selected upstream's data panels (rows 2–4 of the deep dive).
 * Ported verbatim from the design prototype (page-provider-metrics.jsx
 * PMBody + pmBuild); the mock's synthetic series are replaced by
 * /api/metrics/upstream-detail. Honest-state rules:
 *  - volume: `read` is real; write/batch layers appear only once their
 *    counters are emitted (legend chips keep the design chrome);
 *  - node-vs-blockchain error split: the two counters aren't emitted on this
 *    build ⇒ the split rows/bar show "—" (the design's 62/38 was invented);
 *  - disagreement: no per-upstream cross-validation metric ⇒ chrome + gap;
 *  - selection score: REAL (rpc_endpoint_selection_score), 0..1 → 0–100. */

import { useState } from "react";
import type { MetricWindow, UpstreamDetail, UpstreamMetrics, TimePoint } from "@sr/shared";
import { LineChart, StackedAreaChart, type Layer, type Series } from "@/components/gateway/charts";
import { fmtComma } from "@/lib/format";
import { nums } from "../bits";
import { PMPanel } from "./PMPanel";
import { PMRecentErrors } from "./PMErrors";

const pct = (pts: TimePoint[] | null | undefined): number[] => nums(pts).map((v) => v * 100);

export function PMBody({ pm, detail, name, timeWindow }: {
  pm: UpstreamMetrics;
  detail: UpstreamDetail | undefined;
  name: string;
  timeWindow: MetricWindow;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const pid = name.replace(/[^a-zA-Z0-9_-]/g, "");

  /* volume layers — only counters that exist (read is real on this build) */
  const volume: Layer[] = [
    { name: "Read", values: nums(detail?.volume.read), color: "#3b82f6" },
    ...(detail?.volume.write ? [{ name: "Write", values: nums(detail.volume.write), color: "#f97316" }] : []),
    ...(detail?.volume.batch ? [{ name: "Batch", values: nums(detail.volume.batch), color: "#a78bfa" }] : []),
  ];
  const rpsNow = detail?.rpsNow ?? null;
  const fmtAll = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n)));

  /* latency series + legend scalars */
  const latency: Series[] = [
    { values: nums(detail?.latencySeries.p50), color: "#38bdf8", width: 1.5 },
    { values: nums(detail?.latencySeries.p95), color: "#3b82f6", width: 2 },
    { values: nums(detail?.latencySeries.p99), color: "#f97316", width: 1.5 },
  ];
  const latLegend: [string, number | null][] = [
    ["median", detail?.p50Ms ?? null],
    ["p95", detail?.p95Ms ?? pm.p95Ms],
    ["p99", detail?.p99Ms ?? null],
  ];
  const latColors = ["#38bdf8", "#3b82f6", "#f97316"];

  /* Real error split from the API: node (upstream JSON-RPC error replies),
   * protocol, transport (derived relay failures). Whole numbers. */
  const split = detail?.errorSplit ?? null;
  const totalErr = split ? split.node + split.protocol + split.transport : null;
  const splitPct = (n: number) =>
    totalErr && totalErr > 0 ? Math.round((n / totalErr) * 100) : 0;
  const cvStats = detail?.crossValidation ?? null;
  const disagreePct = cvStats?.disagreementRate != null ? cvStats.disagreementRate * 100 : null;

  /* selection score — real 0..1 gauges → the design's 0–100 axis */
  const score: Series[] = [
    ...(detail?.scoreSeries.availability ? [{ values: pct(detail.scoreSeries.availability), color: "#22c55e", width: 1.4, opacity: 0.55 }] : []),
    ...(detail?.scoreSeries.latency ? [{ values: pct(detail.scoreSeries.latency), color: "#3b82f6", width: 1.4, opacity: 0.55 }] : []),
    ...(detail?.scoreSeries.sync ? [{ values: pct(detail.scoreSeries.sync), color: "#38bdf8", width: 1.4, opacity: 0.55 }] : []),
    ...(detail?.scoreSeries.composite ? [{ values: pct(detail.scoreSeries.composite), color: "#a78bfa", width: 2.6 }] : []),
  ];
  const sc = (t: "availability" | "latency" | "sync" | "composite") => {
    const v = detail?.scores[t];
    return v != null ? Math.round(v * 100) : null;
  };
  const scoreLegend: { lbl: string; val: number | null; color: string; raw: string | null; hero?: boolean }[] = [
    { lbl: "Composite QoS", val: sc("composite"), color: "#a78bfa", raw: null, hero: true },
    { lbl: "Availability", val: sc("availability"), color: "#22c55e", raw: sc("availability") != null ? sc("availability") + "% up" : null },
    { lbl: "Latency", val: sc("latency"), color: "#3b82f6", raw: pm.p95Ms != null ? Math.round(pm.p95Ms) + "ms p95" : null },
    { lbl: "Freshness", val: sc("sync"), color: "#38bdf8", raw: detail?.blockLag != null ? detail.blockLag + " blk lag" : null },
  ];

  const chainName = detail?.spec || pm.spec;

  return (
    <>
      {/* ════ ROW 2 — TRAFFIC & SPEED ════ */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12, marginBottom: 12 }}>
        <PMPanel title="Request volume" tip={"Requests per second this upstream served, **split by Read / Write / Batch** (the three mutually-exclusive request types). Read includes archive lookups.\n\nCache hits are excluded — they never reach an upstream."}
          right={<div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11 }}>
              <span style={{ color: "var(--text-3)" }}>All</span>
              <span className="gw-mono gw-tnum" style={{ color: "var(--text)", fontWeight: 700 }}>{rpsNow != null ? fmtAll(rpsNow) : "—"}</span>
              <span style={{ color: "var(--text-4)" }}>rps</span>
            </span>
            {([["Read", "#3b82f6"], ["Write", "#f97316"], ["Batch", "#a78bfa"]] as const).map(([lbl, c]) => (
              <span key={lbl} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: c, flexShrink: 0 }} />
                <span style={{ color: "var(--text-3)" }}>{lbl}</span>
              </span>
            ))}
          </div>}>
          <div style={{ height: 180 }}><StackedAreaChart layers={volume} id={"pmv" + pid} padY={16} /></div>
        </PMPanel>

        <PMPanel title="Latency"
          right={<div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {latLegend.map(([lbl, val], i) => (
              <span key={lbl} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                <span style={{ width: 9, height: 2, background: latColors[i], flexShrink: 0, borderRadius: 1 }} />
                <span style={{ color: "var(--text-3)" }}>{lbl}</span>
                <span className="gw-mono gw-tnum" style={{ color: "var(--text-2)", fontWeight: 600 }}>{val != null ? Math.round(val) + "ms" : "—"}</span>
              </span>
            ))}
          </div>}>
          <div style={{ height: 180 }}><LineChart series={latency} id={"pml" + pid} padY={16} yFmt={(v) => Math.round(v) + "ms"} /></div>
        </PMPanel>
      </div>

      {/* ════ ROW 3 — ERRORS ════ */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12, marginBottom: 12, alignItems: "start" }}>
        <PMPanel title="Errors · node vs transport" tip={"**Node errors** — the upstream answered with a JSON-RPC error object (invalid params, method not found, …). These count as transport SUCCESS on the availability figures.\n\n**Transport / routing** — the relay itself failed: connection refused, timeout, rate-limit, cross-validation shortfall.\n\n**Protocol errors** — protocol-level failures the router attributes to this upstream."}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "2px 0 4px" }}>
            <div>
              <div className="gw-mono gw-tnum" style={{ fontSize: 30, fontWeight: 700, lineHeight: 1, color: totalErr == null ? "var(--text-4)" : totalErr === 0 ? "var(--ok)" : "var(--text)" }}>{totalErr != null ? fmtComma(totalErr) : "—"}</div>
              <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>total errors · {timeWindow}</div>
            </div>
            <div style={{ height: 8, borderRadius: 999, overflow: "hidden", display: "flex", background: "var(--bg-2)" }}>
              {split && totalErr != null && totalErr > 0 && (
                <>
                  <div style={{ width: `${splitPct(split.node)}%`, background: "#f97316" }} />
                  <div style={{ width: `${splitPct(split.protocol)}%`, background: "#a78bfa" }} />
                  <div style={{ width: `${splitPct(split.transport)}%`, background: "#fbbf24" }} />
                </>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(
                [
                  ["Node errors (JSON-RPC)", "#f97316", split?.node ?? null],
                  ["Protocol errors", "#a78bfa", split?.protocol ?? null],
                  ["Transport / routing", "#fbbf24", split?.transport ?? null],
                ] as const
              ).map(([lbl, c, v]) => (
                <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: c, flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, color: "var(--text-2)", flex: 1 }}>{lbl}</span>
                  <span style={{ fontSize: 11, color: "var(--text-4)" }}>{v != null && totalErr ? `${splitPct(v)}%` : ""}</span>
                  <span className="gw-mono gw-tnum" style={{ fontSize: 13, fontWeight: 600, minWidth: 56, textAlign: "right", color: v == null ? "var(--text-4)" : "var(--text)" }}>{v != null ? fmtComma(v) : "—"}</span>
                </div>
              ))}
            </div>
            <div style={{ height: 1, background: "var(--line)" }} />
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-3)", marginBottom: 11 }}>Node errors by method <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: "var(--text-4)" }}>— node_errors_total has no code label, the method split is the real one</span></div>
              {(detail?.nodeErrorsByMethod?.length ?? 0) > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {detail!.nodeErrorsByMethod.map((m) => (
                    <div key={m.method} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="gw-mono" style={{ fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{m.method}</span>
                      <span className="gw-mono gw-tnum" style={{ fontSize: 12, fontWeight: 700 }}>{fmtComma(m.count)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-4)" }}>No node errors this window.</div>
              )}
            </div>
            <button onClick={() => setLogOpen(true)} className="gw-btn gw-btn--ghost" style={{ fontSize: 12, alignSelf: "flex-start", padding: "6px 11px" }}>Recent errors →</button>
          </div>
        </PMPanel>

        <PMPanel title="Disagreement rate" tip={"How often this upstream's responses **conflict with the consensus** of other upstreams on the same cross-validated request (provider agreements vs disagreements)."}
          right={<span className="gw-mono gw-tnum" style={{ fontSize: 18, fontWeight: 700, color: disagreePct == null ? "var(--text-4)" : disagreePct > 0 ? "var(--warn)" : "var(--ok)" }}>{disagreePct != null ? disagreePct.toFixed(2) + "%" : "—"}</span>}>
          {cvStats && (cvStats.agreements > 0 || cvStats.disagreements > 0) ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "8px 0" }}>
              <div style={{ height: 8, borderRadius: 999, overflow: "hidden", display: "flex", background: "var(--bg-2)" }}>
                <div style={{ width: `${(cvStats.agreements / (cvStats.agreements + cvStats.disagreements)) * 100}%`, background: "var(--ok)" }} />
                <div style={{ width: `${(cvStats.disagreements / (cvStats.agreements + cvStats.disagreements)) * 100}%`, background: "var(--warn)" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--ok)", flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, color: "var(--text-2)", flex: 1 }}>Agreed with consensus</span>
                  <span className="gw-mono gw-tnum" style={{ fontSize: 13, fontWeight: 600 }}>{fmtComma(cvStats.agreements)}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--warn)", flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, color: "var(--text-2)", flex: 1 }}>Disagreed</span>
                  <span className="gw-mono gw-tnum" style={{ fontSize: 13, fontWeight: 600, color: cvStats.disagreements > 0 ? "var(--warn)" : "var(--text)" }}>{fmtComma(cvStats.disagreements)}</span>
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-4)", lineHeight: 1.5 }}>Cross-validated rounds this upstream participated in · {timeWindow}</div>
            </div>
          ) : (
            <div style={{ height: 150, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-4)", textAlign: "center", lineHeight: 1.6 }}>
              This upstream hasn&apos;t participated in a cross-validated round this window —<br />rates appear once a cross-validation policy fans a request out to it.
            </div>
          )}
        </PMPanel>
      </div>

      {/* ════ ROW 4 — ROUTING (optional) ════ */}
      <PMPanel full title="Selection score" tip={"Each line is a **0–100 score** (higher = better), **not** a raw measurement — the router converts p95 latency and block lag into scores so they all share one axis.\n\n**Composite QoS** (purple, bold) is the weighted blend the router actually ranks upstreams on. The three faint lines are its inputs: availability, latency, and sync freshness.\n\nThe dashed **admit ≥ 90** line is the cutoff — when Composite QoS drops below it, the router pulls this upstream from rotation until it recovers."}
        right={<div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {scoreLegend.map((it) => (
            <span key={it.lbl} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <span style={{ width: 10, height: it.hero ? 3 : 2, background: it.color, borderRadius: 1, flexShrink: 0, opacity: it.hero ? 1 : 0.7 }} />
              <span style={{ color: it.hero ? "var(--text)" : "var(--text-3)", fontWeight: it.hero ? 600 : 400 }}>{it.lbl}</span>
              <span className="gw-mono gw-tnum" style={{ color: it.hero ? "var(--text)" : "var(--text-2)", fontWeight: 700 }}>{it.val != null ? it.val : "—"}</span>
              {it.raw && <span style={{ color: "var(--text-4)", fontSize: 10 }}>({it.raw})</span>}
            </span>
          ))}
        </div>}>
        {score.length ? (
          <div style={{ height: 180 }}><LineChart series={score} id={"pms" + pid} yDomain={[0, 100]} gridCount={4} yFmt={(v) => String(Math.round(v))} target={{ value: 90, color: "var(--text-4)", label: "admit ≥ 90" }} /></div>
        ) : (
          <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-4)" }}>No selection-score samples for this upstream in this window.</div>
        )}
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-4)", lineHeight: 1.5 }}>
          Scored 0–100, higher is better. Below the dashed <span style={{ color: "var(--text-3)" }}>admit ≥ 90</span> line the router stops sending this upstream traffic until its score recovers.
        </div>
      </PMPanel>

      <PMRecentErrors name={name} chainName={chainName} rows={detail?.recentErrors ?? []} open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}
