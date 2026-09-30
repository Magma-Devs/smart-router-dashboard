"use client";

/* HeroPanel - the Metrics·Overview cards, live from
 * /api/metrics/dashboard-summary. Null Kpi values render "—" in the design's
 * muted colour with an honest sub-line - never an invented number.
 * "Failed requests" is counted from the router's logs
 * (/api/error-requests/count): no metric counts it, so without them it says so. */

import type { FailedRequests, HeroSummary, MetricWindow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { useRouterFilter } from "@/hooks/use-router-options";
import { Tip } from "@/components/gateway/Tip";
import { SkelValue, SkelLine } from "@/components/gateway/Skel";
import { TT } from "@/lib/tooltips";
import { fmtNum } from "@/lib/format";

export function HeroPanel({ tw, spec }: { tw: MetricWindow; spec?: string | null }) {
  const { scopeQ } = useFilters();
  const { routerIdQ } = useRouterFilter();
  const { data, isLoading } = useApi<HeroSummary>(
    `/api/metrics/dashboard-summary?window=${tw}${spec ? `&spec=${encodeURIComponent(spec)}` : ""}${scopeQ}`,
  );

  const sr = data?.successRate.value ?? null;             // ratio 0..1
  const retries = data?.retriesRecovered.value ?? null;   // count (null until family fires)
  const cachePct = data?.cacheOffloadPct.value ?? null;   // ratio 0..1 (null until family fires)
  const reqServed = data?.requestsServed.value ?? null;
  // Once a minute: the count scans the window's logs, and moves slowly. With
  // the served count scoped to a router, the failed count is scoped to it too.
  const failed = useApi<FailedRequests>(
    `/api/error-requests/count?window=${tw}${spec ? `&spec=${encodeURIComponent(spec)}` : ""}${scopeQ ? routerIdQ : ""}`,
    60_000,
  );
  const failedN = failed.data?.available ? failed.data.value : null;
  // "Requests served" counts the requests the router answered; the ones it
  // gave up on aren't in it, so together they are every request.
  const failedPct = failedN != null && reqServed != null && failedN + reqServed > 0 ? failedN / (failedN + reqServed) : null;
  const stale = data?.staleCaught.value ?? null;
  const provCount = data?.upstreamCount ?? 0;

  const headline: {
    label: string;
    value: React.ReactNode;
    color: string;
    sub: React.ReactNode;
    tipKey: string;
  }[] = [
    { label: "Success rate", value: sr != null ? (sr * 100).toFixed(2) + "%" : "—", color: sr != null ? "var(--ok)" : "var(--text-4)",
      sub: <>&nbsp;</>, tipKey: "effectiveSR" },
    { label: "successful retries", value: retries != null ? fmtNum(retries) : "—", color: retries != null ? "var(--ok)" : "var(--text-4)",
      sub: retries != null ? <>recovered on retry - same or another endpoint</> : <>no retries recorded yet</>, tipKey: "successfulRetries" },
    { label: "Cache offload", value: cachePct != null ? <>{Math.round(cachePct * 100)}%</> : "—", color: cachePct != null ? "#38bdf8" : "var(--text-4)",
      sub: cachePct != null ? <>of reads served from cache · {(cachePct * 100).toFixed(0)}% hit rate</> : <>cache not enabled on this build</>, tipKey: "cacheOffload" },
  ];

  const recovered: {
    label: string;
    display: React.ReactNode;
    tipKey: string;
    color: string;
    note: string;
  }[] = [
    { display: reqServed != null ? fmtNum(reqServed) : "—", label: "Requests served", tipKey: "reqServed", color: "var(--text-3)",
      note: "across " + provCount + " upstream" + (provCount === 1 ? "" : "s") },
    { display: failedN != null
        ? <span style={{ color: failedN > 0 ? "var(--err)" : "var(--ok)" }}>{fmtNum(failedN)}</span>
        : "—",
      label: "Failed requests", tipKey: "failedRequests", color: "var(--err)",
      note: failed.error && !failed.data ? "couldn't load the count"
        : failed.data && !failed.data.available
          ? failed.data.reason === "shared-chain" ? "not split per router on a chain several routers serve"
          : failed.data.reason === "unreachable" ? "the router's logs didn't answer in time"
          : "requires the router's logs (LOKI_URL)"
        : failedN === 0 ? "none in this window"
        : failedPct != null ? `${failedPct < 0.00001 ? "under 0.001" : (failedPct * 100).toFixed(failedPct < 0.001 ? 3 : 2)}% of client requests`
        : "router errors returned to clients" },
    { display: stale != null ? fmtNum(stale) : "—", label: "stale responses caught", tipKey: "staleDetected", color: "var(--warn)",
      note: stale === 0 ? "no stale responses - all consistency checks passed" : "consistency check failed - response behind seen head" },
  ];

  return (
    <div style={{ marginBottom: 14 }}>
      {/* headline value props */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 12 }}>
        {headline.map((h) => (
          <div key={h.label} className="gw-card" style={{ padding: "13px 16px" }}>
            <div style={{ display: "inline-flex", alignItems: "center", fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>
              {h.label}<Tip text={TT[h.tipKey]!} />
            </div>
            <div className="gw-tnum" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, color: h.color, marginTop: 7 }}>
              {isLoading ? <SkelValue h={25} w={104} /> : h.value}
            </div>
            {/* The sub-line is a CLAIM about the deployment ("cache not enabled
                on this build"). It must not be made before the answer is in —
                until then it's a ghost, not a sentence. */}
            <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 6, minHeight: "1.5em" }}>
              {isLoading ? <SkelLine w={168} /> : h.sub}
            </div>
          </div>
        ))}
      </div>

      {/* operational counts — each an independent metric in its own card */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
        {recovered.map((s) => (
          <div key={s.label} className="gw-card" style={{ padding: "13px 16px" }}>
            <div style={{ display: "inline-flex", alignItems: "center", fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: s.color, flexShrink: 0, marginRight: 7 }} />
              {s.label}<Tip text={TT[s.tipKey]!} />
            </div>
            <div className="gw-tnum" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, marginTop: 7 }}>
              {isLoading || (s.tipKey === "failedRequests" && failed.isLoading) ? <SkelValue h={25} w={104} /> : s.display}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 6, minHeight: "1.5em" }}>
              {isLoading || (s.tipKey === "failedRequests" && failed.isLoading) ? <SkelLine w={186} /> : s.note}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
