"use client";

/* Dashboard page — thin tab shell, port of the design prototype's
   DashboardPage (SR_Dashboard/magma/page-dashboard.jsx ~1833-1868).
   Local `win` chip state uses the design's 1h/3h/24h/7d/Custom vocabulary;
   chips map to API windows {1h→1h, 3h→3h, 24h→1d, 7d→7d} and a Custom range
   fetches the nearest catalog window. One /api/metrics/dashboard round-trip
   feeds both tabs; the chains multiselect filters per-chain series
   client-side (per the design). */

import { useMemo, useState } from "react";
import { WINDOWS, type DashboardData, type MetricWindow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { DashHeader } from "@/components/dashboard/DashHeader";
import { OverviewTab } from "@/components/dashboard/OverviewTab";
import { MetricsTab } from "@/components/dashboard/MetricsTab";

/** Design chip → API window (the design says "24h", the API says "1d"). */
const CHIP_TO_API: Record<string, MetricWindow> = {
  "1h": "1h",
  "3h": "3h",
  "24h": "1d",
  "7d": "7d",
};

/** Custom ranges have no server-side start/end — fetch the nearest catalog
 *  window by inclusive day-span (the design's own "nearest bucket" behavior). */
function apiWindowFor(win: string): MetricWindow {
  const direct = CHIP_TO_API[win];
  if (direct) return direct;
  if (win.startsWith("custom:")) {
    const [, s, e] = win.split(":");
    if (!s || !e) return "1d";
    const startMs = new Date(s + "T00:00:00Z").getTime();
    const endMs = new Date(e + "T00:00:00Z").getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "1d";
    const spanSec = Math.max(3600, (endMs - startMs) / 1000 + 86400);
    let best: MetricWindow = "1d";
    let bestDiff = Infinity;
    for (const [k, w] of Object.entries(WINDOWS)) {
      const d = Math.abs(w.rangeSeconds - spanSec);
      if (d < bestDiff) {
        bestDiff = d;
        best = k as MetricWindow;
      }
    }
    return best;
  }
  return "1d";
}

export default function DashboardPage() {
  const [win, setWin] = useState("24h");
  const [chains, setChains] = useState<string[]>([]);
  const [tab, setTab] = useState<"overview" | "metrics">("overview");

  const apiWindow = apiWindowFor(win);
  const { data } = useApi<DashboardData>(`/api/metrics/dashboard?window=${apiWindow}`);

  const chainOptions = useMemo(
    () => (data?.chains ?? []).map((c) => ({ id: c.spec, name: c.name, color: c.color })),
    [data],
  );
  const upstreamOptions = useMemo(
    () => (data?.series.upstreamMix ?? []).map((p) => ({ id: p.upstream, name: p.upstream })),
    [data],
  );

  return (
    <div className="gw-page" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
      <DashHeader
        win={win}
        setWin={setWin}
        chains={chains}
        setChains={setChains}
        chainOptions={chainOptions}
        upstreamOptions={upstreamOptions}
      />

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--line)", padding: "0 24px", background: "var(--bg)", flexShrink: 0 }}>
        {(["overview", "metrics"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "10px 16px", fontSize: 13, fontWeight: tab === t ? 600 : 400,
            border: "none", background: "transparent", cursor: "pointer",
            color: tab === t ? "var(--text)" : "var(--text-3)",
            borderBottom: "2px solid " + (tab === t ? "var(--brand)" : "transparent"),
            marginBottom: -1, fontFamily: "var(--font-ui)", textTransform: "capitalize",
          }}>{t}</button>
        ))}
      </div>

      {/* Content */}
      <div className="fade-in" key={tab}>
        {tab === "overview" && (
          <OverviewTab win={win} data={data} setTab={setTab} chains={chains} setChains={setChains} />
        )}
        {tab === "metrics" && (
          <MetricsTab win={win} apiWindow={apiWindow} data={data} chains={chains} />
        )}
      </div>
    </div>
  );
}
