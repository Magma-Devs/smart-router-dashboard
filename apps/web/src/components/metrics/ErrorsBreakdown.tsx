"use client";

/* Errors-breakdown tab — hotspot list + error-types view. Ported verbatim
 * from the design prototype (page-metrics.jsx ErrorsBreakdown +
 * ErrorTypesView). Live data: /api/metrics/errors. The design's error-types
 * catalog (ERROR_CATALOG mock) maps to the `code` pivot, which is EMPTY until
 * the router emits labelled error counters — the view then renders an honest
 * empty state, never the mock's synthetic codes. */

import { useState } from "react";
import type { ErrorPivotRow, ErrorsReport, MetricWindow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { fmtComma } from "@/lib/format";
import { errorDocsUrl } from "@/lib/error-docs";
import { HotspotRow } from "./HotspotRow";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { useRouterFilter } from "@/hooks/use-router-options";
import { Skel, SkelLine } from "@/components/gateway/Skel";

/* "Error types" reference view — live counts per error code (code pivot). */
function ErrorTypesView({ rows, loading }: { rows: ErrorPivotRow[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="gw-card" style={{ display: "grid", gap: 14 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Skel w={132} h={11} />
            <Skel w="100%" h={8} style={{ flex: 1 }} />
            <Skel w={54} h={11} />
          </div>
        ))}
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="gw-card" style={{ padding: "40px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13, color: "var(--text-3)" }}>No errors this window.</span>
        <span style={{ fontSize: 12, color: "var(--text-4)", maxWidth: 460, lineHeight: 1.6 }}>
          Error classes (node / protocol / transport) appear here as soon as any request fails.
        </span>
      </div>
    );
  }
  const grand = rows.reduce((s, r) => s + r.errors, 0) || 1;
  return (
    <div className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
      {/* These counts come from the router's classified error counter, which
          counts EVERY error event — including the upstream replies that the
          relay went on to serve. The headline above counts failed relays only,
          so the two legitimately differ; saying so beats leaving the reader to
          reconcile them. */}
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", fontSize: 11, color: "var(--text-3)", lineHeight: 1.5 }}>
        Every error event the router classified — including upstream replies it
        recovered from, which is why this can exceed the failed-relay count above.
      </div>
      {rows.map((e, idx) => {
        const muted = e.errors === 0;
        return (
          <div key={e.key} style={{ borderBottom: idx === rows.length - 1 ? "none" : "1px solid var(--line)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", opacity: muted ? 0.5 : 1 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--text-3)", flexShrink: 0 }} />
              <div style={{ flex: 1.4, minWidth: 0 }}>
                {/* The code is a name the reader has to look up, so it IS
                    the link — to the layer table that defines it, not to the
                    top of the reference. */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <a
                    className="gw-mono"
                    href={errorDocsUrl(e.label)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`What ${e.label} means, and whether the router retries it — opens the error-codes reference`}
                    style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "underline dotted", textDecorationColor: "var(--text-4)", textUnderlineOffset: 3 }}
                  >
                    {e.label}
                  </a>
                </div>
              </div>
              <div style={{ flexShrink: 0, minWidth: 150, textAlign: "right" }}>
                {muted
                  ? <span style={{ fontSize: 11, color: "var(--text-4)" }}>none this window</span>
                  : <>
                      <span className="gw-mono gw-tnum" style={{ fontSize: 14, fontWeight: 700 }}>{fmtComma(e.errors)}</span>
                      <div style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 3 }}>{e.share != null ? (e.share * 100).toFixed(1) + "% of errors" : ""}</div>
                    </>}
              </div>
              <div style={{ width: 84, height: 6, borderRadius: 999, background: "var(--bg-2)", flexShrink: 0 }}>
                <div style={{ width: Math.max(2, Math.round((e.errors / grand) * 100)) + "%", height: "100%", borderRadius: 999, background: "var(--warn)", opacity: 0.85 }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ErrorsBreakdown({ chainFilter, win }: { chainFilter: string | null; win: MetricWindow }) {
  const [view, setView] = useState<"hotspots" | "types">("hotspots");
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);

  const specQ = chainFilter ? `&spec=${encodeURIComponent(chainFilter)}` : "";
  const { scopeQ } = useFilters();
  // The hotspots below are (chain × upstream) pairs, so the router filter CAN
  // narrow them — the api resolves the upstream against the values file. The
  // pivots in the "Error types" view can't be attributed and stay as they are.
  const { routerIdQ } = useRouterFilter();
  const { data, isLoading } = useApi<ErrorsReport>(`/api/metrics/errors?window=${win}${specQ}${routerIdQ}${scopeQ}`);

  /* Failing pairs first by rate, then the node-error-only ones (see
     HotspotRow) — the api already orders them that way; this keeps it after
     the rate re-sort. */
  const all = [...(data?.hotspots ?? [])];
  const failing = all
    .filter((h) => h.errors > 0)
    .sort((a, b) => (b.errorRate ?? -1) - (a.errorRate ?? -1));
  const nodeOnly = all
    .filter((h) => h.errors === 0)
    .sort((a, b) => b.nodeErrors - a.nodeErrors);
  const hotspots = [...failing, ...nodeOnly];
  const total = data?.total ?? 0;
  const keyOf = (h: { spec: string; upstream: string }) => h.spec + "·" + h.upstream;
  // The design auto-opens the first hotspot; `undefined` = untouched state.
  const effectiveOpen = openId === undefined ? (hotspots[0] ? keyOf(hotspots[0]) : null) : openId;

  return (
    <div style={{ paddingTop: 8 }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>Errors</div>
          {/* `total` and the pair counts default to 0, so before the response
              lands this line reads "0 errors this window, across 0 pairs" — a
              clean bill of health we have no basis for. Ghost it. */}
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3, minHeight: 18, display: "flex", alignItems: "center" }}>
            {isLoading ? <SkelLine w={286} h={10} /> : (
              <span>
                <span className="gw-mono gw-tnum" style={{ fontWeight: 700, color: "var(--text)" }}>{fmtComma(total)}</span>{" "}errors this window, across <span className="gw-mono gw-tnum">{failing.length}</span> chain · upstream pair{failing.length === 1 ? "" : "s"}
                {/* Node-error pairs are counted apart: they failed nothing, so
                    folding them into the pair count overstated the damage. */}
                {nodeOnly.length > 0 && (
                  <> · <span className="gw-mono gw-tnum">{nodeOnly.length}</span> more answered with node errors only</>
                )}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="gw-segctl">
            <button className={view === "hotspots" ? "on" : ""} onClick={() => setView("hotspots")} style={{ padding: "5px 12px" }}>Hotspots</button>
            <button className={view === "types" ? "on" : ""} onClick={() => setView("types")} style={{ padding: "5px 12px" }}>Error types</button>
          </div>
        </div>
      </div>

      {view === "hotspots" && (
        <>
          {/* The green tick is an ALL-CLEAR. Showing it on an empty `hotspots`
              before the response arrives tells the operator the deployment is
              fine at exactly the moment we don't know. Ghost cards first. */}
          {isLoading ? (
            [0, 1, 2].map((i) => (
              <div key={i} className="gw-card" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, padding: "16px 18px" }}>
                <Skel w={16} h={16} r={4} />
                <Skel w={150} h={11} />
                <Skel w={92} h={11} />
                <span style={{ flex: 1 }} />
                <Skel w={64} h={11} />
                <Skel w={48} h={11} />
              </div>
            ))
          ) : hotspots.length === 0 ? (
            <div className="gw-card" style={{ padding: "40px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span style={{ fontSize: 13, color: "var(--text-3)" }}>No errors on this chain in the selected window.</span>
            </div>
          ) : hotspots.map((h) => (
            <HotspotRow key={keyOf(h)} h={h} win={win} open={effectiveOpen === keyOf(h)} onToggle={() => setOpenId(effectiveOpen === keyOf(h) ? null : keyOf(h))} />
          ))}
        </>
      )}

      {/* Per-code catalog from smartrouter_errors_total{error_name} when the
          classified family has fired; class/category pivot as the fallback. */}
      {view === "types" && (
        <ErrorTypesView
          rows={(data?.pivots.code?.length ? data.pivots.code : data?.pivots.category) ?? []}
          loading={isLoading}
        />
      )}
    </div>
  );
}
