"use client";

/* TrafficOverTime — client requests over the window, as one line: every
 * chain together, or one chain once it is picked. The same counter either
 * way, so a chain's line is its part of the all-chains line and the chains
 * add up to it. One line on purpose: a deployment can serve 50 chains, and a
 * stack of 50 is unreadable; the Routers table below splits it by router, and
 * a picked chain's "Provider share" card splits its tries by provider.
 * Live data: /api/metrics/rps, one range read.
 * Honest-state notes:
 *  - the counts are client requests the router answered (the Requests served
 *    card's count): a retried request counts once. */

import { useMemo } from "react";
import { buildChainMetaByIndex, type MetricWindow, type TimeSeries } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { StackedAreaChart } from "@/components/gateway/charts";
import { Tip } from "@/components/gateway/Tip";
import { Skel } from "@/components/gateway/Skel";
import { roFmtTime } from "@/components/metrics/InteractiveChart";
import { fmtDayTime } from "@/lib/datetime";

const COLOR = "#60a5fa";
const HEIGHT = 180;

const fmtRate = (v: number) => `${v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)} req/s`;

export function TrafficOverTime({ timeWindow, spec }: { timeWindow: MetricWindow; spec?: string | null }) {
  const { scopeQ } = useFilters();
  const specQ = spec ? `&spec=${encodeURIComponent(spec)}` : "";
  const { data } = useApi<TimeSeries>(`/api/metrics/rps?window=${timeWindow}${specQ}${scopeQ}`);
  const chain = spec ? buildChainMetaByIndex(spec).name : null;

  const view = useMemo(() => {
    const points = data?.points ?? [];
    const times = points.map((p) => p.t);
    const values = points.map((p) => p.v ?? 0);
    const measured = points.filter((p) => p.v != null).map((p) => p.v!);
    const avg = measured.length ? measured.reduce((a, v) => a + v, 0) / measured.length : null;
    const peak = measured.length ? Math.max(...measured) : null;
    const labels = times.length > 1
      ? [0, 0.25, 0.5, 0.75, 1].map((f) => roFmtTime(new Date(times[Math.round(f * (times.length - 1))]! * 1000), timeWindow))
      : null;
    return { times, values, avg, peak, labels };
  }, [data, timeWindow]);

  return (
    <div className="gw-card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)", flex: 1, display: "inline-flex", alignItems: "center" }}>
          {chain ? `Traffic · ${chain}` : "Traffic"}
          <Tip text={chain
            ? `**Requests per second on ${chain}**, over the window. These are client requests the router answered: a request sent to several providers, or retried, counts once. The chains together add up to the all-chains Traffic chart.\n\nProvider share below shows which providers took the tries.`
            : "**Requests per second on every chain together**, over the window. These are client requests the router answered, the count the Requests served card adds up: a retried request counts once.\n\nThe Routers table below splits it by router."} />
        </div>
        {view.avg != null && view.peak != null && (
          <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-3)" }}>
            <span>Average <b style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{fmtRate(view.avg)}</b></span>
            <span>Peak <b style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{fmtRate(view.peak)}</b></span>
          </div>
        )}
      </div>
      {!data ? (
        <Skel w="100%" h={HEIGHT} r={8} />
      ) : view.peak ? (
        <StackedAreaChart layers={[{ name: chain ?? "All chains", values: view.values, color: COLOR }]}
          height={HEIGHT} xLabels={view.labels} id={`traffic-over-time-${spec ?? "all"}`}
          hover={{ title: (i) => fmtDayTime((view.times[i] ?? 0) * 1000), fmt: fmtRate }} />
      ) : (
        <div style={{ height: HEIGHT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-4)" }}>
          No requests in this window.
        </div>
      )}
    </div>
  );
}
