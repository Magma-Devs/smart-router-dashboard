"use client";

/* UpstreamMetricsTab — the Upstreams tab: roster of every upstream + the
 * selected upstream's at-a-glance cards and deep-dive body. Ported verbatim
 * from the design prototype (page-provider-metrics.jsx ProviderMetricsTab).
 * Live data: /api/metrics/upstreams (roster) + /api/metrics/upstream-detail
 * (fetched when an upstream is selected). Honest-state notes:
 *  - the design derived p50/p99 from p95×0.55/×1.85 — live uses the REAL
 *    histogram quantiles from upstream-detail ("—" while loading);
 *  - the 1h/24h/7d availability mini-boxes only have a live value for the
 *    currently-selected window; the other boxes render "—" (no refetch fan-out);
 *  - the mock's "last probe 12s ago" has no backing metric and is dropped. */

import { useEffect, useState } from "react";
import { buildChainMetaByIndex, WINDOWS, type MetricWindow, type UpstreamDetail } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { fmtNum } from "@/lib/format";
import { uptimeColor } from "@/lib/colors";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { PMRoster, usePMRosterData } from "./PMRoster";
import { PMStat, PMNoVal } from "./PMPanel";
import { PMEmpty } from "./PMEmpty";
import { PMBody } from "./PMBody";

export function UpstreamMetricsTab({ timeWindow, chainFilter }: {
  timeWindow: MetricWindow;
  chainFilter: string | null;
}) {
  const rosterRes = usePMRosterData(timeWindow, chainFilter);
  const entries = rosterRes.data?.upstreams ?? [];

  const [provName, setProvName] = useState<string | null>(null);
  // jump the deep-dive to the first upstream on the filtered chain
  useEffect(() => { setProvName(null); }, [chainFilter]);

  const visible = entries;
  const selValid = visible.some((e) => e.endpointId === provName);
  const activeName = selValid ? provName : (visible[0]?.endpointId ?? null);
  const pm = activeName ? visible.find((e) => e.endpointId === activeName) ?? null : null;

  const detailRes = useApi<UpstreamDetail>(
    activeName ? `/api/metrics/upstream-detail?endpointId=${encodeURIComponent(activeName)}&window=${timeWindow}` : null,
  );
  const detail = detailRes.data;

  const fmtRps = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : Math.round(n).toString());
  const chainName = pm ? buildChainMetaByIndex(pm.spec).name : "";
  const hasData = !!pm && pm.requests > 0;
  const availPct = pm?.uptime != null ? pm.uptime * 100 : null;
  const errPct = pm?.errorRate != null ? pm.errorRate * 100 : null;
  const p95 = detail?.p95Ms ?? pm?.p95Ms ?? null;
  const availCol = uptimeColor;
  /** The design's fixed 1h/24h/7d context boxes; "24h" is the wire alias of "1d". */
  const winMatches = (k: string) => timeWindow === k || (k === "24h" && timeWindow === "1d");

  return (
    <div>
      {/* ── roster of every upstream — click a row to drill in below ── */}
      <PMRoster rows={visible} activeName={activeName} onSelect={setProvName} timeWindow={timeWindow} />

      {pm && activeName && (
        <>
          {/* ── selected-upstream deep dive ── */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 14px" }}>
            <ChainBadge spec={pm.spec} size={16} />
            <span style={{ fontSize: 14, fontWeight: 700 }}>{activeName}</span>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>· {chainName} · detailed metrics</span>
          </div>

          {/* ════ ROW 1 — AT A GLANCE ════ */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 12 }}>
            <PMStat label="Status">
              {(() => {
                const map = { operational: { c: "var(--ok)", t: "Live · up" }, unhealthy: { c: "var(--err)", t: "Down" }, unknown: { c: "var(--text-4)", t: "—" } } as const;
                const s = map[pm.health] || map.operational;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: s.c, boxShadow: `0 0 8px ${s.c}`, flexShrink: 0 }} />
                    <span style={{ fontSize: 20, fontWeight: 700, color: s.c }}>{s.t}</span>
                  </div>
                );
              })()}
              <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>{chainName}</div>
            </PMStat>

            <PMStat label="Availability" tip={"**Successful synthetic probes** as a share of all probes — i.e. **success rate**, not wall-clock uptime or an SLA figure.\n\nThe large figure follows the window above; 1h / 24h / 7d are shown for context."}>
              {hasData && availPct != null ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color: availCol(availPct) }}>{availPct.toFixed(2)}%</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", margin: "7px 0 9px" }}>success rate · {timeWindow}</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {/* Fixed sub-windows from the API (availabilityWindows) —
                        real values regardless of the page window. */}
                    {(
                      [
                        ["1h", "Last 1h", detail?.availabilityWindows?.last1h],
                        ["24h", "Last 24h", detail?.availabilityWindows?.last24h],
                        ["7d", "Last 7d", detail?.availabilityWindows?.last7d],
                      ] as const
                    ).map(([k, lbl, v]) => {
                      const on = winMatches(k);
                      const pct = v != null ? v * 100 : null;
                      return (
                        <div key={k} style={{ flex: 1, padding: "5px 6px", borderRadius: 6, background: on ? "var(--hover)" : "transparent", border: `1px solid ${on ? "var(--line-2)" : "var(--line)"}` }}>
                          <div style={{ fontSize: 9, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{lbl}</div>
                          <div className="gw-mono gw-tnum" style={{ fontSize: 12, fontWeight: 600, marginTop: 2, color: pct != null ? availCol(pct) : "var(--text-4)" }}>{pct != null ? pct.toFixed(2) + "%" : "—"}</div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : <PMNoVal />}
            </PMStat>

            <PMStat label="Throughput">
              {hasData ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{fmtRps(pm.requests / WINDOWS[timeWindow].rangeSeconds)}<span style={{ fontSize: 13, color: "var(--text-3)", fontWeight: 500 }}> req/s</span></div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>{fmtNum(pm.requests)} req / {timeWindow}</div>
                </>
              ) : <PMNoVal />}
            </PMStat>

            <PMStat label="Latency" tip={"Typical response time for this upstream.\n\nThe large figure is the **median** (≈ the average request); **p95 / p99** are the tail percentiles."}>
              {hasData ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{detail?.p50Ms != null ? Math.round(detail.p50Ms) : "—"}<span style={{ fontSize: 13, color: "var(--text-3)", fontWeight: 500 }}> ms</span></div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8, display: "flex", gap: 12 }}>
                    <span>median</span>
                    <span>p95 <span className="gw-mono gw-tnum" style={{ color: "var(--text-2)", fontWeight: 600 }}>{p95 != null ? Math.round(p95) + "ms" : "—"}</span></span>
                    <span>p99 <span className="gw-mono gw-tnum" style={{ color: "var(--text-2)", fontWeight: 600 }}>{detail?.p99Ms != null ? Math.round(detail.p99Ms) + "ms" : "—"}</span></span>
                  </div>
                </>
              ) : <PMNoVal />}
            </PMStat>

            <PMStat label="Error rate" tip="Share of requests to this upstream that **failed before** Smart Router retried or failed over.">
              {hasData ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color: errPct == null ? "var(--text-4)" : errPct < 0.5 ? "var(--ok)" : errPct < 1.5 ? "var(--warn)" : "var(--err)" }}>{errPct != null ? errPct.toFixed(2) + "%" : "—"}</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>of all requests · {timeWindow}</div>
                </>
              ) : <PMNoVal />}
            </PMStat>
          </div>

          {hasData ? <PMBody pm={pm} detail={detail} name={activeName} timeWindow={timeWindow} /> : <PMEmpty name={activeName} chainName={chainName} />}
        </>
      )}
    </div>
  );
}
