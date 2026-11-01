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

import { buildChainMetaByIndex, WINDOWS, type MetricWindow, type UpstreamDetail } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { fmtNum } from "@/lib/format";
import { uptimeColor } from "@/lib/colors";
import { upstreamMetricColor } from "@/lib/upstream-presentation";
import { UpstreamHealthNotice } from "@/components/metrics/upstream/UpstreamHealthNotice";
import { HEALTH_UNKNOWN_HINT, healthColor, healthLabel } from "@/lib/health";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { PMRoster, upstreamKey, usePMRosterData } from "./PMRoster";
import { PMStat, PMNoVal } from "./PMPanel";
import { PMEmpty } from "./PMEmpty";
import { PMBody } from "./PMBody";
import type { ErrorsJump } from "../ErrorsBreakdown";
import { LinkNotice } from "../LinkNotice";
import type { UpstreamPick } from "@/lib/view-in-url";

export function UpstreamMetricsTab({ timeWindow, chainFilter, selected = null, linked = false, onSelect, onOpenErrors }: {
  timeWindow: MetricWindow;
  chainFilter: string | null;
  /** The upstream in the deep-dive, held in the page's URL (`?upstream=`); null = the first. */
  selected?: UpstreamPick | null;
  /** The pick came from a link: one the roster no longer has is said. */
  linked?: boolean;
  onSelect?: (pick: UpstreamPick) => void;
  /** Where a click on an errors bar goes - the Errors tab, on its requests. */
  onOpenErrors?: (jump: ErrorsJump) => void;
}) {
  const { scopeQ } = useFilters();
  const rosterRes = usePMRosterData(timeWindow, chainFilter);
  const entries = rosterRes.data?.upstreams ?? [];

  const visible = entries;
  // A pick on another chain than the page's is not this view's - for the one
  // render before the page drops it when the chain changes by hand, and while
  // a link's chain is still being applied.
  const applies = !!selected && (!selected.spec || !chainFilter || selected.spec === chainFilter);
  const match = applies
    ? visible.find((e) => e.endpointId === selected.name && (!selected.spec || e.spec === selected.spec))
    : undefined;
  const pm = match ?? visible[0] ?? null;
  const activeName = pm?.endpointId ?? null;
  // Judged on this scope's own roster, never the last one still on screen.
  const settled = !!rosterRes.data && !rosterRes.isLoading && !rosterRes.error;
  const gone = linked && applies && settled && !match ? selected.name : null;
  const pick = (key: string) => {
    const row = visible.find((e) => upstreamKey(e) === key);
    if (row) onSelect?.({ name: row.endpointId, spec: row.spec });
  };

  // The chain is part of the address: the same name on another chain is
  // another upstream, and the api refuses a name alone.
  const detailRes = useApi<UpstreamDetail>(
    pm ? `/api/metrics/upstream-detail?endpointId=${encodeURIComponent(pm.endpointId)}&spec=${encodeURIComponent(pm.spec)}&window=${timeWindow}${scopeQ}` : null,
    15000, { keepPreviousData: false },
  );
  const detail = detailRes.data?.endpointId === pm?.endpointId && detailRes.data?.spec === pm?.spec
    ? detailRes.data : undefined;

  const fmtRps = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : Math.round(n).toString());
  const chainName = pm ? buildChainMetaByIndex(pm.spec).name : "";
  const hasData = !!pm && (pm.requests > 0 || pm.uptime !== null);
  const hasDiagnostics = hasData || (detail?.requests ?? 0) > 0
    || (!!detail?.errorSplit && Object.values(detail.errorSplit).some((n) => n > 0));
  const availPct = pm?.uptime != null ? pm.uptime * 100 : null;
  const errPct = pm?.errorRate != null ? pm.errorRate * 100 : null;
  const p95 = detail?.p95Ms ?? pm?.p95Ms ?? null;
  const availCol = (pct: number | null) => upstreamMetricColor(pm?.health ?? "unknown", uptimeColor(pct));
  /** The design's fixed 1h/24h/7d context boxes; "24h" is the wire alias of "1d". */
  const winMatches = (k: string) => timeWindow === k || (k === "24h" && timeWindow === "1d");

  return (
    <div>
      {gone && (
        <LinkNotice>
          The upstream in this link, <strong className="gw-mono">{gone}</strong>, is no longer in the config.
          {activeName ? <> Showing <strong className="gw-mono">{activeName}</strong> instead.</> : null}
        </LinkNotice>
      )}
      {/* ── roster of every upstream — click a row to drill in below ── */}
      <PMRoster rows={visible} activeKey={pm ? upstreamKey(pm) : null} onSelect={pick} timeWindow={timeWindow} loading={rosterRes.isLoading} refreshing={rosterRes.isValidating} />

      {pm && activeName && (
        <>
          {/* ── selected-upstream deep dive ── */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 14px" }}>
            <ChainBadge spec={pm.spec} size={16} />
            <span style={{ fontSize: 14, fontWeight: 700 }}>{activeName}</span>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>· {chainName} · detailed metrics</span>
          </div>

          <UpstreamHealthNotice health={pm.health} reason={pm.healthReason} />

          {/* ════ ROW 1 — AT A GLANCE ════ */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 12 }}>
            <PMStat label="Status">
              {(() => {
                /* Same three words every other health surface uses
                   (`lib/health.ts`) — this card used to say "Live · up". */
                const c = healthColor(pm.health);
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}
                    title={pm.health === "unknown" ? HEALTH_UNKNOWN_HINT : undefined}>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: c, boxShadow: `0 0 8px ${c}`, flexShrink: 0 }} />
                    <span style={{ fontSize: 20, fontWeight: 700, color: c }}>{healthLabel(pm.health)}</span>
                  </div>
                );
              })()}
              <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>{chainName}</div>
            </PMStat>

            <PMStat label="Request success rate" tip={"**Requests this upstream answered** as a share of all requests routed to it - i.e. **success rate**, not wall-clock uptime or an SLA figure.\n\nIt is measured from real traffic, so it is empty until the router routes something here. The router's own block polls are reported separately below.\n\nThe large figure follows the window above; 1h / 24h / 7d are shown for context."}>
              {hasData && availPct != null ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color: availCol(availPct) }}>{availPct.toFixed(2)}%</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", margin: "7px 0 9px" }}>Historical · last {timeWindow}</div>
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
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>{fmtNum(pm.requests)} req / {timeWindow} · window average</div>
                </>
              ) : <PMNoVal />}
            </PMStat>

            <PMStat label="Latency" tip={"Typical response time for this upstream.\n\nThe large figure is the **median** (≈ the average request); **p95 / p99** are the tail percentiles."}>
              {hasData ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{detail?.p50Ms != null ? Math.round(detail.p50Ms) : "—"}<span style={{ fontSize: 13, color: "var(--text-3)", fontWeight: 500 }}> ms</span></div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8, display: "flex", gap: 12 }}>
                    <span>median · {timeWindow}</span>
                    <span>p95 <span className="gw-mono gw-tnum" style={{ color: "var(--text-2)", fontWeight: 600 }}>{p95 != null ? Math.round(p95) + "ms" : "—"}</span></span>
                    <span>p99 <span className="gw-mono gw-tnum" style={{ color: "var(--text-2)", fontWeight: 600 }}>{detail?.p99Ms != null ? Math.round(detail.p99Ms) + "ms" : "—"}</span></span>
                  </div>
                </>
              ) : <PMNoVal />}
            </PMStat>

            <PMStat label="Error rate" tip="Share of requests to this upstream that **failed before** Smart Router retried or failed over.">
              {hasData ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color: upstreamMetricColor(pm.health, errPct == null ? "var(--text-4)" : errPct < 0.5 ? "var(--ok)" : errPct < 1.5 ? "var(--warn)" : "var(--err)") }}>{errPct != null ? errPct.toFixed(2) + "%" : "—"}</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>Historical · last {timeWindow}</div>
                </>
              ) : <PMNoVal />}
            </PMStat>
          </div>

          {hasDiagnostics ? <PMBody pm={pm} detail={detail} name={activeName} timeWindow={timeWindow} onOpenErrors={onOpenErrors} /> : <PMEmpty pm={pm} name={activeName} chainName={chainName} timeWindow={timeWindow} />}
        </>
      )}
    </div>
  );
}
