"use client";

/* MetricsView — the Metrics page body, ported verbatim from the design
 * prototype (page-metrics.jsx MetricsPage): RouterHeader, the four tabs
 * (Overview / Upstreams / Errors breakdown / Traffic), and the cross-tab
 * chain-filter banner. Exported standalone so both /metrics and the
 * chrome-less /standalone route can render it. timeWindow comes from the
 * shared FiltersProvider; chainFilter is page-level state that narrows every
 * tab (and is set by RouterOverview's "View upstreams →" drill-in). */

import { useMemo, useState } from "react";
import { buildChainMetaByIndex } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { RouterHeader } from "@/components/gateway/RouterHeader";
import { HeroPanel } from "./HeroPanel";
import { CurrentlyUnavailable } from "./CurrentlyUnavailable";
import { RouterOverview } from "./RouterOverview";
import { TrafficUsage } from "./TrafficUsage";
import { CrossValidation } from "./CrossValidation";
import { WebSocketPanel } from "./WebSocketPanel";
import { MethodBreakdown } from "./MethodBreakdown";
import { ErrorsBreakdown } from "./ErrorsBreakdown";
import { UpstreamMetricsTab } from "./upstream/UpstreamMetricsTab";

type Tab = "metrics" | "upstreams" | "errors" | "traffic";

export function MetricsView() {
  const { timeWindow, setTimeWindow } = useFilters();
  const [chainFilter, setChainFilter] = useState("all");
  const [tab, setTab] = useState<Tab>("metrics");
  const activeChain = chainFilter === "all" ? null : chainFilter;

  const specsRes = useApi<{ specs: string[] }>("/api/metrics/specs", 60000);
  const routedChains = useMemo(
    () =>
      (specsRes.data?.specs ?? []).map((spec) => {
        const meta = buildChainMetaByIndex(spec);
        return { spec, name: meta.name, color: meta.color };
      }),
    [specsRes.data],
  );
  const chainObj = activeChain
    ? routedChains.find((c) => c.spec === activeChain) ?? {
        spec: activeChain,
        name: buildChainMetaByIndex(activeChain).name,
        color: buildChainMetaByIndex(activeChain).color,
      }
    : null;

  return (
    <div className="gw-page gw-metrics-inter" style={{ paddingBottom: 60 }}>
      <div style={{ marginBottom: 20 }}>
        <RouterHeader chains={routedChains} chainFilter={chainFilter} setChainFilter={setChainFilter}
          timeWindow={timeWindow} setTimeWindow={setTimeWindow} />
      </div>
      <div style={{ display: "flex", borderBottom: "1px solid var(--line)", marginBottom: 24 }}>
        {([["metrics", "Overview"], ["upstreams", "Upstreams"], ["errors", "Errors breakdown"], ["traffic", "Traffic"]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: "8px 20px", border: "none", background: "transparent",
            fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
            color: tab === k ? "var(--text)" : "var(--text-3)",
            borderBottom: tab === k ? "2px solid var(--brand)" : "2px solid transparent",
            marginBottom: -1, transition: "color 0.15s",
          }}>{l}</button>
        ))}
      </div>

      {activeChain && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, padding: "9px 14px", borderRadius: 9, background: "rgba(255,57,0,0.06)", border: "1px solid rgba(255,57,0,0.22)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 3, background: chainObj?.color || "var(--brand)", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>Viewing <strong style={{ color: "var(--text)" }}>{chainObj ? chainObj.name : activeChain}</strong> — clear to see all chains.</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => setChainFilter("all")} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>Clear filter</button>
        </div>
      )}

      {tab === "metrics" && (
        <>
          <HeroPanel tw={timeWindow} spec={activeChain} />
          <CurrentlyUnavailable />
          <RouterOverview chainFilter={activeChain} timeWindow={timeWindow} onChainClick={(ch) => { setChainFilter(ch); setTab("upstreams"); }} />
        </>
      )}
      {tab === "traffic" && (
        <>
          <TrafficUsage win={timeWindow} chainFilter={activeChain} />

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12, alignItems: "start", marginBottom: 14 }}>
            <CrossValidation tw={timeWindow} />
            <WebSocketPanel tw={timeWindow} />
          </div>

          <MethodBreakdown win={timeWindow} chainFilter={activeChain} />
        </>
      )}
      {tab === "upstreams" && <UpstreamMetricsTab timeWindow={timeWindow} chainFilter={activeChain} />}
      {tab === "errors" && <ErrorsBreakdown chainFilter={activeChain} win={timeWindow} />}
    </div>
  );
}
