"use client";

/* HotspotRow — one (chain × upstream) error hotspot, collapsed summary +
 * expandable detail. Ported verbatim from the design prototype
 * (page-metrics.jsx HotspotRow). Live differences, kept honest:
 *  - severity derives from the real error-rate (the mock hardcoded `sev`);
 *  - per-hotspot error CODES and latest SAMPLES need labelled error counters
 *    the router doesn't emit yet — those slots keep their chrome and state
 *    the gap instead of inventing codes;
 *  - the trend chart is the real per-pair error series (top rows only). */

import type { ErrorHotspot, MetricWindow } from "@sr/shared";
import { LineChart } from "@/components/gateway/charts";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { roFmtTime } from "@/components/metrics/InteractiveChart";
import { nums, SEV_STYLE, sevForErrRatePct } from "./bits";

export function HotspotRow({ h, open, onToggle, win }: {
  h: ErrorHotspot;
  open: boolean;
  onToggle: () => void;
  win: MetricWindow;
}) {
  const errPct = h.errorRate != null ? h.errorRate * 100 : null;
  const sev = SEV_STYLE[sevForErrRatePct(errPct)];
  const trend = nums(h.trend);
  const chartId = "eh" + (h.spec + h.upstream).replace(/[^a-zA-Z0-9_-]/g, "");
  // X labels from the REAL trend timestamps — the chart's default labels
  // assume a 24h span and lie on every other window.
  const ts = h.trend.filter((p) => p.t).map((p) => new Date(p.t * 1000));
  const tick = (f: number) => ts[Math.round((ts.length - 1) * f)];
  const xLabels =
    ts.length > 1
      ? [0, 0.25, 0.5, 0.75, 1].map((f) => (tick(f) ? roFmtTime(tick(f)!, win) : ""))
      : undefined;

  return (
    <div className="gw-card" style={{ padding: 0, marginBottom: 8, overflow: "hidden", borderColor: open ? sev.ring : "var(--line)" }}>
      {/* summary */}
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 16px", cursor: "pointer", background: open ? sev.bg : "transparent", borderLeft: `3px solid ${sev.c}` }}>
        {/* who */}
        <div style={{ minWidth: 0, flex: "1.3 1 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ChainBadge spec={h.spec} size={16} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>{h.name}</span>
            <span style={{ fontSize: 13, color: "var(--text-3)" }}>·</span>
            <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-2)" }}>{h.upstream}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11.5, color: "var(--text-3)" }}>
            {h.errors.toLocaleString("en-US")} of {h.requests.toLocaleString("en-US")} requests failed
          </div>
        </div>
        {/* rate + count */}
        <div style={{ textAlign: "right", flexShrink: 0, minWidth: 96 }}>
          <div className="gw-mono gw-tnum" style={{ fontSize: 20, fontWeight: 700, lineHeight: 1, color: sev.c }}>{errPct != null ? errPct.toFixed(2) + "%" : "—"}</div>
          <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}><span className="gw-mono gw-tnum">{h.errors.toLocaleString("en-US")}</span> errors</div>
        </div>
        {/* latest */}
        <div style={{ flexShrink: 0, minWidth: 210, borderLeft: "1px solid var(--line)", paddingLeft: 14 }}>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-4)", fontWeight: 600 }}>Latest</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>no samples on this build</span>
          </div>
          <div className="gw-mono" style={{ fontSize: 10.5, color: "var(--text-4)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>&nbsp;</div>
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><polyline points="6 9 12 15 18 9"/></svg>
      </div>

      {/* detail */}
      {open && (
        <div style={{ borderTop: "1px solid var(--line)", padding: "14px 16px", display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 22 }}>
          <div>
            {/* The failure count/rate above counts TRANSPORT failures only
                (timeouts, connection errors, rate limits, HTTP 5xx, cv
                shortfall). Node errors are a SEPARATE class — the upstream
                answered, with a JSON-RPC error — and count as served, so the
                two lists must never be presented as one breakdown. */}
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-3)", fontWeight: 600, marginBottom: 4 }}>What the failures are</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: sev.c, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "var(--text-2)", flex: 1 }}>Transport / routing failures</span>
              <span className="gw-mono gw-tnum" style={{ fontSize: 12, fontWeight: 700 }}>{h.errors.toLocaleString("en-US")}</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-4)", lineHeight: 1.5, marginBottom: 10 }}>
              timeouts, connection/rate-limit errors, HTTP 5xx, cross-validation shortfalls — the count behind the {errPct != null ? errPct.toFixed(2) + "%" : ""} rate above
            </div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-3)", fontWeight: 600, marginBottom: 4 }}>
              Node errors by method <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: "var(--text-4)" }}>— upstream answered with a JSON-RPC error; counted as served, NOT in the failure rate</span>
            </div>
            {h.nodeMethods.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 0" }}>
                {h.nodeMethods.map((m) => (
                  <div key={m.method} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="gw-mono" title={m.method} style={{ fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{m.method}</span>
                    <span className="gw-mono gw-tnum" style={{ fontSize: 11.5, fontWeight: 700 }}>{m.count.toLocaleString("en-US")}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-4)", padding: "6px 0" }}>
                None this window.
              </div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-3)", fontWeight: 600, marginBottom: 8 }}>Errors over time <span style={{ color: "var(--text-4)" }}>· {win}</span></div>
            {trend.length > 1 ? (
              <div style={{ height: 96 }}><LineChart series={[{ values: trend, color: sev.c, width: 2 }]} id={chartId} yFmt={(v) => String(Math.round(v))} gridCount={3} xLabels={xLabels} /></div>
            ) : (
              <div style={{ height: 96, display: "flex", alignItems: "center", fontSize: 12, color: "var(--text-4)" }}>Trend is charted for the top 5 hotspots.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
