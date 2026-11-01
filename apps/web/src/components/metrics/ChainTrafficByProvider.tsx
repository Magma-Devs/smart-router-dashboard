"use client";

/* ChainTrafficByProvider — which upstream took one chain's traffic over the
 * window: the Overview's "Requests per chain", cut by upstream instead of by
 * chain. Shown on the Metrics tab once a chain (or a router) is picked.
 * Live data: /api/metrics/upstream-mix, one range read - not the expanded
 * row's chain-series bundle, whose other reads only an open row needs.
 * Honest-state notes:
 *  - the counts are the requests the router SENT: a retried request counts at
 *    every upstream it reached, so the shares are of those, not of clients';
 *  - "Cache" is the relay cache answering with no upstream at all;
 *  - past the five biggest, upstreams are summed into "Other" rather than
 *    drawn as slivers nobody can read. */

import { useMemo, useState } from "react";
import { buildChainMetaByIndex, type MetricWindow, type UpstreamMix } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { ChartLegend, StackedAreaChart, type Layer } from "@/components/gateway/charts";
import { Tip } from "@/components/gateway/Tip";
import { Skel } from "@/components/gateway/Skel";
import { roFmtTime } from "@/components/metrics/InteractiveChart";

/** The Overview's upstream colours, in the same order. */
const PALETTE = ["#60a5fa", "#22c55e", "#f59e0b", "#a78bfa", "#f472b6", "#2dd4bf"];
const OTHER_COLOR = "#64748b";
const CACHE_COLOR = "#94a3b8";
const MAX_UPSTREAMS = 5;
const HEIGHT = 200;

const isCache = (name: string) => name.toLowerCase() === "cached";

export function ChainTrafficByProvider({ spec, timeWindow }: { spec: string; timeWindow: MetricWindow }) {
  const { scopeQ } = useFilters();
  const { data } = useApi<UpstreamMix>(`/api/metrics/upstream-mix?spec=${encodeURIComponent(spec)}&window=${timeWindow}${scopeQ}`);
  const [mode, setMode] = useState<"share" | "rate">("share");
  const chain = buildChainMetaByIndex(spec).name;

  const view = useMemo(() => {
    const mix = data?.upstreams ?? [];
    // One time axis for every upstream; an upstream with no point at a time took nothing then.
    const times = [...new Set(mix.flatMap((u) => u.points.map((p) => p.t)))].sort((a, b) => a - b);
    const aligned = mix.map((u) => {
      const byT = new Map(u.points.map((p) => [p.t, p.v ?? 0]));
      return { name: u.upstream, values: times.map((t) => byT.get(t) ?? 0) };
    });
    const upstreams = aligned.filter((u) => !isCache(u.name));
    const cache = aligned.filter((u) => isCache(u.name));
    const shown = upstreams.slice(0, upstreams.length > MAX_UPSTREAMS + 1 ? MAX_UPSTREAMS : upstreams.length);
    const rest = upstreams.slice(shown.length);
    const sumOf = (rows: typeof aligned) => times.map((_, i) => rows.reduce((a, u) => a + (u.values[i] ?? 0), 0));
    const layers: Layer[] = [
      ...shown.map((u, i) => ({ name: u.name, values: u.values, color: PALETTE[i % PALETTE.length]! })),
      ...(rest.length ? [{ name: `Other (${rest.length})`, values: sumOf(rest), color: OTHER_COLOR }] : []),
      ...(cache.length ? [{ name: "Cache", values: sumOf(cache), color: CACHE_COLOR }] : []),
    ];
    const total = layers.reduce((a, l) => a + l.values.reduce((s, v) => s + v, 0), 0);
    // Shares per point for the "Share" view: every point adds up to 100%.
    const perPoint = times.map((_, i) => layers.reduce((a, l) => a + (l.values[i] ?? 0), 0));
    const shareLayers = layers.map((l) => ({ ...l, values: l.values.map((v, i) => (perPoint[i] ? (v / perPoint[i]!) * 100 : 0)) }));
    const labels = times.length > 1
      ? [0, 0.25, 0.5, 0.75, 1].map((f) => roFmtTime(new Date(times[Math.round(f * (times.length - 1))]! * 1000), timeWindow))
      : null;
    return { layers, shareLayers, total, labels, times };
  }, [data, timeWindow]);

  const pct = (v: number) => (v > 0 && v < 0.1 ? "<0.1" : v.toFixed(1));
  const fmtRate = (v: number) => `${v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)} req/s`;

  return (
    <div className="gw-card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)", flex: 1, display: "inline-flex", alignItems: "center" }}>
          Traffic by provider · {chain}
          <Tip text={`**Which upstream took ${chain}'s traffic**, over the window. These are the requests the router sent to each upstream: a retried request counts at every upstream it reached.\n\n**Cache** is requests the relay cache answered without any upstream.\n\n**Share** shows each upstream's part of every moment; **Requests / sec** shows how much that was.`} />
        </div>
        <div className="gw-segctl">
          {([["share", "Share"], ["rate", "Requests / sec"]] as const).map(([m, label]) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)} style={{ padding: "4px 10px" }}>{label}</button>
          ))}
        </div>
      </div>
      {!data ? (
        <Skel w="100%" h={HEIGHT} r={8} />
      ) : view.total > 0 ? (
        <>
          <StackedAreaChart key={mode} layers={mode === "share" ? view.shareLayers : view.layers} normalized={mode === "share"}
            height={HEIGHT} xLabels={view.labels} id={`mix-${spec}-${mode}`}
            hover={{
              title: (i) => roFmtTime(new Date((view.times[i] ?? 0) * 1000), timeWindow),
              fmt: mode === "share" ? (v) => `${pct(v)}%` : fmtRate,
              total: mode === "rate",
            }} />
          <ChartLegend style={{ marginTop: 8 }}
            items={view.layers.map((l) => ({ label: l.name, color: l.color, square: true }))} />
        </>
      ) : (
        <div style={{ height: HEIGHT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-4)" }}>
          No requests to {chain}&apos;s upstreams in this window.
        </div>
      )}
    </div>
  );
}
