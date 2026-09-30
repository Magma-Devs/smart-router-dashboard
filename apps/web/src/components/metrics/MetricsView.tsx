"use client";

/* MetricsView — the Metrics page body, ported verbatim from the design
 * prototype (page-metrics.jsx MetricsPage): RouterHeader, the four tabs
 * (Overview / Upstreams / Errors / Transactions - the Errors tab folds the
 * prototype's error breakdown and our retry breakdown into one, the
 * transaction tab is ours, and the prototype's Traffic tab is gone), and the
 * cross-tab
 * chain-filter banner. Exported standalone so both /metrics and the
 * chrome-less /standalone route can render it. timeWindow AND the chain come
 * from the shared FiltersProvider — the chain narrows every tab here, and the
 * Upstreams page reads the same selection, so filtering on one page and
 * walking to the other keeps it. RouterOverview's "View upstreams →" drill-in
 * sets it too, and a bar on the Upstreams tab's "Errors over time" opens the
 * Errors tab on its own requests. */

import { useState } from "react";
import { buildChainMetaByIndex } from "@sr/shared";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { useChainFilter, useChainOptions, withMutedRows } from "@/hooks/use-chain-options";
import { useRouterFilter } from "@/hooks/use-router-options";
import { PageActions, RouterHeader } from "@/components/gateway/RouterHeader";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { HeroPanel } from "./HeroPanel";
import { CurrentlyUnavailable } from "./CurrentlyUnavailable";
import { RouterOverview } from "./RouterOverview";
import { ErrorsBreakdown, type ErrorsJump } from "./ErrorsBreakdown";
import { TransactionLog } from "./TransactionLog";
import { UpstreamMetricsTab } from "./upstream/UpstreamMetricsTab";

type Tab = "metrics" | "upstreams" | "errors" | "transactions";

export function MetricsView() {
  const { timeWindow, setTimeWindow } = useFilters();
  const { chain, select: selectChain } = useChainFilter();
  const [tab, setTab] = useState<Tab>("metrics");
  const activeChain = chain;
  const setChainFilter = (v: string) => selectChain(v === "all" ? null : v);
  /* A bar clicked on the Upstreams tab: the Errors tab opens on that
     upstream's chain, the upstream, and the bar's stretch of time. Picking a
     tab yourself clears it - "Errors" from the tab bar is the whole window,
     as it always was. */
  const [errorsFocus, setErrorsFocus] = useState<ErrorsJump | null>(null);
  const openErrors = (jump: ErrorsJump) => {
    if (jump.spec) setChainFilter(jump.spec);
    setErrorsFocus(jump);
    setTab("errors");
  };

  /* Config ∪ traffic (see useChainOptions). A configured chain that has served
     nothing is offered but dimmed: every panel here would be empty for it, and
     saying so beats leaving it out of the list. */
  const { routerId, routers, scopeUnavailable, select: selectRouter } = useRouterFilter();
  const activeRouter = routers.find((r) => r.id === routerId) ?? null;
  const { chains: chainRows } = useChainOptions();
  const routedChains = withMutedRows(chainRows, (c) => (c.hasTraffic ? false : "no traffic yet"));
  const chainObj = activeChain
    ? routedChains.find((c) => c.spec === activeChain) ?? {
        spec: activeChain,
        name: buildChainMetaByIndex(activeChain).name,
        color: buildChainMetaByIndex(activeChain).color,
      }
    : null;

  return (
    <div className="gw-page gw-metrics-inter" style={{ paddingBottom: 60 }}>
      {/* The title, and the page's actions beside it: refresh, the window, the logs. */}
      <div className="gw-row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Metrics</h1>
        <PageActions timeWindow={timeWindow} setTimeWindow={setTimeWindow} chainFilter={activeChain ?? "all"} />
      </div>
      <div style={{ marginBottom: 20 }}>
        <RouterHeader chains={routedChains} chainFilter={activeChain ?? "all"} setChainFilter={setChainFilter}
          timeWindow={timeWindow} setTimeWindow={setTimeWindow} withActions={false} />
      </div>
      {/* The tabs outgrow a narrow screen: they scroll sideways rather than
          wrap each label onto two lines. */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--line)", marginBottom: 24, overflowX: "auto", overflowY: "hidden" }}>
        {([["metrics", "Overview"], ["upstreams", "Upstreams"], ["errors", "Errors"], ["transactions", "Transactions"]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} onClick={() => { setTab(k); setErrorsFocus(null); }} style={{
            whiteSpace: "nowrap", flexShrink: 0,
            padding: "8px 20px", border: "none", background: "transparent",
            fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
            color: tab === k ? "var(--text)" : "var(--text-3)",
            borderBottom: tab === k ? "2px solid var(--brand)" : "2px solid transparent",
            marginBottom: -1, transition: "color 0.15s",
          }}>{l}</button>
        ))}
      </div>

      {/* Only when the chain is the whole story — a router selection implies its
          chain and its own banner says so, so two banners would say it twice. */}
      {activeChain && !activeRouter && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, padding: "9px 14px", borderRadius: 9, background: "rgba(255,57,0,0.06)", border: "1px solid rgba(255,57,0,0.22)" }}>
          <ChainBadge spec={activeChain} size={16} />
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>Viewing <strong style={{ color: "var(--text)" }}>{chainObj ? chainObj.name : activeChain}</strong> - clear to see all chains.</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => selectChain(null)} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>Clear filter</button>
        </div>
      )}

      {/* A router selection reaches the upstream roster for certain — those rows
          are keyed per upstream. It reaches the chain-level panels only when the
          collector attaches a per-router target label, because the router
          labels its own series with the chain and never with itself. Saying
          which of the two is happening beats letting the reader assume. */}
      {activeRouter && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, padding: "9px 14px", borderRadius: 9, background: "var(--hover)", border: "1px solid var(--line-2)" }}>
          <ChainBadge spec={activeRouter.spec} size={16} />
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>
            Router <strong className="gw-mono" style={{ color: "var(--text)" }}>{activeRouter.id}</strong>
            {scopeUnavailable
              ? ` - its upstreams and failed attempts are filtered to what it declares, and the rest of the page to ${activeRouter.chainName}, its chain. Panels that aggregate by chain can't go further: no metric says which router served a request, so a second router on ${activeRouter.chainName} would be counted in with it.`
              : " - every panel is scoped to it."}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => selectRouter(null)} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>Clear filter</button>
        </div>
      )}

      {tab === "metrics" && (
        <>
          <HeroPanel tw={timeWindow} spec={activeChain} />
          <CurrentlyUnavailable />
          <RouterOverview chainFilter={activeChain} timeWindow={timeWindow} onChainClick={(ch) => { setChainFilter(ch); setTab("upstreams"); }} />
        </>
      )}
      {tab === "upstreams" && <UpstreamMetricsTab timeWindow={timeWindow} chainFilter={activeChain} onOpenErrors={openErrors} />}
      {tab === "errors" && <ErrorsBreakdown key={errorsFocus ? `${errorsFocus.upstream}|${errorsFocus.from}` : "window"} chainFilter={activeChain} win={timeWindow} focus={errorsFocus} />}
      {tab === "transactions" && <TransactionLog chainFilter={activeChain} win={timeWindow} />}
    </div>
  );
}
